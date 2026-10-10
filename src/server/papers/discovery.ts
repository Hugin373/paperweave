import { detectIdentifier, normalizeAuthorFamilyName, normalizeTitle } from "@/lib/identifiers";
import { interpretQuery } from "@/lib/query";
import type { SearchResponse } from "@/lib/types";
import { scholarly } from "@/server/scholarly/service";
import type { NormalizedPaper, SearchFilters, SearchMode, SearchSort, SearchSource } from "@/server/scholarly/types";
import { ingestPapers } from "./ingest";
import { getPaperSummaries, resolveIdentifier } from "./service";

export interface DiscoveryInput {
  q: string;
  mode: SearchMode;
  filters: SearchFilters;
  offset: number;
  limit: number;
  /** Skip the deterministic question → keywords rewrite. */
  exact?: boolean;
  sort?: SearchSort;
  source?: SearchSource;
  /** Skip cached results (saved searches checking for new papers). */
  fresh?: boolean;
}

const LATEST_PREPRINTS = 5;
/** "Newest first" orders the most relevant results within this many of the top hits by date. */
const NEWEST_POOL = 100;

const dateOf = (p: NormalizedPaper) => p.publicationDate ?? (p.year ? `${p.year}` : "");

/**
 * Newest first: the most relevant papers from recent years (the last two, unless a year filter is
 * set), ordered by publication date. Pure date sorting would surface any recent paper that merely
 * mentions the query words. Future-dated records (journal issues dated ahead) are left out.
 */
async function newestPage(query: string, input: DiscoveryInput) {
  const thisYear = new Date().getFullYear();
  const filters = {
    ...input.filters,
    yearFrom: input.filters.yearFrom ?? (input.filters.yearTo ? undefined : thisYear - 1),
  };
  const pool = await scholarly().search(
    { query, mode: input.mode, filters, offset: 0, limit: NEWEST_POOL },
    { fresh: input.fresh },
  );
  const today = new Date().toISOString().slice(0, 10);
  const sorted = pool.papers.filter((p) => dateOf(p) <= today).sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
  return {
    provider: pool.provider,
    papers: sorted.slice(input.offset, input.offset + input.limit),
    total: sorted.length,
  };
}

/**
 * Relevance ranking of keyword search engines can bury a paper whose exact title the user typed
 * (e.g. "attention is all you need"). When the first result is not an exact title match, look
 * the title up directly and move exact matches to the top.
 */
async function promoteExactTitle(query: string, filters: SearchFilters, papers: NormalizedPaper[]) {
  const target = normalizeTitle(query);
  const words = target.split(" ").length;
  if (words < 3 || words > 30) return papers;
  if (papers[0] && normalizeTitle(papers[0].title) === target) return papers;
  try {
    const titled = await scholarly().search({ query, mode: "title", filters, offset: 0, limit: 5 });
    const exact = titled.papers.filter((p) => normalizeTitle(p.title) === target);
    if (!exact.length) return papers;
    const key = (p: NormalizedPaper) => p.ids.s2 ?? p.ids.openalex ?? p.ids.doi ?? p.title;
    const seen = new Set(exact.map(key));
    return [...exact, ...papers.filter((p) => !seen.has(key(p)))];
  } catch {
    return papers;
  }
}

/**
 * One entry per work: sources often list a preprint and its published version (different DOIs, so they
 * stay separate papers) with the same title and first author. The first (best-ranked) one is kept.
 */
export function oneVersionEach<T extends { title: string; authors: string[] }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const key = `${normalizeTitle(p.title)}|${normalizeAuthorFamilyName(p.authors[0])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Scholarly discovery search: external literature, normalized and de-duplicated. */
export async function discover(workspaceId: string, input: DiscoveryInput): Promise<SearchResponse> {
  const identifier = detectIdentifier(input.q);
  if (identifier) {
    const paperId = await resolveIdentifier(input.q);
    const items = paperId ? await getPaperSummaries(workspaceId, [paperId]) : [];
    return {
      items,
      total: items.length,
      offset: 0,
      limit: input.limit,
      provider: "identifier",
      identifier,
    };
  }

  const { query, rewritten } =
    input.exact || input.mode !== "all" ? { query: input.q.trim(), rewritten: false } : interpretQuery(input.q);
  const sort = input.sort ?? "relevance";
  const source = input.source ?? "general";
  const general = source === "general";
  // Newest first also checks arXiv, which lists preprints the day they are posted. (Europe PMC
  // already includes medRxiv/bioRxiv, and sorts by date natively, as does the OpenReview source.)
  const wantPreprints = general && sort === "newest" && input.offset === 0 && input.mode === "all";
  const [page, preprints] = await Promise.all([
    general && sort === "newest"
      ? newestPage(query, input)
      : scholarly().search(
          { source, query, mode: input.mode, filters: input.filters, offset: input.offset, limit: input.limit, sort },
          { fresh: input.fresh },
        ),
    wantPreprints
      ? scholarly()
          .latestPreprints(query, LATEST_PREPRINTS, input.fresh)
          .catch(() => [] as NormalizedPaper[])
      : Promise.resolve([] as NormalizedPaper[]),
  ]);
  const records =
    general && input.offset === 0 && input.mode === "all" && sort === "relevance"
      ? await promoteExactTitle(query, input.filters, page.papers)
      : page.papers;
  const ids = await ingestPapers(records);
  const items = oneVersionEach(await getPaperSummaries(workspaceId, ids));
  let latestPreprints: SearchResponse["latestPreprints"];
  if (wantPreprints && preprints.length) {
    const shown = new Set(ids);
    const preprintIds = (await ingestPapers(preprints)).filter((id) => !shown.has(id));
    latestPreprints = await getPaperSummaries(workspaceId, [...new Set(preprintIds)]);
  }
  return {
    items,
    total: page.total,
    offset: input.offset,
    limit: input.limit,
    provider: page.provider,
    interpretedQuery: rewritten ? query : undefined,
    latestPreprints,
  };
}
