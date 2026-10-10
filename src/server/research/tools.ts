/**
 * The research agent's tools. They are run by Paperweave (never by the model): each reads
 * scholarly data or the workspace's own knowledge and returns a compact text report that the
 * model sees in the next round. Nothing here writes to the user's library or notes.
 */
import { and, count, desc, eq } from "drizzle-orm";
import type { PMNode } from "@/lib/prosemirror";
import type { ConceptSummary, PaperSummary, ResearchSource, ResearchStepKind } from "@/lib/types";
import {
  loadPaperText,
  pageRange,
  partsInRange,
  relevantParts,
  wholePaper,
  type PaperText,
} from "@/server/ai/paper-text";
import { paperHeader } from "@/server/ai/tasks";
import type { AIProvider } from "@/server/ai/types";
import { db } from "@/server/db/client";
import { libraryItems, notes } from "@/server/db/schema";
import { listConcepts } from "@/server/knowledge/concepts";
import { listCollections, listTags } from "@/server/library/organize";
import { syncCitationPage, type CitationDirection } from "@/server/papers/citations";
import { discover } from "@/server/papers/discovery";
import { getPaperSummaries, getVisiblePaper } from "@/server/papers/service";
import { ingestPapers } from "@/server/papers/ingest";
import { scholarly } from "@/server/scholarly/service";
import type { SearchSort, SearchSource } from "@/server/scholarly/types";
import { SNIPPET_END, SNIPPET_START, searchWorkspace } from "@/server/search/workspace-search";
import { numberedNote } from "./note-blocks";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Assigns stable citation keys (P1, P2… for papers, N1… for notes) within a research thread. */
export class SourceRegistry {
  private byKey = new Map<string, ResearchSource>();
  private keyByRef = new Map<string, string>();
  private counters = { paper: 0, note: 0 };

  constructor(existing: ResearchSource[] = []) {
    for (const s of existing) {
      this.byKey.set(s.key, s);
      this.keyByRef.set(`${s.type}:${s.id}`, s.key);
      const n = Number(s.key.slice(1));
      if (Number.isFinite(n)) this.counters[s.type] = Math.max(this.counters[s.type], n);
    }
  }

  add(source: Omit<ResearchSource, "key">): ResearchSource {
    const ref = `${source.type}:${source.id}`;
    const existing = this.keyByRef.get(ref);
    if (existing) return this.byKey.get(existing)!;
    const key = `${source.type === "paper" ? "P" : "N"}${++this.counters[source.type]}`;
    const entry = { key, ...source };
    this.byKey.set(key, entry);
    this.keyByRef.set(ref, key);
    return entry;
  }

  addPaper(p: PaperSummary): ResearchSource {
    return this.add({
      type: "paper",
      id: p.id,
      title: p.title,
      year: p.year,
      venue: p.venue,
      authors: authorLine(p.authors),
      citationCount: p.citationCount,
    });
  }

  get(key: string): ResearchSource | undefined {
    return this.byKey.get(key.trim().toUpperCase());
  }

  all(): ResearchSource[] {
    return [...this.byKey.values()];
  }
}

function authorLine(authors: string[]) {
  if (!authors.length) return undefined;
  return authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ");
}

