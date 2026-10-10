/**
 * Assistant tools that read the user's own organisation of their knowledge: a concept and what it
 * links, a paper's place in the workspace, saved papers by collection / tag / concept / status, the
 * user's highlights, and what else in the library connects to a paper. Read-only, like tools.ts.
 */
import { and, asc, count, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { conceptKey } from "@/lib/concept-names";
import type { ReadingStatus } from "@/lib/types";
import { db } from "@/server/db/client";
import {
  citations,
  collectionPapers,
  collections,
  conceptRelations,
  concepts,
  highlights,
  libraryItems,
  noteLinks,
  notes,
  paperConcepts,
  paperFiles,
  papers,
  paperTags,
  tags,
} from "@/server/db/schema";
import { getPaperDetail, getPaperSummaries } from "@/server/papers/service";
import { clean, describePapers, paperSource, ToolInputError, type ToolContext, type ToolResult } from "./tools";

/** The workspace's concept by name, matching plurals, abbreviations and aliases. */
async function findConcept(workspaceId: string, name: string) {
  const rows = await db
    .select({ id: concepts.id, name: concepts.name, aliases: concepts.aliases, description: concepts.description })
    .from(concepts)
    .where(eq(concepts.workspaceId, workspaceId));
  const key = conceptKey(name);
  return (
    rows.find((c) => c.name.toLowerCase() === name.trim().toLowerCase()) ??
    rows.find((c) => [c.name, ...c.aliases].some((a) => conceptKey(a) === key)) ??
    null
  );
}

export async function readConcept(ctx: ToolContext, name: string): Promise<ToolResult> {
  const concept = await findConcept(ctx.workspaceId, name);
  if (!concept) {
    const close = (
      await db
        .select({ name: concepts.name })
        .from(concepts)
        .where(and(eq(concepts.workspaceId, ctx.workspaceId), sql`${concepts.name} ilike ${`%${name.trim()}%`}`))
        .limit(10)
    ).map((c) => `"${c.name}"`);
    return {
      report: `There is no concept “${name}”.${close.length ? ` Similar names: ${close.join(", ")}.` : " (list_concepts shows them all.)"}`,
      count: 0,
    };
  }
  const paperIds = (
    await db.select({ id: paperConcepts.paperId }).from(paperConcepts).where(eq(paperConcepts.conceptId, concept.id))
  ).map((r) => r.id);
  const [papers, related, mentioning] = await Promise.all([
    getPaperSummaries(ctx.workspaceId, paperIds),
    db
      .select({ name: concepts.name })
      .from(conceptRelations)
      .innerJoin(
        concepts,
        or(
          and(eq(conceptRelations.conceptAId, concept.id), eq(concepts.id, conceptRelations.conceptBId)),
          and(eq(conceptRelations.conceptBId, concept.id), eq(concepts.id, conceptRelations.conceptAId)),
        ),
      ),
    db
      .selectDistinct({ id: notes.id, title: notes.title })
      .from(noteLinks)
      .innerJoin(notes, eq(notes.id, noteLinks.noteId))
      .where(and(eq(noteLinks.targetConceptId, concept.id), eq(notes.workspaceId, ctx.workspaceId)))
      .limit(20),
  ]);
  const noteLines = mentioning.map(
    (n) => `${ctx.sources.add({ type: "note", id: n.id, title: n.title }).key}: "${n.title || "Untitled"}"`,
  );
  return {
    report: [
      `Concept “${concept.name}”${concept.aliases.length ? ` (also: ${concept.aliases.join(", ")})` : ""}${concept.description ? ` — ${concept.description}` : ""}`,
      `Linked papers (${papers.length}):${papers.length ? `\n${describePapers(ctx, papers, 0)}` : " none"}`,
      `Related concepts: ${related.map((r) => `"${r.name}"`).join(", ") || "none"}`,
      `Notes that mention it: ${noteLines.join("; ") || "none"}`,
    ].join("\n"),
    count: papers.length,
  };
}

/** A paper's place in the workspace: status, collections, tags, concepts, notes, highlights, PDF. */
export async function paperInfo(ctx: ToolContext, key: string): Promise<ToolResult> {
  const source = paperSource(ctx, key);
  const p = await getPaperDetail(ctx.workspaceId, source.id);
  const note = (n: { id: string; title: string }) =>
    `${ctx.sources.add({ type: "note", id: n.id, title: n.title }).key} "${n.title || "Untitled"}"`;
  const ids = Object.entries(p.ids)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const pdf = p.files.length
    ? `in the workspace (${p.files[0].pageCount ?? "?"} pages${p.files[0].textStatus === "ready" ? "" : ", text not extracted"})`
    : p.pdfAvailable
      ? "not saved yet; a free copy exists (attach_pdfs)"
      : p.freeReadUrl
        ? `not available; free to read at ${p.freeReadUrl}`
        : "none known";
  return {
    report: [
      `${key}: ${p.title} (${[p.authors.slice(0, 4).join(", "), p.year, p.venue].filter(Boolean).join(" · ")})`,
      `Citations: ${p.citationCount ?? "?"}${p.influentialCitationCount ? ` (${p.influentialCitationCount} influential)` : ""} · identifiers: ${ids || "none"}`,
      `In the library: ${p.library ? p.library.status : "no (not saved)"}`,
      `Collections: ${p.collections.map((c) => `"${c.name}"`).join(", ") || "none"}`,
      `Tags: ${p.tags.map((t) => `#${t.name}`).join(", ") || "none"}`,
      `Concepts: ${p.concepts.map((c) => `"${c.name}"`).join(", ") || "none"}`,
      `Notes on it: ${p.notes.map(note).join("; ") || "none"}`,
      `Notes that mention it: ${p.mentionedIn.map(note).join("; ") || "none"}`,
      `Highlights: ${p.highlightCount} · PDF: ${pdf}`,
      p.abstract ? `Abstract: ${clean(p.abstract, 1500)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** Values accepted where a filter takes one name or several (any of them). */
type OneOrMany = string | string[] | undefined;
const many = (v: OneOrMany) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => x.trim()).filter(Boolean);

export interface SavedPaperFilter {
  /** In any of these collections / tags / concepts (by name). */
  collection?: OneOrMany;
  tag?: OneOrMany;
  concept?: OneOrMany;
  /** In none of these. */
  notCollection?: OneOrMany;
  notTag?: OneOrMany;
  notConcept?: OneOrMany;
  status?: ReadingStatus | ReadingStatus[];
  query?: string;
  yearFrom?: number;
  yearTo?: number;
  hasPdf?: boolean;
  /** Notes on the paper or mentioning it. */
  hasNotes?: boolean;
  hasHighlights?: boolean;
  hasConcepts?: boolean;
  inCollection?: boolean;
  /** Publication types (journal_article, conference, preprint, review, book, dataset, dissertation, other). */
  types?: string[];
  notTypes?: string[];
  sort?: SavedSort;
  offset?: number;
  limit?: number;
}

export const SAVED_SORTS = ["updated", "added", "newest", "oldest", "citations", "title"] as const;
type SavedSort = (typeof SAVED_SORTS)[number];

const FIND_LIMIT = 60;
const FIND_MAX = 100;

/** Ids of the workspace's collections / tags / concepts with these names; unknown names are an input error. */
async function idsByName(ws: string, kind: "collection" | "tag" | "concept", names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const n of names) {
    if (kind === "concept") {
      const c = await findConcept(ws, n);
      if (!c) throw new ToolInputError(`There is no concept “${n}”.`);
      ids.push(c.id);
      continue;
    }
    const table = kind === "collection" ? collections : tags;
    const wanted = (kind === "tag" ? n.replace(/^#/, "") : n).trim().toLowerCase();
    const [row] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.workspaceId, ws), sql`lower(${table.name}) = ${wanted}`));
    if (!row) throw new ToolInputError(`There is no ${kind} “${n}”.`);
    ids.push(row.id);
  }
  return ids;
}

/**
 * Saved papers matching every given filter, with paging: names may be one or a list (any of), the
 * "not" filters exclude, and the has_/in_ filters find missing relationships ("no notes yet").
 */
export async function findSavedPapers(ctx: ToolContext, f: SavedPaperFilter): Promise<ToolResult> {
  const ws = ctx.workspaceId;
  const [inCols, notCols, inTags, notTags, inConcepts, notConcepts] = await Promise.all([
    idsByName(ws, "collection", many(f.collection)),
    idsByName(ws, "collection", many(f.notCollection)),
    idsByName(ws, "tag", many(f.tag)),
    idsByName(ws, "tag", many(f.notTag)),
    idsByName(ws, "concept", many(f.concept)),
    idsByName(ws, "concept", many(f.notConcept)),
  ]);
  const statuses = Array.isArray(f.status) ? f.status : f.status ? [f.status] : [];
  const inCollectionSql = (ids?: string[]) =>
    sql`exists (select 1 from ${collectionPapers} cp join ${collections} c on c.id = cp.collection_id
      where cp.paper_id = ${papers.id} and c.workspace_id = ${ws} ${ids ? sql`and cp.collection_id in ${ids}` : sql``})`;
  const taggedSql = (ids: string[]) =>
    sql`exists (select 1 from ${paperTags} pt where pt.paper_id = ${papers.id} and pt.tag_id in ${ids})`;
  const conceptSql = (ids?: string[]) =>
    sql`exists (select 1 from ${paperConcepts} pc join ${concepts} c on c.id = pc.concept_id
      where pc.paper_id = ${papers.id} and c.workspace_id = ${ws} ${ids ? sql`and pc.concept_id in ${ids}` : sql``})`;
  const yesNo = (v: boolean | undefined, cond: SQL) => (v === undefined ? undefined : v ? cond : sql`not ${cond}`);
  const like = f.query?.trim() ? `%${f.query.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;

  const where = and(
    eq(libraryItems.workspaceId, ws),
    statuses.length ? inArray(libraryItems.status, statuses) : undefined,
    like
      ? sql`(${papers.title} ilike ${like} or ${papers.authorsText} ilike ${like} or ${papers.abstract} ilike ${like})`
      : undefined,
    f.yearFrom ? sql`${papers.year} >= ${f.yearFrom}` : undefined,
    f.yearTo ? sql`${papers.year} <= ${f.yearTo}` : undefined,
    inCols.length ? inCollectionSql(inCols) : undefined,
    notCols.length ? sql`not ${inCollectionSql(notCols)}` : undefined,
    inTags.length ? taggedSql(inTags) : undefined,
    notTags.length ? sql`not ${taggedSql(notTags)}` : undefined,
    inConcepts.length ? conceptSql(inConcepts) : undefined,
    notConcepts.length ? sql`not ${conceptSql(notConcepts)}` : undefined,
    yesNo(
      f.hasPdf,
      sql`exists (select 1 from ${paperFiles} pf where pf.paper_id = ${papers.id} and pf.workspace_id = ${ws})`,
    ),
    yesNo(
      f.hasNotes,
      sql`exists (select 1 from ${notes} n where n.workspace_id = ${ws} and (n.paper_id = ${papers.id}
        or exists (select 1 from ${noteLinks} nl where nl.note_id = n.id and nl.target_paper_id = ${papers.id})))`,
    ),
    yesNo(
      f.hasHighlights,
      sql`exists (select 1 from ${highlights} h where h.paper_id = ${papers.id} and h.workspace_id = ${ws})`,
    ),
    yesNo(f.hasConcepts, conceptSql()),
    yesNo(f.inCollection, inCollectionSql()),
    f.types?.length ? sql`${papers.publicationTypes} && ${sql.param(f.types)}::text[]` : undefined,
    f.notTypes?.length ? sql`not (${papers.publicationTypes} && ${sql.param(f.notTypes)}::text[])` : undefined,
  );
  const order = {
    updated: [desc(libraryItems.updatedAt)],
    added: [desc(libraryItems.createdAt)],
    newest: [sql`${papers.year} desc nulls last`, desc(libraryItems.createdAt)],
    oldest: [sql`${papers.year} asc nulls last`, desc(libraryItems.createdAt)],
    citations: [sql`${papers.citationCount} desc nulls last`],
    title: [asc(papers.title)],
  }[f.sort ?? "updated"];
  const offset = Math.max(0, f.offset ?? 0);
  const limit = Math.min(FIND_MAX, Math.max(1, f.limit ?? FIND_LIMIT));
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ id: papers.id, status: libraryItems.status })
      .from(libraryItems)
      .innerJoin(papers, eq(papers.id, libraryItems.paperId))
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(libraryItems)
      .innerJoin(papers, eq(papers.id, libraryItems.paperId))
      .where(where),
  ]);
  const ids = rows.map((r) => r.id);
  const [summaries, memberships, withPdf] = await Promise.all([
    getPaperSummaries(ws, ids),
    ids.length
      ? db
          .select({ paperId: collectionPapers.paperId, name: collections.name })
          .from(collectionPapers)
          .innerJoin(collections, eq(collections.id, collectionPapers.collectionId))
          .where(and(eq(collections.workspaceId, ws), inArray(collectionPapers.paperId, ids)))
      : [],
    ids.length
      ? db
          .selectDistinct({ id: paperFiles.paperId })
          .from(paperFiles)
          .where(and(eq(paperFiles.workspaceId, ws), inArray(paperFiles.paperId, ids)))
      : [],
  ]);
  const status = new Map(rows.map((r) => [r.id, r.status]));
  const pdf = new Set(withPdf.map((r) => r.id));
  const cols = new Map<string, string[]>();
  for (const m of memberships) cols.set(m.paperId, [...(cols.get(m.paperId) ?? []), m.name]);

  const list = (v: OneOrMany, word: string) => {
    const names = many(v);
    return names.length ? `${word} ${names.map((n) => `“${n}”`).join(" or ")}` : null;
  };
  const flag = (v: boolean | undefined, yes: string, no: string) => (v === undefined ? null : v ? yes : no);
  const what = [
    list(f.collection, "in"),
    list(f.tag, "tagged"),
    list(f.concept, "linked to"),
    list(f.notCollection, "not in"),
    list(f.notTag, "not tagged"),
    list(f.notConcept, "not linked to"),
    statuses.length && `marked ${statuses.join(" or ")}`,
    f.query && `matching “${f.query}”`,
    (f.yearFrom || f.yearTo) && `from ${f.yearFrom ?? "…"}–${f.yearTo ?? "now"}`,
    flag(f.hasPdf, "with a PDF", "without a PDF"),
    flag(f.hasNotes, "with notes", "without notes"),
    flag(f.hasHighlights, "with highlights", "without highlights"),
    flag(f.hasConcepts, "linked to concepts", "not linked to any concept"),
    flag(f.inCollection, "in a collection", "in no collection"),
    f.types?.length && `of type ${f.types.join(" or ")}`,
    f.notTypes?.length && `not of type ${f.notTypes.join(" or ")}`,
  ]
    .filter(Boolean)
    .join(", ");
  const lines = summaries.map((p) => {
    const s = ctx.sources.addPaper(p);
    const inCols = cols.get(p.id) ?? [];
    return `- ${s.key}: ${p.title} (${p.year ?? "n.d."}) · ${status.get(p.id)}${pdf.has(p.id) ? " · PDF" : ""}${
      p.publicationTypes.includes("review") ? " · review" : ""
    }${inCols.length ? ` · in ${inCols.map((c) => `“${c}”`).join(", ")}` : ""}`;
  });
  const range = summaries.length ? `${offset + 1}–${offset + summaries.length}` : "none";
  const more = offset + summaries.length < total ? ` More: repeat with "offset": ${offset + summaries.length}.` : "";
  return {
    report: `Saved papers${what ? ` ${what}` : ""}: ${total} in total (sorted by ${f.sort ?? "updated"}; showing ${range}).${more}${lines.length ? `\n${lines.join("\n")}` : ""}`,
    count: total,
  };
}

