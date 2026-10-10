import type { PaperAuthor } from "@/server/db/schema";

export type IdentifierKind = "doi" | "arxiv" | "s2" | "openalex" | "pmid" | "pmcid" | "corpus" | "openreview";
export type ProviderName = "semantic_scholar" | "openalex" | "crossref" | "arxiv" | "europepmc" | "openreview";

/**
 * Where a literature search runs: "general" (Semantic Scholar / OpenAlex, every field), "biomedical"
 * (Europe PMC: PubMed, PubMed Central, medRxiv/bioRxiv) or "openreview" (ML venues on OpenReview).
 */
export const SEARCH_SOURCES = ["general", "biomedical", "openreview"] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

export type PaperIds = Partial<Record<IdentifierKind, string>>;

/** A paper as described by one external source, normalized to the app's vocabulary. */
export interface NormalizedPaper {
  source: ProviderName;
  ids: PaperIds;
  title: string;
  abstract: string | null;
  year: number | null;
  publicationDate: string | null;
  venue: string | null;
  publicationTypes: string[];
  fieldsOfStudy: string[];
  authors: PaperAuthor[];
  citationCount: number | null;
  referenceCount: number | null;
  influentialCitationCount: number | null;
  isOpenAccess: boolean | null;
  openAccessPdfUrl: string | null;
  /** A page where the paper is free to read when no PDF can be downloaded (e.g. PubMed Central). */
  freeReadUrl?: string | null;
  url: string | null;
}

/** One entry of a reference or citation list. `paper` is null when the source could not resolve it. */
export interface CitationEntry {
  paper: NormalizedPaper | null;
  /** Title of an unresolved reference, when available. */
  rawTitle?: string | null;
  isInfluential: boolean | null;
  intents: string[];
  contexts: string[];
}

export interface CitationPage {
  provider: ProviderName;
  entries: CitationEntry[];
  /** Total number of entries known to the provider, when reported. */
  total: number | null;
  hasMore: boolean;
}

export interface SearchFilters {
  yearFrom?: number;
  yearTo?: number;
  openAccessOnly?: boolean;
  minCitations?: number;
  venue?: string;
  publicationType?: PublicationTypeFilter;
  /** OpenReview: also papers still under double-blind review (anonymous; no free PDF). */
  includeUnderReview?: boolean;
}

export const PUBLICATION_TYPE_FILTERS = ["journal_article", "conference", "preprint", "review", "book"] as const;
export type PublicationTypeFilter = (typeof PUBLICATION_TYPE_FILTERS)[number];

export type SearchMode = "all" | "title" | "author";

/** Result order: search relevance (default), newest publication first, or most cited first. */
export const SEARCH_SORTS = ["relevance", "newest", "citations"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export interface SearchRequest {
  query: string;
  mode: SearchMode;
  filters: SearchFilters;
  offset: number;
  limit: number;
  sort?: SearchSort;
  source?: SearchSource;
  /** Europe PMC: also match full texts (used when titles and abstracts find too little). */
  scope?: "fulltext";
}

export interface SearchPage {
  provider: ProviderName;
  papers: NormalizedPaper[];
  total: number | null;
}

export interface PaperRef {
  kind: IdentifierKind;
  value: string;
}

export interface ScholarlyProvider {
  readonly name: ProviderName;
  /** Which identifier kinds this provider can resolve, in order of preference. */
  readonly lookupKinds: readonly IdentifierKind[];
  readonly supportsSearch: boolean;
  readonly supportsCitations: boolean;
  search?(req: SearchRequest): Promise<SearchPage>;
  getPaper(ref: PaperRef): Promise<NormalizedPaper | null>;
  getReferences?(ref: PaperRef, offset: number, limit: number): Promise<CitationPage>;
  getCitations?(ref: PaperRef, offset: number, limit: number): Promise<CitationPage>;
  /** Most recently posted papers matching the query (arXiv). */
  searchLatest?(query: string, limit: number): Promise<NormalizedPaper[]>;
  /** Papers whose title matches (arXiv; used to find the preprint of a paper known from elsewhere). */
  searchTitle?(title: string, limit: number): Promise<NormalizedPaper[]>;
  /** The newest version number of a preprint (arXiv), or null when unknown. */
  latestVersion?(id: string): Promise<number | null>;
}

export type ProviderErrorKind = "rate_limited" | "unavailable" | "bad_response";

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
