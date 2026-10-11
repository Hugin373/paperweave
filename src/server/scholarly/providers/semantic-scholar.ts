import { normalizeArxivId, normalizeDoi } from "@/lib/identifiers";
import { aclAnthologyPdf, serverCanFetchPdf } from "../free-pdf";
import { venueNames } from "../venues";
import { providerFetch, Throttle } from "../http";
import { normalizePublicationType } from "../publication-types";
import type {
  CitationEntry,
  CitationPage,
  IdentifierKind,
  NormalizedPaper,
  PaperRef,
  ScholarlyProvider,
  SearchPage,
  SearchRequest,
} from "../types";

const BASE = "https://api.semanticscholar.org/graph/v1";

const PAPER_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "abstract",
  "year",
  "publicationDate",
  "venue",
  "publicationVenue",
  "journal",
  "publicationTypes",
  "fieldsOfStudy",
  "authors",
  "citationCount",
  "referenceCount",
  "influentialCitationCount",
  "isOpenAccess",
  "openAccessPdf",
  "url",
].join(",");

// Nested papers in reference/citation lists support a smaller field set.
const NESTED_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "abstract",
  "year",
  "publicationDate",
  "venue",
  "publicationTypes",
  "fieldsOfStudy",
  "authors",
  "citationCount",
  "referenceCount",
  "influentialCitationCount",
  "isOpenAccess",
  "openAccessPdf",
  "url",
].join(",");

interface S2Paper {
  paperId: string | null;
  externalIds?: Record<string, string | number> | null;
  title?: string | null;
  abstract?: string | null;
  year?: number | null;
  publicationDate?: string | null;
  venue?: string | null;
  publicationVenue?: { name?: string } | null;
  journal?: { name?: string } | null;
  publicationTypes?: string[] | null;
  fieldsOfStudy?: string[] | null;
  authors?: { authorId: string | null; name: string }[] | null;
  citationCount?: number | null;
  referenceCount?: number | null;
  influentialCitationCount?: number | null;
  isOpenAccess?: boolean | null;
  openAccessPdf?: { url?: string | null } | null;
  url?: string | null;
}

interface S2CitationRow {
  contexts?: string[] | null;
  intents?: string[] | null;
  isInfluential?: boolean | null;
  citedPaper?: S2Paper;
  citingPaper?: S2Paper;
}

export function mapS2Paper(p: S2Paper): NormalizedPaper | null {
  if (!p.paperId || !p.title) return null;
  const ext = p.externalIds ?? {};
  const ids: NormalizedPaper["ids"] = { s2: p.paperId };
  const doi = normalizeDoi(ext.DOI ? String(ext.DOI) : null);
  if (doi) ids.doi = doi;
  const arxiv = normalizeArxivId(ext.ArXiv ? String(ext.ArXiv) : null);
  if (arxiv) ids.arxiv = arxiv;
  if (ext.PubMed) ids.pmid = String(ext.PubMed);
  if (ext.PubMedCentral) ids.pmcid = `PMC${String(ext.PubMedCentral).replace(/^PMC/i, "")}`;
  if (ext.CorpusId) ids.corpus = String(ext.CorpusId);
  // A reported "PDF" that a server cannot download (a DOI link, a bot-checked PMC link) is a read-free link.
  const reported = p.openAccessPdf?.url?.trim() || null;
  const pdf = (serverCanFetchPdf(reported) ? reported : null) || aclAnthologyPdf(doi, ext.ACL ? String(ext.ACL) : null);
  return {
    source: "semantic_scholar",
    ids,
    title: p.title.trim(),
    abstract: p.abstract?.trim() || null,
    year: p.year ?? null,
    publicationDate: p.publicationDate ?? null,
    venue: p.venue?.trim() || p.publicationVenue?.name || p.journal?.name || null,
    publicationTypes: [...new Set((p.publicationTypes ?? []).map(normalizePublicationType))],
    fieldsOfStudy: p.fieldsOfStudy ?? [],
    authors: (p.authors ?? [])
      .filter((a) => a.name)
      .map((a) => ({ name: a.name, ids: a.authorId ? { s2: a.authorId } : undefined })),
    citationCount: p.citationCount ?? null,
    referenceCount: p.referenceCount ?? null,
    influentialCitationCount: p.influentialCitationCount ?? null,
    isOpenAccess: p.isOpenAccess ?? (pdf ? true : null),
    openAccessPdfUrl: arxiv ? `https://arxiv.org/pdf/${arxiv}` : pdf || null,
    freeReadUrl: !arxiv && !pdf && reported ? reported : null,
    url: p.url ?? null,
  };
}