const HIGHLIGHTS_LISTED = 120;

/** The user's highlights and annotations on a paper, in page order. */
export async function readHighlights(ctx: ToolContext, key: string, offset = 0): Promise<ToolResult> {
  const source = paperSource(ctx, key);
  const rows = await db
    .select({
      page: highlights.pageNumber,
      kind: highlights.kind,
      color: highlights.color,
      text: highlights.selectedText,
      comment: highlights.comment,
    })
    .from(highlights)
    .where(and(eq(highlights.workspaceId, ctx.workspaceId), eq(highlights.paperId, source.id)))
    .orderBy(highlights.pageNumber, highlights.createdAt)
    .limit(HIGHLIGHTS_LISTED)
    .offset(offset);
  const lines = rows.map(
    (h) =>
      `- p. ${h.page} [${h.kind === "note" ? "page note" : `${h.color} highlight`}]${h.text ? ` “${clean(h.text, 400)}”` : ""}${h.comment ? ` — comment: ${clean(h.comment, 400)}` : ""}`,
  );
  return {
    report: `Your highlights in ${key}${offset ? ` from no. ${offset + 1}` : ""} (${rows.length}${rows.length === HIGHLIGHTS_LISTED ? `+; more: repeat with "offset": ${offset + HIGHLIGHTS_LISTED}` : ""}):${lines.length ? `\n${lines.join("\n")}` : " none yet"}`,
    count: rows.length,
  };
}

