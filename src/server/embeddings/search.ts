/**
 * Meaning-based search over a workspace's embedded texts. A personal library has thousands of chunks at
 * most, so the vectors are kept in memory per workspace (reloaded when rows change) and compared directly.
 */
import { and, count, eq, inArray, max } from "drizzle-orm";
import { db } from "@/server/db/client";
import { textEmbeddings } from "@/server/db/schema";
import { embedder } from "./embedder";

export interface SemanticHit {
  kind: "pdf" | "abstract" | "note";
  paperId: string | null;
  noteId: string | null;
  page: number | null;
  text: string;
  /** Cosine similarity (0..1 for related texts). */
  score: number;
}

interface Loaded {
  version: string;
  rows: {
    kind: SemanticHit["kind"];
    paperId: string | null;
    noteId: string | null;
    page: number | null;
    text: string;
  }[];
  vectors: Float32Array[];
}

const g = globalThis as unknown as { __pwVectors?: Map<string, Loaded> };
const cache = (g.__pwVectors ??= new Map());

async function vectorsOf(workspaceId: string, model: string): Promise<Loaded> {
  const [{ n, last }] = await db
    .select({ n: count(), last: max(textEmbeddings.id) })
    .from(textEmbeddings)
    .where(and(eq(textEmbeddings.workspaceId, workspaceId), eq(textEmbeddings.model, model)));
  const version = `${model}:${n}:${last ?? 0}`;
  const hit = cache.get(workspaceId);
  if (hit?.version === version) return hit;
  const rows = await db
    .select({
      kind: textEmbeddings.sourceKind,
      paperId: textEmbeddings.paperId,
      noteId: textEmbeddings.noteId,
      page: textEmbeddings.page,
      text: textEmbeddings.text,
      vector: textEmbeddings.vector,
    })
    .from(textEmbeddings)
    .where(and(eq(textEmbeddings.workspaceId, workspaceId), eq(textEmbeddings.model, model)));
  const loaded: Loaded = {
    version,
    rows: rows.map(({ vector: _v, ...r }) => r),
    vectors: rows.map((r) => Float32Array.from(r.vector)),
  };
  cache.set(workspaceId, loaded);
  return loaded;
}

/**
 * The texts closest in meaning to the query (best first), optionally only some kinds or papers. Null when
 * meaning-based search is not available (then callers use word search alone).
 */
export async function semanticSearch(
  workspaceId: string,
  query: string,
  opts: { limit?: number; kinds?: SemanticHit["kind"][]; paperIds?: string[] } = {},
): Promise<SemanticHit[] | null> {
  const e = await embedder();
  if (!e) return null;
  const { rows, vectors } = await vectorsOf(workspaceId, e.model);
  if (!rows.length) return [];
  const q = Float32Array.from(await e.query(query));
  const kinds = opts.kinds ? new Set(opts.kinds) : null;
  const papers = opts.paperIds ? new Set(opts.paperIds) : null;
  const scored: { i: number; score: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (kinds && !kinds.has(r.kind)) continue;
    if (papers && (!r.paperId || !papers.has(r.paperId))) continue;
    const v = vectors[i];
    let dot = 0;
    for (let k = 0; k < v.length; k++) dot += v[k] * q[k];
    scored.push({ i, score: dot });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 10)
    .map(({ i, score }) => ({ ...rows[i], score }));
}

/** Whether a workspace has any embedded text for these papers (so callers know a search can find them). */
export async function hasEmbeddings(workspaceId: string, paperIds: string[]) {
  if (!paperIds.length) return false;
  const [row] = await db
    .select({ n: count() })
    .from(textEmbeddings)
    .where(and(eq(textEmbeddings.workspaceId, workspaceId), inArray(textEmbeddings.paperId, paperIds)));
  return (row?.n ?? 0) > 0;
}
