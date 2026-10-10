import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { CitationListResponse, IdentifierMap } from "@/lib/types";
import { db } from "@/server/db/client";
import { citations, papers } from "@/server/db/schema";
import { scholarly } from "@/server/scholarly/service";
import type { CitationEntry, CitationPage, NormalizedPaper, PaperIds } from "@/server/scholarly/types";
import { ingestPapers } from "./ingest";
import { getPaperSummaries, getVisiblePaper, identifiersFor } from "./service";

export type CitationDirection = "references" | "citations";

/** References are fetched in one large page; citation lists are paginated. */
export const REFERENCE_PAGE = 500;
export const CITATION_PAGE = 100;

async function fetchPage(direction: CitationDirection, ids: IdentifierMap, offset: number, limit: number) {
  const s = scholarly();
  return direction === "references"
    ? s.references(ids as PaperIds, offset, limit)
    : s.citations(ids as PaperIds, offset, limit);
}

/**
 * Stores the citation edges of a fetched page. Edges come exclusively from scholarly sources.
 */
async function storeEdges(
  direction: CitationDirection,
  paperId: string,
  page: CitationPage,
  resolved: { entry: CitationEntry; id: string }[],
) {
  // Several entries can resolve to the same paper (e.g. its preprint and published versions, which are
  // merged). One insert may not touch a row twice, so such entries are combined first.
  const byPair = new Map<
    string,
    {
      citingPaperId: string;
      citedPaperId: string;
      isInfluential: boolean | null;
      intents: string[];
      contexts: string[];
      source: CitationPage["provider"];
    }
  >();
  for (const { entry, id } of resolved) {
    if (id === paperId) continue;
    const seen = byPair.get(id);
    if (seen) {
      seen.isInfluential =
        seen.isInfluential === null && entry.isInfluential === null
          ? null
          : !!seen.isInfluential || !!entry.isInfluential;
      seen.intents = [...new Set([...seen.intents, ...entry.intents])];
      seen.contexts = [...new Set([...seen.contexts, ...entry.contexts])].slice(0, 5);
      continue;
    }
    byPair.set(id, {
      citingPaperId: direction === "references" ? paperId : id,
      citedPaperId: direction === "references" ? id : paperId,
      isInfluential: entry.isInfluential,
      intents: entry.intents,
      contexts: entry.contexts.slice(0, 5),
      source: page.provider,
    });
  }
  const rows = [...byPair.values()];
  if (!rows.length) return;
  await db
    .insert(citations)
    .values(rows)
    .onConflictDoUpdate({
      target: [citations.citingPaperId, citations.citedPaperId],
      set: {
        isInfluential: sql`coalesce(excluded.is_influential, ${citations.isInfluential})`,
        intents: sql`case when cardinality(excluded.intents) > 0 then excluded.intents else ${citations.intents} end`,
        contexts: sql`case when cardinality(excluded.contexts) > 0 then excluded.contexts else ${citations.contexts} end`,
      },
    });
}

/** Fetches, ingests and stores one page of references or citations for a paper. */
export async function syncCitationPage(
  paperId: string,
  direction: CitationDirection,
  offset: number,
  limit: number,
): Promise<{ page: CitationPage | null; resolved: { entry: CitationEntry; id: string }[] }> {
  const ids = (await identifiersFor([paperId])).get(paperId) ?? {};
  if (!Object.keys(ids).length) return { page: null, resolved: [] };
  const page = await fetchPage(direction, ids, offset, limit);
  if (!page) return { page: null, resolved: [] };

  const withPaper = page.entries.filter((e): e is CitationEntry & { paper: NormalizedPaper } => e.paper !== null);
  const internalIds = await ingestPapers(withPaper.map((e) => e.paper));
  const resolved = withPaper.map((entry, i) => ({ entry, id: internalIds[i] }));
  await storeEdges(direction, paperId, page, resolved);
  if (direction === "references" && offset === 0 && !page.hasMore) {
    await db.update(papers).set({ referencesSyncedAt: new Date() }).where(eq(papers.id, paperId));
  }
  return { page, resolved };
}

export async function listCitationEdges(
  workspaceId: string,
  paperId: string,
  direction: CitationDirection,
  offset: number,
): Promise<CitationListResponse> {
  const paper = await getVisiblePaper(workspaceId, paperId);
  if (paper.ownerWorkspaceId !== null) {
    return { items: [], total: 0, hasMore: false, nextOffset: 0, provider: null };
  }
  const limit = direction === "references" ? REFERENCE_PAGE : CITATION_PAGE;
  const { page, resolved } = await syncCitationPage(paperId, direction, offset, limit);
  if (!page) return { items: [], total: 0, hasMore: false, nextOffset: offset, provider: null };

  const summaries = await getPaperSummaries(
    workspaceId,
    resolved.map((r) => r.id),
  );
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const idByEntry = new Map(resolved.map((r) => [r.entry, r.id]));
  const seen = new Set<string>();
  const items = page.entries
    .map((entry) => {
      const id = idByEntry.get(entry);
      const summary = id ? (byId.get(id) ?? null) : null;
      return {
        paper: summary,
        rawTitle: entry.paper?.title ?? entry.rawTitle ?? null,
        isInfluential: entry.isInfluential,
        intents: entry.intents,
        contexts: entry.contexts,
      };
    })
    .filter((item) => {
      if (!item.paper) return !!item.rawTitle;
      if (item.paper.id === paperId || seen.has(item.paper.id)) return false;
      seen.add(item.paper.id);
      return true;
    });

  const total = page.total ?? (direction === "references" ? paper.referenceCount : paper.citationCount);
  return {
    items,
    total,
    hasMore: page.hasMore,
    nextOffset: offset + limit,
    provider: page.provider,
  };
}

/** Citation edges among a set of papers (used by graphs). */
export async function edgesAmong(paperIds: string[]) {
  if (paperIds.length < 2) return [];
  return db
    .select({ citing: citations.citingPaperId, cited: citations.citedPaperId })
    .from(citations)
    .where(and(inArray(citations.citingPaperId, paperIds), inArray(citations.citedPaperId, paperIds)));
}

/** Stored metadata about the edge between two papers, in either direction. */
export async function getCitationEdge(a: string, b: string) {
  const [row] = await db
    .select()
    .from(citations)
    .where(
      or(
        and(eq(citations.citingPaperId, a), eq(citations.citedPaperId, b)),
        and(eq(citations.citingPaperId, b), eq(citations.citedPaperId, a)),
      ),
    );
  return row ?? null;
}