/**
 * Saved papers connected to a paper, strongest first: shared concepts, shared collections, citations
 * between them, and notes that link both.
 */
export async function relatedInLibrary(ctx: ToolContext, key: string): Promise<ToolResult> {
  const source = paperSource(ctx, key);
  const ws = ctx.workspaceId;
  const id = source.id;
  const saved = db.select({ id: libraryItems.paperId }).from(libraryItems).where(eq(libraryItems.workspaceId, ws));
  const [viaConcepts, viaCollections, cites, citedBy, viaNotes] = await Promise.all([
    db
      .select({ paperId: paperConcepts.paperId, label: concepts.name })
      .from(paperConcepts)
      .innerJoin(concepts, eq(concepts.id, paperConcepts.conceptId))
      .where(
        and(
          eq(concepts.workspaceId, ws),
          ne(paperConcepts.paperId, id),
          inArray(
            paperConcepts.conceptId,
            db.select({ c: paperConcepts.conceptId }).from(paperConcepts).where(eq(paperConcepts.paperId, id)),
          ),
        ),
      ),
    db
      .select({ paperId: collectionPapers.paperId, label: collections.name })
      .from(collectionPapers)
      .innerJoin(collections, eq(collections.id, collectionPapers.collectionId))
      .where(
        and(
          eq(collections.workspaceId, ws),
          ne(collectionPapers.paperId, id),
          inArray(
            collectionPapers.collectionId,
            db
              .select({ c: collectionPapers.collectionId })
              .from(collectionPapers)
              .where(eq(collectionPapers.paperId, id)),
          ),
        ),
      ),
    db
      .select({ paperId: citations.citedPaperId })
      .from(citations)
      .where(and(eq(citations.citingPaperId, id), inArray(citations.citedPaperId, saved))),
    db
      .select({ paperId: citations.citingPaperId })
      .from(citations)
      .where(and(eq(citations.citedPaperId, id), inArray(citations.citingPaperId, saved))),
    db
      .select({ paperId: noteLinks.targetPaperId, label: notes.title })
      .from(noteLinks)
      .innerJoin(notes, eq(notes.id, noteLinks.noteId))
      .where(
        and(
          eq(notes.workspaceId, ws),
          ne(noteLinks.targetPaperId, id),
          inArray(
            noteLinks.noteId,
            db.select({ n: noteLinks.noteId }).from(noteLinks).where(eq(noteLinks.targetPaperId, id)),
          ),
        ),
      ),
  ]);
  const links = new Map<string, string[]>();
  const add = (paperId: string | null, why: string) => {
    if (!paperId || paperId === id) return;
    const list = links.get(paperId) ?? [];
    if (!list.includes(why)) list.push(why);
    links.set(paperId, list);
  };
  for (const r of viaConcepts) add(r.paperId, `concept “${r.label}”`);
  for (const r of viaCollections) add(r.paperId, `collection “${r.label}”`);
  for (const r of cites) add(r.paperId, `${key} cites it`);
  for (const r of citedBy) add(r.paperId, `it cites ${key}`);
  for (const r of viaNotes) add(r.paperId, `your note “${r.label || "Untitled"}”`);
  const ranked = [...links.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 40);
  const papers = new Map(
    (
      await getPaperSummaries(
        ws,
        ranked.map(([pid]) => pid),
      )
    ).map((p) => [p.id, p]),
  );
  const lines = ranked.flatMap(([pid, why]) => {
    const p = papers.get(pid);
    if (!p) return [];
    const s = ctx.sources.addPaper(p);
    return [`- ${s.key}: ${p.title} (${p.year ?? "n.d."}) — via ${why.join("; ")}`];
  });
  return {
    report: `Saved papers connected to ${key} (${links.size}):${lines.length ? `\n${lines.join("\n")}` : " none yet (no shared concepts, collections, citations or notes)."}`,
    count: links.size,
  };
}