export const clean = (text: string | null | undefined, max: number) => {
  const t = (text ?? "").replaceAll(SNIPPET_START, "").replaceAll(SNIPPET_END, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** One line describing a paper source, as the model sees it. */
export function paperLine(s: ResearchSource, p?: PaperSummary) {
  const meta = [s.year, s.venue].filter(Boolean).join(", ");
  const parts = [
    `${s.key}: "${s.title}"`,
    meta && `(${meta})`,
    s.authors && `— ${s.authors}`,
    s.citationCount != null && `· ${s.citationCount.toLocaleString("en-US")} citations`,
    p?.library && "· in the user's library",
  ];
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolContext {
  workspaceId: string;
  sources: SourceRegistry;
  /** The assistant's AI, for tools that ask it something themselves (e.g. extracting fields from papers). */
  provider?: AIProvider;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Text appended to the research findings. */
  report: string;
  /** Number of items found (shown on the step). */
  count?: number;
}

export interface ToolSpec {
  kind: ResearchStepKind;
  label: string;
  run: (ctx: ToolContext) => Promise<ToolResult>;
}

export class ToolInputError extends Error {}

export function paperSource(ctx: ToolContext, key: string) {
  const s = ctx.sources.get(key);
  if (!s || s.type !== "paper") throw new ToolInputError(`${key} is not a known paper key.`);
  return s;
}

export function noteSource(ctx: ToolContext, key: string) {
  const s = ctx.sources.get(key);
  if (!s || s.type !== "note") throw new ToolInputError(`${key} is not a known note key.`);
  return s;
}

export function describePapers(ctx: ToolContext, papers: PaperSummary[], abstractChars: number) {
  return papers
    .map((p) => {
      const s = ctx.sources.addPaper(p);
      const abstract = abstractChars > 0 ? clean(p.abstract, abstractChars) : "";
      return `- ${paperLine(s, p)}${abstract ? `\n  Abstract: ${abstract}` : ""}`;
    })
    .join("\n");
}

export async function searchPapers(
  ctx: ToolContext,
  input: {
    query: string;
    yearFrom?: number;
    yearTo?: number;
    minCitations?: number;
    sort?: SearchSort;
    source?: SearchSource;
    offset?: number;
    underReview?: boolean;
  },
): Promise<ToolResult> {
  const offset = Math.max(0, input.offset ?? 0);
  const res = await discover(ctx.workspaceId, {
    q: input.query,
    mode: "all",
    exact: true,
    offset,
    limit: 10,
    sort: input.sort,
    source: input.source,
    filters: {
      yearFrom: input.yearFrom,
      yearTo: input.yearTo,
      minCitations: input.minCitations,
      includeUnderReview: input.underReview,
    },
  });
  if (!res.items.length) {
    return { report: `Literature search "${input.query}": no ${offset ? "more " : ""}results.`, count: 0 };
  }
  const total = res.total != null ? ` of about ${res.total.toLocaleString("en-US")}` : "";
  const more = res.items.length === 10 ? ` More: repeat with "offset": ${offset + 10}.` : "";
  return {
    report: `Literature search "${input.query}" — results ${offset + 1}–${offset + res.items.length}${total}.${more}\n${describePapers(ctx, res.items, 400)}`,
    count: res.items.length,
  };
}

/** The newest arXiv preprints matching the query (often not yet in the large scholarly indexes). */
export async function searchArxiv(ctx: ToolContext, query: string): Promise<ToolResult> {
  const records = await scholarly().latestPreprints(query, 10);
  if (!records.length) return { report: `arXiv latest preprints "${query}": none found.`, count: 0 };
  const ids = await ingestPapers(records);
  const papers = await getPaperSummaries(ctx.workspaceId, [...new Set(ids)]);
  const dates = new Map(records.map((r, i) => [ids[i], r.publicationDate]));
  const lines = papers.map((p) => {
    const s = ctx.sources.addPaper(p);
    const abstract = clean(p.abstract, 400);
    return `- ${paperLine(s, p)}${dates.get(p.id) ? ` · posted ${dates.get(p.id)}` : ""}${abstract ? `\n  Abstract: ${abstract}` : ""}`;
  });
  return {
    report: `arXiv latest preprints "${query}" — ${papers.length} most recently posted:\n${lines.join("\n")}`,
    count: papers.length,
  };
}

const NEIGHBORS_SHOWN = 15;

export async function citationNeighbors(
  ctx: ToolContext,
  key: string,
  direction: CitationDirection,
  opts: { offset?: number; sort?: "cited" | "newest" } = {},
): Promise<ToolResult> {
  const source = paperSource(ctx, key);
  const paper = await getVisiblePaper(ctx.workspaceId, source.id);
  const what =
    direction === "references" ? `Papers that ${key} cites (earlier work)` : `Papers citing ${key} (later work)`;
  if (paper.ownerWorkspaceId !== null) {
    return { report: `${what}: not available for manually entered papers.`, count: 0 };
  }
  const { page, resolved } = await syncCitationPage(source.id, direction, 0, direction === "references" ? 500 : 200);
  if (!page || !resolved.length) return { report: `${what}: no citation data available.`, count: 0 };
  const influential = new Set(resolved.filter((r) => r.entry.isInfluential).map((r) => r.id));
  const summaries = (await getPaperSummaries(ctx.workspaceId, [...new Set(resolved.map((r) => r.id))])).filter(
    (p) => p.id !== source.id,
  );
  // Most-cited first (influential citations, when reported, break ties upward), or newest first.
  const sorted = summaries.sort((a, b) =>
    opts.sort === "newest"
      ? (b.year ?? 0) - (a.year ?? 0) || (b.citationCount ?? 0) - (a.citationCount ?? 0)
      : Number(influential.has(b.id)) - Number(influential.has(a.id)) ||
        (b.citationCount ?? 0) - (a.citationCount ?? 0),
  );
  const offset = Math.max(0, opts.offset ?? 0);
  const shown = sorted.slice(offset, offset + NEIGHBORS_SHOWN);
  const total = page.total ?? summaries.length;
  if (!shown.length) return { report: `${what}: no more (${sorted.length} listed in total).`, count: total };
  const order = opts.sort === "newest" ? "newest first" : "most cited first";
  const more = offset + shown.length < sorted.length ? ` More: repeat with "offset": ${offset + shown.length}.` : "";
  const partial = total > sorted.length ? ` (${sorted.length.toLocaleString("en-US")} of them retrieved)` : "";
  return {
    report: `${what} — ${order}, ${offset + 1}–${offset + shown.length} of ${total.toLocaleString("en-US")}${partial}.${more}\n${describePapers(ctx, shown, 220)}`,
    count: total,
  };
}

const READ_BUDGET = 14_000;
/** Reading a page range ("pages": "5-8"): up to 8 pages. */
const PAGE_READ_BUDGET = 24_000;
const READ_SOURCE: Record<PaperText["source"], string> = {
  pdf: "full text from the PDF in the workspace",
  open_access: "full text from its open-access PDF",
  pmc: "full text from PubMed Central",
};

export async function readPaper(
  ctx: ToolContext,
  key: string,
  focus: string | undefined,
  pages?: string,
): Promise<ToolResult> {
  const source = paperSource(ctx, key);
  const paper = await getVisiblePaper(ctx.workspaceId, source.id);
  const title = `Contents of ${key}${focus ? ` (looking for: ${focus})` : ""}`;
  // The workspace PDF, else the legal open-access copy (not stored), else PubMed Central's full text.
  const full = await loadPaperText(ctx.workspaceId, paper.id);
  if (!full) {
    return { report: `${title} — only the metadata and abstract are available (no full text):\n${paperHeader(paper)}` };
  }
  const unit = full.unit === "section" ? "sections" : "pages";
  const total = full.parts.at(-1)?.n ?? full.parts.length;
  const range = pages ? pageRange(pages) : null;
  if (range) {
    const { body, included } = partsInRange(full, range, PAGE_READ_BUDGET);
    if (!included.length) {
      throw new ToolInputError(`${key} has ${total} ${unit}; ${pages} is outside it.`);
    }
    const shown = included.length > 1 ? `${included[0]}–${included.at(-1)}` : `${included[0]}`;
    return {
      report: `${title} — ${READ_SOURCE[full.source]}, ${unit} ${shown} of ${total}:\n${paper.title}\n\n${body}`,
    };
  }
  const { body } = focus?.trim() ? relevantParts(full, focus, READ_BUDGET) : wholePaper(full, READ_BUDGET);
  return {
    report: `${title} — ${READ_SOURCE[full.source]} (${total} ${unit}; read specific ones with "pages"):\n${paperHeader(paper)}\n\n${body}`,
  };
}

const LIBRARY_LISTED = 80;

/** The workspace's concepts with how many papers each links, e.g. "MRI" (5 papers, also "magnetic resonance"). */
function conceptLine(list: ConceptSummary[]) {
  const shown = list
    .slice(0, 200)
    .map((c) => {
      const extra = [
        `${c.paperCount} paper${c.paperCount === 1 ? "" : "s"}`,
        ...(c.aliases.length ? [`also ${c.aliases.map((a) => `"${a}"`).join(", ")}`] : []),
      ].join(", ");
      return `"${c.name}" (${extra})${c.description ? ` — ${clean(c.description, 80)}` : ""}`;
    })
    .join("; ");
  return `Concepts (${list.length}${list.length > 200 ? ", 200 listed" : ""}): ${shown || "none"}`;
}

/** The existing concepts, shown before the assistant may propose any (see the agent loop). */
export async function existingConcepts(ctx: ToolContext): Promise<ToolResult> {
  const list = await listConcepts(ctx.workspaceId);
  return { report: `The user's existing concepts — ${conceptLine(list)}`, count: list.length };
}

/**
 * The user's saved papers (most recently updated first), collections, tags and concepts — so the
 * assistant sees everything it may act on and reuses existing names.
 */
export async function listWorkspace(ctx: ToolContext): Promise<ToolResult> {
  const [cols, tagList, conceptList, saved, [{ total }]] = await Promise.all([
    listCollections(ctx.workspaceId),
    listTags(ctx.workspaceId),
    listConcepts(ctx.workspaceId),
    db
      .select({ id: libraryItems.paperId, status: libraryItems.status })
      .from(libraryItems)
      .where(eq(libraryItems.workspaceId, ctx.workspaceId))
      .orderBy(desc(libraryItems.updatedAt))
      .limit(LIBRARY_LISTED),
    db.select({ total: count() }).from(libraryItems).where(eq(libraryItems.workspaceId, ctx.workspaceId)),
  ]);
  const statusById = new Map(saved.map((r) => [r.id, r.status]));
  const summaries = await getPaperSummaries(
    ctx.workspaceId,
    saved.map((r) => r.id),
  );
  const paperLines = summaries.map((p) => `  - ${paperLine(ctx.sources.addPaper(p))} [${statusById.get(p.id)}]`);
  const lines = [
    `Saved papers (${total}${total > LIBRARY_LISTED ? `, the ${LIBRARY_LISTED} most recently updated listed` : ""}):${paperLines.length ? `\n${paperLines.join("\n")}` : " none"}`,
    `Collections (${cols.length}): ${
      cols
        .slice(0, 100)
        .map((c) => `"${c.name}" (${c.paperCount} papers)`)
        .join("; ") || "none"
    }`,
    `Tags (${tagList.length}): ${
      tagList
        .slice(0, 100)
        .map((t) => `#${t.name}`)
        .join(", ") || "none"
    }`,
    conceptLine(conceptList),
  ];
  return { report: `The user's workspace:\n${lines.join("\n")}`, count: total };
}

export type LibraryKind = "papers" | "notes" | "highlights" | "pdf_text";

export async function searchLibrary(
  ctx: ToolContext,
  query: string,
  opts: { kind?: LibraryKind; offset?: number } = {},
): Promise<ToolResult> {
  // One kind: a longer list of it (pageable); all kinds: the best few of each.
  const offset = Math.max(0, opts.offset ?? 0);
  const res = await searchWorkspace(ctx.workspaceId, query, opts.kind ? { limit: 20, offset } : {});
  const n = (k: LibraryKind, all: number) => (opts.kind ? (opts.kind === k ? 20 : 0) : all);
  const lines: string[] = [];
  const summaryById = new Map(res.papers.map((p) => [p.paper.id, p.paper]));
  for (const { paper, snippet } of res.papers.slice(0, n("papers", 8))) {
    const s = ctx.sources.addPaper(paper);
    lines.push(`- Saved paper ${paperLine(s, paper)}${snippet ? `\n  Match: ${clean(snippet, 300)}` : ""}`);
  }
  for (const note of res.notes.slice(0, n("notes", 6))) {
    const s = ctx.sources.add({ type: "note", id: note.id, title: note.title || "Untitled note" });
    lines.push(
      `- User's note ${s.key}: "${s.title}"${note.paperTitle ? ` (about "${note.paperTitle}")` : ""}\n  Match: ${clean(
        note.snippet ?? note.excerpt,
        400,
      )}`,
    );
  }
  const missing = [...res.highlights.map((h) => h.paperId), ...res.pdfPages.map((p) => p.paperId)].filter(
    (id) => !summaryById.has(id),
  );
  if (missing.length) {
    for (const p of await getPaperSummaries(ctx.workspaceId, [...new Set(missing)])) summaryById.set(p.id, p);
  }
  const keyFor = (paperId: string) => {
    const p = summaryById.get(paperId);
    return p ? ctx.sources.addPaper(p).key : null;
  };
  for (const h of res.highlights.slice(0, n("highlights", 8))) {
    lines.push(
      `- User's highlight in ${keyFor(h.paperId) ?? `"${h.paperTitle}"`} (p. ${h.pageNumber}): "${clean(h.text, 300)}"${
        h.comment ? `\n  Their comment: ${clean(h.comment, 300)}` : ""
      }`,
    );
  }
  for (const pg of res.pdfPages.slice(0, n("pdf_text", 6))) {
    lines.push(
      `- PDF text of ${keyFor(pg.paperId) ?? `"${pg.paperTitle}"`} (p. ${pg.pageNumber}): ${clean(pg.snippet, 300)}`,
    );
  }
  if (res.concepts.length && !opts.kind) {
    lines.push(
      `- User's concepts: ${res.concepts
        .slice(0, 10)
        .map((c) => c.name)
        .join("; ")}`,
    );
  }
  const count = res.papers.length + res.notes.length + res.highlights.length + res.pdfPages.length;
  const what = opts.kind ? ` (${opts.kind.replace("_", " ")} only, from result ${offset + 1})` : "";
  const more =
    opts.kind && lines.length === 20
      ? `\nMore: repeat with "kind": "${opts.kind}", "offset": ${offset + 20}.`
      : !opts.kind && lines.length
        ? `\n(For a longer list of one kind, repeat with "kind": papers, notes, highlights or pdf_text.)`
        : "";
  return {
    report: lines.length
      ? `The user's library for "${query}"${what}:\n${lines.join("\n")}${more}`
      : `The user's library for "${query}"${what}: nothing ${offset ? "more " : ""}found.`,
    count,
  };
}

export async function readNote(ctx: ToolContext, key: string): Promise<ToolResult> {
  const source = noteSource(ctx, key);
  const [row] = await db
    .select({ title: notes.title, content: notes.content })
    .from(notes)
    .where(and(eq(notes.id, source.id), eq(notes.workspaceId, ctx.workspaceId)));
  if (!row) throw new ToolInputError(`${key} no longer exists.`);
  // Numbered blocks, so edit_note can name exactly the blocks it changes.
  return {
    report: `The user's note ${key} "${row.title || "Untitled note"}" (blocks [B1], [B2], … — [[…]] are links to papers, concepts or notes):\n${numberedNote(row.content as PMNode, 12_000)}`,
  };
}