function toS2Id(ref: PaperRef): string {
  switch (ref.kind) {
    case "s2":
      return ref.value;
    case "doi":
      return `DOI:${ref.value}`;
    case "arxiv":
      return `ARXIV:${ref.value}`;
    case "pmid":
      return `PMID:${ref.value}`;
    case "corpus":
      return `CorpusId:${ref.value}`;
    default:
      throw new Error(`Semantic Scholar cannot resolve ${ref.kind}`);
  }
}

const S2_TYPE: Record<string, string> = {
  journal_article: "JournalArticle",
  conference: "Conference",
  review: "Review",
  book: "Book,BookSection",
};

export class SemanticScholarProvider implements ScholarlyProvider {
  readonly name = "semantic_scholar" as const;
  readonly lookupKinds: readonly IdentifierKind[] = ["s2", "doi", "arxiv", "pmid", "corpus"];
  readonly supportsSearch = true;
  readonly supportsCitations = true;
  private readonly throttle: Throttle;

  constructor(private readonly apiKey?: string) {
    // Keyed access is limited to ~1 request/second; the shared pool is bursty.
    this.throttle = new Throttle(apiKey ? 1050 : 300);
  }

  private get<T>(path: string) {
    return providerFetch<T>(`${BASE}${path}`, {
      provider: this.name,
      headers: this.apiKey ? { "x-api-key": this.apiKey } : undefined,
      throttle: this.throttle,
      retryShortLimit: true,
    });
  }

  async search(req: SearchRequest): Promise<SearchPage> {
    if (req.mode === "author") return this.searchByAuthor(req);
    if (req.sort === "citations") return this.mostCitedSearch(req);
    const params = new URLSearchParams({
      query: req.query,
      offset: String(req.offset),
      limit: String(req.limit),
      fields: PAPER_FIELDS,
    });
    const f = req.filters;
    if (f.yearFrom || f.yearTo) params.set("year", `${f.yearFrom ?? ""}-${f.yearTo ?? ""}`);
    if (f.openAccessOnly) params.set("openAccessPdf", "");
    if (f.minCitations) params.set("minCitationCount", String(f.minCitations));
    // Semantic Scholar matches any venue in a comma-separated list: the typed name and its full names.
    if (f.venue) params.set("venue", venueNames(f.venue).join(","));
    if (f.publicationType && S2_TYPE[f.publicationType]) params.set("publicationTypes", S2_TYPE[f.publicationType]);

    const data = await this.get<{ total?: number; data?: S2Paper[] }>(`/paper/search?${params}`);
    let papers = (data?.data ?? []).map(mapS2Paper).filter((p): p is NormalizedPaper => p !== null);
    if (f.publicationType === "preprint") papers = papers.filter((p) => p.ids.arxiv || p.publicationTypes.length === 0);

    if (req.mode === "title" && req.offset === 0) {
      const match = await this.get<{ data?: S2Paper[] }>(
        `/paper/search/match?${new URLSearchParams({ query: req.query, fields: PAPER_FIELDS })}`,
      ).catch(() => null);
      const best = match?.data?.[0] ? mapS2Paper(match.data[0]) : null;
      if (best) papers = [best, ...papers.filter((p) => p.ids.s2 !== best.ids.s2)];
    }
    return { provider: this.name, papers, total: data?.total ?? null };
  }

  /** Sorted batches of the bulk endpoint, reused across pages of the same search. */
  private readonly batches = new Map<string, { at: number; page: SearchPage }>();