/**
 * The user's screenings: without a title, each with its progress; with one, its criteria, counts and the
 * included and "maybe" papers (with keys and the reasons), so they can be discussed or acted on.
 */
export async function readScreening(ctx: ToolContext, title?: string): Promise<ToolResult> {
  const { listScreenings, screeningDetail } = await import("@/server/screening/service");
  const all = await listScreenings(ctx.workspaceId);
  const line = (s: (typeof all)[number]) =>
    `“${s.title}” — ${s.status}: ${s.total - s.counts.pending}/${s.total} screened, ${s.counts.include} include, ${s.counts.maybe} maybe, ${s.counts.exclude} exclude`;
  if (!title?.trim()) {
    return {
      report: all.length
        ? `The user's screenings:\n${all.map((s) => `- ${line(s)}`).join("\n")}`
        : "The user has no screenings yet.",
      count: all.length,
    };
  }
  const wanted = title.trim().toLowerCase();
  const found =
    all.find((s) => s.title.toLowerCase() === wanted) ?? all.find((s) => s.title.toLowerCase().includes(wanted));
  if (!found)
    throw new ToolInputError(
      `There is no screening “${title}”.${all.length ? ` Screenings: ${all.map((s) => `“${s.title}”`).join(", ")}.` : ""}`,
    );
  const d = await screeningDetail(ctx.workspaceId, found.id);
  const listed = d.items.filter((i) => i.decision === "include" || i.decision === "maybe").slice(0, 60);
  const lines = listed.map((i) => {
    const s = ctx.sources.addPaper(i.paper);
    return `- ${s.key} [${i.decision}${i.decidedBy === "user" ? ", by the user" : ""}] ${i.paper.title} (${i.paper.year ?? "n.d."}) — ${clean(i.reason, 300)}`;
  });
  return {
    report: `Screening ${line(d)}\nCriteria: ${clean(d.criteria, 1500)}\nIncluded and "maybe" papers${listed.length < d.counts.include + d.counts.maybe ? " (first 60)" : ""}:\n${lines.join("\n") || "(none yet)"}`,
    count: d.total,
  };
}
