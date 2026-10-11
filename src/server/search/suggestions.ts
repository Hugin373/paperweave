/**
 * Personal search suggestions for the search page: searches drawn from the user's own concepts and collections
 * (instant), and AI ideas from a short profile of their library — gaps close to their work and neighbouring
 * fields whose methods could help. The AI ideas are made in the background (a job) and kept for a few days, or
 * until the library changes noticeably, so the page never waits for them.
 */
import { createHash } from "node:crypto";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { TopicSuggestion, TopicSuggestionsResponse } from "@/lib/types";
import { getAiConfigRow, providerForWorkspace } from "@/server/ai/config";
import { complete } from "@/server/ai/types";
import { db } from "@/server/db/client";
import {
  aiResults,
  collectionPapers,
  collections,
  concepts,
  jobs,
  libraryItems,
  paperConcepts,
  papers,
} from "@/server/db/schema";
import { enqueueJob } from "@/server/jobs/queue";

const KIND = "topic_suggestions";
const FRESH_MS = 3 * 24 * 3600_000;

interface Profile {
  collections: { name: string; description: string; papers: number }[];
  concepts: { name: string; papers: number }[];
  recent: string[];
  total: number;
}

async function libraryProfile(workspaceId: string): Promise<Profile> {
  const [cols, cons, recent, [{ total }]] = await Promise.all([
    db
      .select({ name: collections.name, description: collections.description, papers: count(collectionPapers.paperId) })
      .from(collections)
      .leftJoin(collectionPapers, eq(collectionPapers.collectionId, collections.id))
      .where(eq(collections.workspaceId, workspaceId))
      .groupBy(collections.id)
      .orderBy(desc(count(collectionPapers.paperId)))
      .limit(25),
    db
      .select({ name: concepts.name, papers: count(paperConcepts.paperId) })
      .from(concepts)
      .leftJoin(paperConcepts, eq(paperConcepts.conceptId, concepts.id))
      .where(eq(concepts.workspaceId, workspaceId))
      .groupBy(concepts.id)
      .orderBy(desc(count(paperConcepts.paperId)))
      .limit(25),
    db
      .select({ title: papers.title })
      .from(libraryItems)
      .innerJoin(papers, eq(papers.id, libraryItems.paperId))
      .where(eq(libraryItems.workspaceId, workspaceId))
      .orderBy(desc(libraryItems.updatedAt))
      .limit(15),
    db.select({ total: count() }).from(libraryItems).where(eq(libraryItems.workspaceId, workspaceId)),
  ]);
  return {
    collections: cols.map((c) => ({ ...c, papers: Number(c.papers) })),
    concepts: cons.map((c) => ({ ...c, papers: Number(c.papers) })).filter((c) => c.papers > 0),
    recent: recent.map((r) => r.title),
    total: Number(total),
  };
}

