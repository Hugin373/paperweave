/**
 * Evidence tools: finding the passages that discuss something (with page numbers and surrounding text)
 * and extracting the same facts from several papers into a table, each with the page that supports it.
 * Read-only, like the other assistant tools.
 */
import { inArray, sql } from "drizzle-orm";
import { loadPaperText, relevantParts, type PaperText } from "@/server/ai/paper-text";
import { AIError, complete } from "@/server/ai/types";
import { db } from "@/server/db/client";
import { notes } from "@/server/db/schema";
import { semanticSearch } from "@/server/embeddings/search";
import { getPaperSummaries, getVisiblePaper } from "@/server/papers/service";
import { clean, paperSource, ToolInputError, type ToolContext, type ToolResult } from "./tools";

// ---------------------------------------------------------------------------
// Passages
// ---------------------------------------------------------------------------

const STOP = new Set(
  "a an and are as at be by for from has have how in into is it its of on or that the their this to was were what when which with does do not".split(
    " ",
  ),
);

/** Lower-case word stems (a crude prefix stem, so "segmentations" matches "segmenting"). */
export function terms(queries: string[]): string[] {
  const out = new Set<string>();
  for (const q of queries) {
    for (const w of q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []) {
      if (w.length < 3 || STOP.has(w)) continue;
      out.add(w.length > 5 ? w.slice(0, Math.max(5, w.length - 3)) : w);
    }
  }
  return [...out];
}

function countHits(text: string, stems: string[]) {
  const lower = text.toLowerCase();
  const hits = new Map<string, number>();
  for (const s of stems) {
    let n = 0;
    for (let i = lower.indexOf(s); i >= 0 && n < 10; i = lower.indexOf(s, i + s.length)) {
      // Only at the start of a word.
      if (i === 0 || !/[\p{L}\p{N}]/u.test(lower[i - 1])) n++;
    }
    if (n) hits.set(s, n);
  }
  return hits;
}

export interface Passage {
  /** Page (or section) number. */
  n: number;
  text: string;
  score: number;
}

/**
 * The best passage of a page for the query stems: a window of whole sentences (about 700 characters)
 * covering the most distinct stems, then the most hits.
 */
export function bestPassage(pageText: string, stems: string[], maxChars = 700): { text: string; score: number } | null {
  const sentences = pageText
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\d(])/u)
    .filter(Boolean);
  let best: { text: string; score: number } | null = null;
  for (let i = 0; i < sentences.length; i++) {
    let text = "";
    for (let j = i; j < sentences.length && (text + sentences[j]).length <= maxChars; j++) {
      text = text ? `${text} ${sentences[j]}` : sentences[j];
      const hits = countHits(text, stems);
      const score = hits.size * 10 + [...hits.values()].reduce((a, b) => a + Math.min(b, 3), 0);
      if (score && (!best || score > best.score)) best = { text, score };
    }
    if (!text && sentences[i]) {
      // A sentence longer than the window: take its start.
      const hits = countHits(sentences[i].slice(0, maxChars), stems);
      const score = hits.size * 10;
      if (score && (!best || score > best.score)) best = { text: `${sentences[i].slice(0, maxChars)}…`, score };
    }
  }
  return best;
}

/** Ranks the pages of one paper for the stems and returns its best passages. */
export function passagesOf(text: PaperText, stems: string[], limit: number): Passage[] {
  return text.parts
    .map((p) => {
      const best = bestPassage(p.text, stems);
      return best ? { n: p.n, text: best.text, score: best.score } : null;
    })
    .filter((p): p is Passage => !!p)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Pages of the workspace's PDFs matching any of the phrasings (PostgreSQL full-text search, OR-combined). */
async function libraryPages(workspaceId: string, queries: string[], limit: number) {
  const tsq = sql.join(
    queries.map((q) => sql`websearch_to_tsquery('english', ${q})`),
    sql` || `,
  );
  // Each word on its own as well, so a passage that words it differently still has a chance.
  const words = [
    ...new Set(
      queries.flatMap((q) =>
        (q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)),
      ),
    ),
  ].join(" or ");
  return db.execute<{ paper_id: string; page_number: number; text: string }>(sql`
    select f.paper_id, pg.page_number, pg.text
    from paper_file_pages pg
    join paper_files f on f.id = pg.file_id and f.workspace_id = ${workspaceId}
    where pg.search_vector @@ (${tsq} || websearch_to_tsquery('english', ${words}))
    order by ts_rank_cd(pg.search_vector, ${tsq}) desc, ts_rank_cd(pg.search_vector, websearch_to_tsquery('english', ${words})) desc
    limit ${limit}`);
}