  /**
   * Most-cited-first search via the bulk endpoint, which matches all query terms in title and
   * abstract and returns up to 1,000 sorted results per call. ("Newest first" is built on relevance
   * search by the discovery layer.)
   */
  private async mostCitedSearch(req: SearchRequest): Promise<SearchPage> {
    const f = req.filters;
    // The bulk query language treats + | - " * ( ) ~ as operators.
    const query = req.query
      .replace(/[+|\-"*()~]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const params = new URLSearchParams({ query, fields: PAPER_FIELDS, sort: "citationCount:desc" });
    if (f.yearFrom || f.yearTo) params.set("year", `${f.yearFrom ?? ""}-${f.yearTo ?? ""}`);
    if (f.openAccessOnly) params.set("openAccessPdf", "");
    if (f.minCitations) params.set("minCitationCount", String(f.minCitations));
    // Semantic Scholar matches any venue in a comma-separated list: the typed name and its full names.
    if (f.venue) params.set("venue", venueNames(f.venue).join(","));
    if (f.publicationType && S2_TYPE[f.publicationType]) params.set("publicationTypes", S2_TYPE[f.publicationType]);

    const key = params.toString();
    const hit = this.batches.get(key);
    let page = hit && Date.now() - hit.at < 30 * 60_000 ? hit.page : null;
    if (!page) {
      const data = await this.get<{ total?: number; data?: S2Paper[] }>(`/paper/search/bulk?${params}`);
      let papers = (data?.data ?? []).map(mapS2Paper).filter((p): p is NormalizedPaper => p !== null);
      if (f.publicationType === "preprint") papers = papers.filter((p) => p.ids.arxiv || !p.publicationTypes.length);
      page = { provider: this.name, papers, total: data?.total ?? papers.length };
      this.batches.set(key, { at: Date.now(), page });
      if (this.batches.size > 50) this.batches.delete(this.batches.keys().next().value!);
    }
    return {
      provider: this.name,
      papers: page.papers.slice(req.offset, req.offset + req.limit),
      // Only the first batch is fetched, so at most that many results can be paged through.
      total: Math.min(page.total ?? 0, page.papers.length),
    };
  }

  private async searchByAuthor(req: SearchRequest): Promise<SearchPage> {
    const authors = await this.get<{
      data?: { authorId: string; name: string; paperCount?: number; citationCount?: number }[];
    }>(
      `/author/search?${new URLSearchParams({ query: req.query, fields: "name,paperCount,citationCount", limit: "10" })}`,
    );
    const best = (authors?.data ?? []).sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0))[0];
    if (!best) return { provider: this.name, papers: [], total: 0 };
    // The author's papers, most cited first (the endpoint lists them by date): their main work leads,
    // and the odd misattributed paper in a big profile sinks to the end.
    const key = `author:${best.authorId}`;
    let all = this.batches.get(key)?.page.papers;
    if (!all) {
      const data = await this.get<{ data?: S2Paper[] }>(
        `/author/${best.authorId}/papers?${new URLSearchParams({ fields: PAPER_FIELDS, limit: "500" })}`,
      );
      all = (data?.data ?? [])
        .map(mapS2Paper)
        .filter((p): p is NormalizedPaper => p !== null)
        .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0));
      this.batches.set(key, { at: Date.now(), page: { provider: this.name, papers: all, total: all.length } });
    }
    return { provider: this.name, papers: all.slice(req.offset, req.offset + req.limit), total: all.length };
  }

  async getPaper(ref: PaperRef): Promise<NormalizedPaper | null> {
    const data = await this.get<S2Paper>(`/paper/${encodeURIComponent(toS2Id(ref))}?fields=${PAPER_FIELDS}`);
    return data ? mapS2Paper(data) : null;
  }

  private async list(ref: PaperRef, kind: "references" | "citations", offset: number, limit: number) {
    const fields = `contexts,intents,isInfluential,${NESTED_FIELDS}`;
    const data = await this.get<{ next?: number; data?: S2CitationRow[] }>(
      `/paper/${encodeURIComponent(toS2Id(ref))}/${kind}?${new URLSearchParams({
        fields,
        offset: String(offset),
        limit: String(limit),
      })}`,
    );
    const entries: CitationEntry[] = (data?.data ?? []).map((row) => {
      const raw = kind === "references" ? row.citedPaper : row.citingPaper;
      return {
        paper: raw ? mapS2Paper(raw) : null,
        rawTitle: raw?.title ?? null,
        isInfluential: row.isInfluential ?? null,
        intents: row.intents ?? [],
        contexts: row.contexts ?? [],
      };
    });
    const page: CitationPage = {
      provider: this.name,
      entries,
      total: null,
      hasMore: typeof data?.next === "number",
    };
    return page;
  }

  getReferences(ref: PaperRef, offset: number, limit: number) {
    return this.list(ref, "references", offset, limit);
  }

  getCitations(ref: PaperRef, offset: number, limit: number) {
    return this.list(ref, "citations", offset, limit);
  }
}