/** Changes when the library's shape changes noticeably (new collections or concepts, about 10% more papers). */
function fingerprint(p: Profile) {
  const shape = [
    p.collections.map((c) => c.name.toLowerCase()).sort(),
    p.concepts
      .slice(0, 15)
      .map((c) => c.name.toLowerCase())
      .sort(),
    Math.round(Math.log(p.total + 1) / Math.log(1.1)),
  ];
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

/** A collection name as a search: "Spatial reasoning in VLMs / MLLMs" → "Spatial reasoning in VLMs MLLMs". */
export function collectionQuery(name: string) {
  return name
    .replace(/\([^)]*\)/g, " ")
    .replace(/[&/,:;|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Searches straight from the library: its largest concepts and collections. */
export function fromLibrary(p: Profile): TopicSuggestion[] {
  const out: TopicSuggestion[] = [];
  const seen = new Set<string>();
  const add = (query: string, why: string) => {
    const k = query.toLowerCase();
    if (query.length < 3 || seen.has(k) || /^(other|misc)/i.test(query)) return;
    seen.add(k);
    out.push({ query, why, kind: "library" });
  };
  for (const c of p.concepts.slice(0, 3)) add(c.name, `Links ${c.papers} of your papers`);
  for (const c of p.collections.filter((c) => c.papers > 0).slice(0, 3)) {
    add(collectionQuery(c.name), `Your collection “${c.name}”`);
  }
  return out.slice(0, 6);
}

/** arXiv categories as fields (Semantic Scholar names fields; arXiv records carry category codes). */
const ARXIV_FIELDS: [RegExp, string][] = [
  [/^cs\./, "Computer Science"],
  [/^eess\.IV/, "Image and Video Processing"],
  [/^eess\.(SP|AS)/, "Signal Processing"],
  [/^eess\.SY/, "Control Systems"],
  [/^q-bio\.NC/, "Neuroscience"],
  [/^q-bio\./, "Biology"],
  [/^physics\.med-ph/, "Medical Physics"],
  [/^(physics|cond-mat|quant-ph|hep|nucl|gr-qc)/, "Physics"],
  [/^astro-ph/, "Astronomy"],
  [/^stat\./, "Statistics"],
  [/^math\./, "Mathematics"],
  [/^econ\./, "Economics"],
  [/^q-fin\./, "Finance"],
];

/** A field's name: Semantic Scholar's as is, an arXiv category ("q-bio.NC") as its field ("Neuroscience"). */
export function fieldName(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/\s/.test(t) || !/^[a-z-]+\.[A-Za-z-]+$/.test(t)) return t;
  return ARXIV_FIELDS.find(([re]) => re.test(t))?.[1] ?? null;
}

/**
 * Suggestions from the library's citations, no AI needed: papers several of the user's papers cite that they have
 * not saved, recent papers citing theirs, and other fields their papers are connected to.
 */
async function fromCitations(workspaceId: string): Promise<TopicSuggestion[]> {
  const lib = sql`(select paper_id from library_items where workspace_id = ${workspaceId})`;
  const since = new Date().getFullYear() - 2;
  const [buildsOn, citedBy, fields] = await Promise.all([
    db.execute<{ title: string; n: number }>(sql`
      select p.title, count(distinct c.citing_paper_id)::int as n
      from citations c join papers p on p.id = c.cited_paper_id
      where c.citing_paper_id in ${lib} and c.cited_paper_id not in ${lib}
      group by p.id having count(distinct c.citing_paper_id) >= 2
      order by n desc, p.citation_count desc nulls last limit 4`),
    db.execute<{ title: string; n: number }>(sql`
      select p.title, count(distinct c.cited_paper_id)::int as n
      from citations c join papers p on p.id = c.citing_paper_id
      where c.cited_paper_id in ${lib} and c.citing_paper_id not in ${lib} and p.year >= ${since}
      group by p.id order by n desc, p.year desc, p.citation_count desc nulls last limit 4`),
    db.execute<{ field: string; own: number; linked: number; topic: string | null }>(sql`
      with own as (
        select f, count(*)::int as n from papers p, unnest(p.fields_of_study) f where p.id in ${lib} group by f
      ), pairs as (
        select f,
          case when c.citing_paper_id in ${lib} then c.citing_paper_id else c.cited_paper_id end as mine,
          case when c.citing_paper_id in ${lib} then c.cited_paper_id else c.citing_paper_id end as other
        from citations c
        join papers p on p.id = case when c.citing_paper_id in ${lib} then c.cited_paper_id else c.citing_paper_id end,
          unnest(p.fields_of_study) f
        where (c.citing_paper_id in ${lib} or c.cited_paper_id in ${lib}) and p.id not in ${lib}
      ), linked as (
        select f, count(distinct other)::int as n from pairs group by f
      ), topics as (
        -- The user's concept whose papers the field's papers connect to most.
        select distinct on (pairs.f) pairs.f, k.name
        from pairs
        join paper_concepts pc on pc.paper_id = pairs.mine
        join concepts k on k.id = pc.concept_id and k.workspace_id = ${workspaceId}
        group by pairs.f, k.name
        order by pairs.f, count(*) desc
      )
      select linked.f as field, coalesce(own.n, 0) as own, linked.n as linked, topics.name as topic
      from linked left join own on own.f = linked.f left join topics on topics.f = linked.f`),
  ]);
  const out: TopicSuggestion[] = [];
  for (const r of buildsOn) out.push({ query: r.title, why: `Cited by ${r.n} of your papers`, kind: "builds_on" });
  for (const r of citedBy) {
    out.push({
      query: r.title,
      why: r.n === 1 ? "Cites one of your papers" : `Cites ${r.n} of your papers`,
      kind: "cited_by",
    });
  }
  // Fields by name (arXiv codes folded in). The user's own fields (a large part of their library) are not neighbours.
  const own = new Map<string, number>();
  const linked = new Map<string, number>();
  const topics = new Map<string, string>();
  for (const r of fields) {
    const name = fieldName(r.field);
    if (!name) continue;
    own.set(name, (own.get(name) ?? 0) + Number(r.own));
    linked.set(name, (linked.get(name) ?? 0) + Number(r.linked));
    if (r.topic && !topics.has(name)) topics.set(name, r.topic);
  }
  const mainOwn = Math.max(1, ...own.values());
  const neighbours = [...linked.entries()]
    .filter(([name, n]) => n >= 3 && (own.get(name) ?? 0) < mainOwn * 0.2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  for (const [name, n] of neighbours) {
    const topic = topics.get(name);
    out.push({
      query: topic ? `${topic} ${name.toLowerCase()}` : name,
      why: `${n} papers in ${name} cite yours or are cited by them`,
      kind: "neighbouring",
      field: name,
    });
  }
  return out;
}

async function storedIdeas(workspaceId: string) {
  const [row] = await db
    .select()
    .from(aiResults)
    .where(and(eq(aiResults.workspaceId, workspaceId), isNull(aiResults.paperId), eq(aiResults.kind, KIND)))
    .orderBy(desc(aiResults.createdAt))
    .limit(1);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content) as { fingerprint?: string; items?: TopicSuggestion[]; error?: string };
    return { at: row.createdAt, fingerprint: parsed.fingerprint ?? "", items: parsed.items ?? [], error: parsed.error };
  } catch {
    return null;
  }
}

async function ideasQueued(workspaceId: string) {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "topic_suggestions"),
        sql`${jobs.status} in ('queued', 'running')`,
        sql`${jobs.payload}->>'workspaceId' = ${workspaceId}`,
      ),
    )
    .limit(1);
  return !!row;
}