/**
 * Passages that discuss something, with page numbers and the surrounding sentences: in the given papers
 * (their full text, also open-access copies not stored here), or across the PDFs in the library.
 * Several phrasings widen the search (synonyms, the paper's own terms).
 */
/** One candidate passage, from word search or meaning-based search, before the two are combined. */
interface Candidate {
  id: string;
  kind: "pdf" | "abstract" | "note";
  paperId: string | null;
  noteId: string | null;
  page: number | null;
  unit: string;
  text: string;
}

/**
 * Combines ranked lists (reciprocal rank fusion): a passage near the top of either list ranks high, and one
 * found by both ranks highest. Also notes which list found each passage.
 */
export function fuse(lists: Candidate[][], limit: number): (Candidate & { by: Set<number> })[] {
  const merged = new Map<string, Candidate & { by: Set<number>; score: number }>();
  lists.forEach((list, li) =>
    list.forEach((c, rank) => {
      const entry = merged.get(c.id) ?? { ...c, by: new Set<number>(), score: 0 };
      entry.score += 1 / (60 + rank);
      entry.by.add(li);
      merged.set(c.id, entry);
    }),
  );
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** A passage of a semantic hit: the part of the chunk with the query's words, else its start. */
const excerpt = (text: string, stems: string[]) =>
  bestPassage(text, stems)?.text ?? (text.length > 700 ? `${text.slice(0, 700)}…` : text);

/**
 * Passages that discuss something, with page numbers and the surrounding sentences: in the given papers
 * (their full text, also open-access copies not stored here), or across the library's PDFs, abstracts and
 * notes. Word matches and matches by meaning (local embeddings, when available) are combined, so
 * passages that word it differently are found too.
 */
export async function findPassages(
  ctx: ToolContext,
  input: { queries: string[]; papers?: string[]; limit?: number },
): Promise<ToolResult> {
  const queries = input.queries.map((q) => q.trim()).filter(Boolean);
  const stems = terms(queries);
  if (!stems.length) throw new ToolInputError("The query has no searchable words.");
  const limit = Math.min(15, Math.max(1, input.limit ?? 8));
  const what = queries.map((q) => `“${q}”`).join(" / ");
  const meaningQuery = queries.join("; ");

  if (input.papers?.length) {
    const keyword: Candidate[] = [];
    const missing: string[] = [];
    const ids: string[] = [];
    await Promise.all(
      input.papers.map(async (key) => {
        const source = paperSource(ctx, key);
        await getVisiblePaper(ctx.workspaceId, source.id);
        ids.push(source.id);
        const text = await loadPaperText(ctx.workspaceId, source.id);
        if (!text) {
          missing.push(key);
          return;
        }
        const unit = text.unit === "section" ? "section" : "p.";
        for (const p of passagesOf(text, stems, limit)) {
          keyword.push({
            id: `${source.id}:${p.n}`,
            kind: "pdf",
            paperId: source.id,
            noteId: null,
            page: p.n,
            unit,
            text: p.text,
          });
        }
      }),
    );
    keyword.sort((a, b) => (bestPassage(b.text, stems)?.score ?? 0) - (bestPassage(a.text, stems)?.score ?? 0));
    const meaning =
      (await semanticSearch(ctx.workspaceId, meaningQuery, { limit: limit * 2, kinds: ["pdf"], paperIds: ids })) ?? [];
    const results = fuse(
      [
        keyword,
        meaning.map((h) => ({
          id: `${h.paperId}:${h.page}`,
          kind: "pdf" as const,
          paperId: h.paperId,
          noteId: null,
          page: h.page,
          unit: "p.",
          text: excerpt(h.text, stems),
        })),
      ],
      limit,
    );
    const keyOf = new Map(input.papers.map((k) => [paperSource(ctx, k).id, paperSource(ctx, k).key]));
    const lines = results.map(
      (r) => `- ${keyOf.get(r.paperId!)} ${r.unit} ${r.page}${r.by.has(0) ? "" : " (matched by meaning)"}: “${r.text}”`,
    );
    if (missing.length) lines.push(`(No full text available for ${missing.join(", ")}: only the abstract.)`);
    return {
      report: results.length
        ? `Passages about ${what} in ${input.papers.join(", ")} (best first, with page numbers):\n${lines.join("\n")}`
        : `Passages about ${what} in ${input.papers.join(", ")}: none found.${missing.length ? `\n${lines.join("\n")}` : ""}`,
      count: results.length,
    };
  }

  const [pages, meaning] = await Promise.all([
    libraryPages(ctx.workspaceId, queries, 40),
    semanticSearch(ctx.workspaceId, meaningQuery, { limit: 30 }),
  ]);
  const keyword: Candidate[] = pages
    .map((pg) => ({ pg, best: bestPassage(pg.text, stems) }))
    .filter((r): r is { pg: (typeof pages)[number]; best: { text: string; score: number } } => !!r.best)
    .sort((a, b) => b.best.score - a.best.score)
    .map(({ pg, best }) => ({
      id: `${pg.paper_id}:${pg.page_number}`,
      kind: "pdf",
      paperId: pg.paper_id,
      noteId: null,
      page: pg.page_number,
      unit: "p.",
      text: best.text,
    }));
  const semantic: Candidate[] = (meaning ?? []).map((h) => ({
    id: h.kind === "pdf" ? `${h.paperId}:${h.page}` : h.kind === "note" ? `note:${h.noteId}` : `abstract:${h.paperId}`,
    kind: h.kind,
    paperId: h.paperId,
    noteId: h.noteId,
    page: h.page,
    unit: "p.",
    text: excerpt(h.text, stems),
  }));
  const results = fuse([keyword, semantic], limit);
  const paperIds = [...new Set(results.map((r) => r.paperId).filter((id): id is string => !!id))];
  const noteIds = [...new Set(results.map((r) => r.noteId).filter((id): id is string => !!id))];
  const [summaries, noteRows] = await Promise.all([
    getPaperSummaries(ctx.workspaceId, paperIds),
    noteIds.length ? db.select({ id: notes.id, title: notes.title }).from(notes).where(inArray(notes.id, noteIds)) : [],
  ]);
  const paperById = new Map(summaries.map((p) => [p.id, p]));
  const noteById = new Map(noteRows.map((n) => [n.id, n]));
  const lines: string[] = [];
  for (const r of results) {
    const how = r.by.has(0) ? "" : " (matched by meaning)";
    if (r.kind === "note") {
      const n = noteById.get(r.noteId!);
      if (!n) continue;
      const s = ctx.sources.add({ type: "note", id: n.id, title: n.title || "Untitled note" });
      lines.push(`- User's note ${s.key} "${clean(s.title, 80)}"${how}: “${r.text}”`);
      continue;
    }
    const p = paperById.get(r.paperId!);
    if (!p) continue;
    const s = ctx.sources.addPaper(p);
    lines.push(
      r.kind === "abstract"
        ? `- ${s.key} abstract ("${clean(p.title, 80)}"; no PDF here)${how}: “${r.text}”`
        : `- ${s.key} p. ${r.page} ("${clean(p.title, 80)}")${how}: “${r.text}”`,
    );
  }
  const scope = meaning ? "PDFs, abstracts and notes" : "PDFs";
  return {
    report: lines.length
      ? `Passages about ${what} in the user's ${scope} (best first${meaning ? "; words and meaning combined" : ""}):\n${lines.join("\n")}`
      : `Passages about ${what} in the user's ${scope}: none found (try other words, or search_library).`,
    count: lines.length,
  };
}

// ---------------------------------------------------------------------------
// Structured extraction
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = `You extract facts from a scientific paper for a comparison table. Use only the paper text given. Reply with a single JSON object and nothing else.`;

export interface FieldValue {
  value: string | null;
  page: number | null;
  quote: string | null;
}

/** Reads the model's JSON, keeping only the requested fields; anything unusable counts as not reported. */
export function parseFields(text: string, fields: string[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  let raw: Record<string, unknown> = {};
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const parsed = JSON.parse(text.slice(start, end + 1)) as { fields?: unknown };
    raw = (parsed.fields && typeof parsed.fields === "object" ? parsed.fields : parsed) as Record<string, unknown>;
  } catch {
    /* every field "not reported" */
  }
  const byLower = new Map(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const f of fields) {
    const v = byLower.get(f.toLowerCase()) as { value?: unknown; page?: unknown; quote?: unknown } | undefined;
    const value = typeof v?.value === "string" && v.value.trim() ? v.value.trim().slice(0, 300) : null;
    out[f] = {
      value,
      page: value && Number.isInteger(Number(v?.page)) && Number(v?.page) > 0 ? Number(v?.page) : null,
      quote: value && typeof v?.quote === "string" && v.quote.trim() ? v.quote.trim().slice(0, 300) : null,
    };
  }
  return out;
}

async function extractOne(ctx: ToolContext, key: string, fields: string[]) {
  const source = paperSource(ctx, key);
  const paper = await getVisiblePaper(ctx.workspaceId, source.id);
  const text = await loadPaperText(ctx.workspaceId, source.id);
  const body = text
    ? relevantParts(text, fields.join(", "), 24_000).body
    : `Title: ${paper.title}\nAbstract: ${paper.abstract ?? "(none)"}`;
  const prompt = `<paper title="${paper.title.replace(/"/g, "'")}" text="${text ? "full text, by page" : "abstract only"}">
${body}
</paper>

Fields to extract: ${JSON.stringify(fields)}

Reply with {"fields": {"<field>": {"value": "<short answer as stated in the paper; keep numbers, units and conditions exactly>", "page": <page number from the [Page N] markers, or null>, "quote": "<the supporting sentence, verbatim, at most 200 characters>"}, ...}}.
When the paper does not report a field, use {"value": null}. Do not guess or compute values the paper does not state.`;
  const reply = await complete(ctx.provider!, {
    system: EXTRACT_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    signal: ctx.signal,
  });
  return { key: source.key, fullText: !!text, values: parseFields(reply, fields) };
}

/** Runs `fn` over items with at most `n` at a time, keeping the order. */
async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ");

/**
 * The same fields extracted from each paper (datasets, metrics, results, compute…), as a table with the
 * supporting page and quote for every value, and "not reported" where a paper does not say.
 */
export async function extractFields(
  ctx: ToolContext,
  input: { papers: string[]; fields: string[] },
): Promise<ToolResult> {
  if (!ctx.provider) throw new ToolInputError("extract_fields needs the assistant's AI.");
  const fields = [...new Set(input.fields.map((f) => f.trim()).filter(Boolean))];
  const keys = [...new Set(input.papers.map((k) => k.trim().toUpperCase()))];
  const rows = await mapLimit(keys, 3, async (key) => {
    try {
      return await extractOne(ctx, key, fields);
    } catch (err) {
      if (err instanceof ToolInputError) throw err;
      if (ctx.signal?.aborted) throw err;
      const reason = err instanceof AIError ? err.message : "the AI could not read it";
      return { key, fullText: false, values: null, error: reason };
    }
  });
  const header = `| Field | ${rows.map((r) => r.key).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`;
  const body = fields
    .map(
      (f) =>
        `| ${cell(f)} | ${rows
          .map((r) => {
            const v = r.values?.[f];
            if (!r.values) return "(failed)";
            return v?.value ? cell(`${v.value}${v.page ? ` (p. ${v.page})` : ""}`) : "not reported";
          })
          .join(" | ")} |`,
    )
    .join("\n");
  const quotes = rows.flatMap((r) =>
    fields.flatMap((f) => {
      const v = r.values?.[f];
      return v?.quote ? [`- ${r.key} · ${f}${v.page ? ` (p. ${v.page})` : ""}: “${v.quote}”`] : [];
    }),
  );
  const notes = rows
    .map((r) =>
      "error" in r && r.error
        ? `${r.key}: extraction failed (${r.error}).`
        : !r.fullText
          ? `${r.key}: abstract only (no full text available).`
          : null,
    )
    .filter(Boolean);
  return {
    report: `Extracted fields (values as stated in each paper; "not reported" means the text read does not say):\n${header}\n${body}${
      quotes.length ? `\nSupporting quotes:\n${quotes.join("\n")}` : ""
    }${notes.length ? `\n${notes.join("\n")}` : ""}`,
    count: rows.length,
  };
}