async function queueIdeas(workspaceId: string) {
  await enqueueJob({
    type: "topic_suggestions",
    payload: { workspaceId },
    dedupeKey: `topic_suggestions:${workspaceId}`,
    maxAttempts: 2,
  });
}

/** The suggestions for the search page; asks for new AI ideas in the background when they are missing or old. */
export async function topicSuggestions(workspaceId: string): Promise<TopicSuggestionsResponse> {
  const profile = await libraryProfile(workspaceId);
  const library = [...fromLibrary(profile), ...(await fromCitations(workspaceId))];
  const ai = await getAiConfigRow(workspaceId);
  if (!ai?.enabled || profile.total < 3) {
    return { library, ai: { status: "off", items: [], generatedAt: null } };
  }
  const stored = await storedIdeas(workspaceId);
  const stale = !stored || stored.fingerprint !== fingerprint(profile) || Date.now() - stored.at.getTime() > FRESH_MS;
  const queued = await ideasQueued(workspaceId);
  if (stale && !queued) await queueIdeas(workspaceId);
  return {
    library,
    ai: {
      status: stale || queued ? "pending" : stored?.error ? "error" : "ready",
      items: stored?.items ?? [],
      generatedAt: stored?.at.toISOString() ?? null,
    },
  };
}

/** "New ideas": think up fresh AI suggestions now (in the background). */
export async function refreshTopicSuggestions(workspaceId: string) {
  if (!(await ideasQueued(workspaceId))) await queueIdeas(workspaceId);
}

const SYSTEM = `You suggest literature searches for a researcher, based on their library. Return JSON only, in this shape:
{"related": [{"query": "...", "why": "..."}], "neighbouring": [{"query": "...", "field": "...", "why": "..."}]}

- "related": 4 searches close to their work that the library does not cover well yet: a natural next step, a gap between two of their topics, a method they rely on but have few papers about, or recent directions in their area.
- "neighbouring": 4 searches in OTHER fields whose ideas, methods, theory or data could help their research — the kind of cross-field reading that sparks new approaches (e.g. a technique from another application domain, the theory behind a method they use, a related science). "field": that field in 1-3 words.
- "query": 3-8 words, as typed into a scholarly search engine; no quotes, operators or years.
- "why": at most 14 words, specific to their library — name the topic or collection it connects to. No praise.
- Do not reuse their collection or concept names as queries, and keep the eight suggestions distinct.`;

const ideasSchema = z.object({
  related: z.array(z.object({ query: z.string(), why: z.string().nullish() })).default([]),
  neighbouring: z
    .array(z.object({ query: z.string(), field: z.string().nullish(), why: z.string().nullish() }))
    .default([]),
});

const tidy = (s: string | null | undefined, max: number) => {
  const t = (s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^["“]|["”]$/g, "")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

export function parseIdeas(raw: string): TopicSuggestion[] {
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) return [];
  let parsed: z.infer<typeof ideasSchema>;
  try {
    parsed = ideasSchema.parse(JSON.parse(json));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const keep = (s: TopicSuggestion) => {
    const k = s.query.toLowerCase();
    if (s.query.length < 3 || seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  return [
    ...parsed.related
      .slice(0, 6)
      .map((r): TopicSuggestion => ({ query: tidy(r.query, 90), why: tidy(r.why, 140), kind: "related", ai: true })),
    ...parsed.neighbouring.slice(0, 6).map((r): TopicSuggestion => ({
      query: tidy(r.query, 90),
      why: tidy(r.why, 140),
      kind: "neighbouring",
      ai: true,
      ...(r.field ? { field: tidy(r.field, 40) } : {}),
    })),
  ].filter(keep);
}

function profileText(p: Profile) {
  const cols = p.collections.map((c) => `- ${c.name} (${c.papers} papers)${c.description ? `: ${c.description}` : ""}`);
  const cons = p.concepts.slice(0, 20).map((c) => `- ${c.name} (${c.papers})`);
  return [
    `<library papers="${p.total}">`,
    `Collections:\n${cols.join("\n") || "(none)"}`,
    `Concepts (papers linked):\n${cons.join("\n") || "(none)"}`,
    `Recently added or active papers:\n${p.recent.map((t) => `- ${t}`).join("\n")}`,
    "</library>",
  ].join("\n\n");
}

/** The job: asks the workspace's AI for ideas and stores them (with the library fingerprint they were made for). */
export async function generateTopicSuggestions(workspaceId: string) {
  const profile = await libraryProfile(workspaceId);
  const provider = await providerForWorkspace(workspaceId);
  const previous = await storedIdeas(workspaceId);
  let items: TopicSuggestion[] = [];
  let error: string | undefined;
  try {
    const raw = await complete(provider, {
      system: SYSTEM,
      messages: [{ role: "user", content: profileText(profile) }],
      maxTokens: 1200,
    });
    items = parseIdeas(raw);
    if (!items.length) error = "The AI did not return usable suggestions.";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  // A failed attempt keeps the earlier ideas (and is not retried for a few days unless asked).
  if (error && previous?.items.length) items = previous.items;
  await db.transaction(async (tx) => {
    await tx
      .delete(aiResults)
      .where(and(eq(aiResults.workspaceId, workspaceId), isNull(aiResults.paperId), eq(aiResults.kind, KIND)));
    await tx.insert(aiResults).values({
      workspaceId,
      paperId: null,
      kind: KIND,
      content: JSON.stringify({ fingerprint: fingerprint(profile), items, ...(error ? { error } : {}) }),
      provider: provider.kind,
      model: provider.model,
    });
  });
  return { suggestions: items.length, error: error ?? null };
}
