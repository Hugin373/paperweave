import {
  normalizeArxivId,
  normalizeAuthorFamilyName,
  normalizeDoi,
  normalizeOpenAlexId,
  normalizePmcid,
  normalizePmid,
  normalizeTitle,
} from "@/lib/identifiers";
import { aclAnthologyPdf, serverCanFetchPdf } from "../free-pdf";
import { venueNames } from "../venues";
import { providerFetch, Throttle } from "../http";
import { normalizePublicationType } from "../publication-types";
import type {
  CitationPage,
  IdentifierKind,
  NormalizedPaper,
  PaperRef,
  ScholarlyProvider,
  SearchPage,
  SearchRequest,
} from "../types";

const BASE = "https://api.openalex.org";
const SELECT = [
  "id",
  "doi",
  "display_name",
  "publication_year",
  "publication_date",
  "ids",
  "authorships",
  "primary_location",
  "best_oa_location",
  "open_access",
  "cited_by_count",
  "referenced_works_count",
  "abstract_inverted_index",
  "type",
  "primary_topic",
  "locations",
].join(",");

interface OALocation {
  landing_page_url?: string | null;
  pdf_url?: string | null;
  is_oa?: boolean | null;
  source?: { id?: string; display_name?: string | null; type?: string | null } | null;
}

interface OAWork {
  id: string;
  doi?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  ids?: Record<string, string>;
  authorships?: {
    author?: { id?: string | null; display_name?: string | null; orcid?: string | null };
    raw_author_name?: string | null;
  }[];
  primary_location?: OALocation | null;
  best_oa_location?: OALocation | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null } | null;
  cited_by_count?: number | null;
  referenced_works_count?: number | null;
  referenced_works?: string[];
  abstract_inverted_index?: Record<string, number[]> | null;
  type?: string | null;
  primary_topic?: { field?: { display_name?: string } | null } | null;
  locations?: OALocation[] | null;
}

interface OAList {
  meta?: { count?: number };
  results?: OAWork[];
}

/**
 * An author name without affiliation text that some records carry in the name field
 * ("Agustín Halty, 1 Facultad de Ingeniería, Universidad de la República, …").
 */
export function cleanAuthorName(raw: string | null | undefined): string | null {
  const name = raw?.replace(/\s+/g, " ").trim();
  if (!name) return null;
  const first = name.split(/\s*[,;]\s*/)[0];
  return name.includes(",") && (/\d/.test(name) || name.length > 60) ? first || null : name;
}

/** OpenAlex ships abstracts as an inverted index (word → positions). */
export function rebuildAbstract(index: Record<string, number[]> | null | undefined): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  const text = words.filter(Boolean).join(" ").trim();
  return text || null;
}

/** A source (journal, conference) or publisher from OpenAlex's lists. */
interface OAVenue {
  id: string;
  display_name?: string | null;
  abbreviated_title?: string | null;
  alternate_titles?: string[] | null;
  works_count?: number | null;
}

const venueKey = (s: string) => normalizeTitle(s.replace(/&/g, " and ")).replace(/^the /, "").trim();

/**
 * Which OpenAlex sources or publishers a typed venue means (ids, most works first). "exact": a name, short
 * name or alternate name equals it ("ECCV", "Nature"). "publisher": a publisher named by it ("Frontiers" →
 * Frontiers Media SA, "IEEE" → Institute of Electrical and Electronics Engineers). "similar": names that
 * contain all its words ("frontiers aging" → Frontiers in Aging Neuroscience).
 */
export function pickVenues(input: string, venues: OAVenue[], how: "exact" | "publisher" | "similar"): string[] {
  const want = venueKey(input);
  if (!want) return [];
  // "Annual Meeting of the Association for Computational Linguistics (ACL)" also goes by its name without the
  // bracket, and by "ACL".
  const names = (v: OAVenue) =>
    [v.display_name, v.abbreviated_title, ...(v.alternate_titles ?? [])]
      .filter((n): n is string => !!n)
      .flatMap((n) => {
        const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(n);
        return m ? [n, m[1], m[2]] : [n];
      })
      .map(venueKey);
  const words = want.split(" ");
  const matches = venues.filter((v) => {
    const all = names(v);
    if (how === "exact") return all.includes(want);
    if (how === "publisher") return all.some((n) => n === want || n.startsWith(`${want} `));
    return all.some((n) => words.every((w) => n.split(" ").includes(w)));
  });
  return matches
    .sort((a, b) => (b.works_count ?? 0) - (a.works_count ?? 0))
    .slice(0, how === "similar" ? 20 : 10)
    .map((v) => v.id.split("/").pop()!)
    .filter(Boolean);
}

function arxivFromWork(w: OAWork): string | null {
  const fromDoi = w.doi && /10\.48550\/arxiv\./i.test(w.doi) ? normalizeArxivId(w.doi) : null;
  if (fromDoi) return fromDoi;
  for (const loc of w.locations ?? []) {
    const url = loc.landing_page_url ?? loc.pdf_url;
    if (url && /arxiv\.org\/(abs|pdf)\//i.test(url)) {
      const id = normalizeArxivId(url);
      if (id) return id;
    }
  }
  return null;
}

export function mapOpenAlexWork(w: OAWork): NormalizedPaper | null {
  const openalex = normalizeOpenAlexId(w.id);
  const title = w.display_name?.replace(/<[^>]+>/g, "").trim();
  if (!openalex || !title) return null;
  const ids: NormalizedPaper["ids"] = { openalex };
  const doi = normalizeDoi(w.doi);
  const arxiv = arxivFromWork(w);
  if (doi && !/^10\.48550\/arxiv\./.test(doi)) ids.doi = doi;
  if (arxiv) ids.arxiv = arxiv;
  const pmid = normalizePmid(w.ids?.pmid?.replace(/\/$/, ""));
  if (pmid) ids.pmid = pmid;
  const pmcid = normalizePmcid(w.ids?.pmcid);
  if (pmcid) ids.pmcid = pmcid;

  const source = w.primary_location?.source;
  let type = normalizePublicationType(w.type ?? "other");
  if (type === "journal_article" && source?.type === "conference") type = "conference";
  if (type === "journal_article" && source?.type === "repository") type = "preprint";

  // arXiv's own PDF is the most reliable open copy when the work is on arXiv.
  const pdf =
    (arxiv ? `https://arxiv.org/pdf/${arxiv}` : null) ??
    [w.best_oa_location?.pdf_url, ...(w.locations ?? []).filter((l) => l.is_oa).map((l) => l.pdf_url)].find((u) =>
      serverCanFetchPdf(u),
    ) ??
    aclAnthologyPdf(doi);

  return {
    source: "openalex",
    ids,
    title,
    abstract: rebuildAbstract(w.abstract_inverted_index),
    year: w.publication_year ?? null,
    publicationDate: w.publication_date ?? null,
    venue: source?.display_name ?? null,
    publicationTypes: [type],
    fieldsOfStudy: w.primary_topic?.field?.display_name ? [w.primary_topic.field.display_name] : [],
    authors: (w.authorships ?? [])
      .map((a) => {
        const name = cleanAuthorName(a.author?.display_name ?? a.raw_author_name);
        if (!name) return null;
        const authorIds: Record<string, string> = {};
        const aid = a.author?.id?.split("/").pop();
        if (aid) authorIds.openalex = aid;
        const orcid = a.author?.orcid?.split("/").pop();
        if (orcid) authorIds.orcid = orcid;
        return { name, ids: Object.keys(authorIds).length ? authorIds : undefined };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null),
    citationCount: w.cited_by_count ?? null,
    referenceCount: w.referenced_works_count ?? null,
    influentialCitationCount: null,
    isOpenAccess: w.open_access?.is_oa ?? null,
    openAccessPdfUrl: pdf ?? null,
    url: w.primary_location?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : null),
  };
}

const OA_TYPE: Record<string, string> = {
  journal_article: "article",
  preprint: "preprint",
  review: "review",
  book: "book|book-chapter",
  conference: "article",
};

export class OpenAlexProvider implements ScholarlyProvider {
  readonly name = "openalex" as const;
  readonly lookupKinds: readonly IdentifierKind[] = ["openalex", "doi", "pmid", "pmcid"];
  readonly supportsSearch = true;
  readonly supportsCitations = true;
  private readonly throttle = new Throttle(110);

  constructor(
    private readonly contactEmail?: string,
    private readonly apiKey?: string,
  ) {}

  private url(path: string, params: Record<string, string> = {}) {
    const p = new URLSearchParams(params);
    if (this.contactEmail) p.set("mailto", this.contactEmail);
    if (this.apiKey) p.set("api_key", this.apiKey);
    const qs = p.toString();
    return `${BASE}${path}${qs ? `?${qs}` : ""}`;
  }

  private get<T>(path: string, params?: Record<string, string>) {
    return providerFetch<T>(this.url(path, params), {
      provider: this.name,
      throttle: this.throttle,
      retryShortLimit: true,
    });
  }

  /**
   * The works filter for a venue: the journals or conferences it names, all journals of a publisher it
   * names ("Frontiers", "Springer Nature", "IEEE"), or else the journals whose names contain it.
   */
  private async venueFilter(venue: string): Promise<string | null> {
    const findSources = async (name: string) =>
      (
        await this.get<{ results?: OAVenue[] }>("/sources", {
          search: name,
          "per-page": "50",
          select: "id,display_name,abbreviated_title,alternate_titles,works_count",
        })
      )?.results ?? [];
    const [typed, ...fullNames] = venueNames(venue);
    const sources = await findSources(typed);
    // A known short name ("NeurIPS", "ACL") is matched through the full names it stands for first: as a bare
    // abbreviation it may also be another journal's ("ACL" is also Advanced Chemistry Letters).
    const exact = new Set<string>();
    for (const name of fullNames) for (const id of pickVenues(name, await findSources(name), "exact")) exact.add(id);
    if (!exact.size) for (const id of pickVenues(typed, sources, "exact")) exact.add(id);
    if (exact.size) return `primary_location.source.id:${[...exact].slice(0, 20).join("|")}`;
    const publishers = await this.get<{ results?: OAVenue[] }>("/publishers", {
      search: venue,
      "per-page": "10",
      select: "id,display_name,alternate_titles,works_count",
    });
    const publisher = pickVenues(venue, publishers?.results ?? [], "publisher")[0];
    if (publisher) return `primary_location.source.publisher_lineage:${publisher}`;
    const similar = pickVenues(venue, sources, "similar");
    return similar.length ? `primary_location.source.id:${similar.join("|")}` : null;
  }

  private async resolveAuthorId(name: string): Promise<string | null> {
    const data = await this.get<{ results?: { id: string; cited_by_count?: number }[] }>("/authors", {
      search: name,
      "per-page": "5",
      select: "id,cited_by_count",
    });
    const best = (data?.results ?? []).sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0))[0];
    return best?.id.split("/").pop() ?? null;
  }

  async search(req: SearchRequest): Promise<SearchPage> {
    const filters: string[] = [];
    const f = req.filters;
    if (f.yearFrom && f.yearTo) filters.push(`publication_year:${f.yearFrom}-${f.yearTo}`);
    else if (f.yearFrom) filters.push(`publication_year:>${f.yearFrom - 1}`);
    else if (f.yearTo) filters.push(`publication_year:<${f.yearTo + 1}`);
    if (f.openAccessOnly) filters.push("is_oa:true");
    if (f.minCitations) filters.push(`cited_by_count:>${f.minCitations - 1}`);
    if (f.publicationType && OA_TYPE[f.publicationType]) filters.push(`type:${OA_TYPE[f.publicationType]}`);
    if (f.publicationType === "conference") filters.push("primary_location.source.type:conference");
    if (f.venue) {
      const venueFilter = await this.venueFilter(f.venue);
      if (!venueFilter) return { provider: this.name, papers: [], total: 0 };
      filters.push(venueFilter);
    }

    const params: Record<string, string> = {
      "per-page": String(req.limit),
      page: String(Math.floor(req.offset / req.limit) + 1),
      select: SELECT,
    };
    const clean = req.query.replace(/[,:|]/g, " ").trim();
    if (req.mode === "author") {
      const authorId = await this.resolveAuthorId(req.query);
      if (!authorId) return { provider: this.name, papers: [], total: 0 };
      filters.push(`authorships.author.id:${authorId}`);
      params.sort = "cited_by_count:desc";
    } else if (req.mode === "title") {
      filters.push(`title.search:${clean}`);
      params.sort = "cited_by_count:desc";
    } else if (req.sort === "citations") {
      // Sorted results match title and abstract (full-text matches would add noise without ranking).
      filters.push(`title_and_abstract.search:${clean}`);
      params.sort = "cited_by_count:desc";
    } else {
      // Relevance within titles and abstracts: OpenAlex's default search also matches full texts, where
      // every word of a short query appears in unrelated papers ("point cloud completion" → cloud computing).
      const scoped = await this.works({
        ...params,
        filter: [...filters, `title_and_abstract.search:${clean}`].join(","),
        sort: "relevance_score:desc",
      });
      // Only when titles and abstracts have nothing is the (noisier) full text worth searching.
      if (scoped.papers.length > 0 || req.offset > 0) return scoped;
      params.search = clean;
    }
    if (filters.length) params.filter = filters.join(",");
    return this.works(params);
  }

  private async works(params: Record<string, string>): Promise<SearchPage> {
    const data = await this.get<OAList>("/works", params);
    const papers = (data?.results ?? []).map(mapOpenAlexWork).filter((p): p is NormalizedPaper => p !== null);
    return { provider: this.name, papers, total: data?.meta?.count ?? null };
  }

  private async getWork(ref: PaperRef, select = SELECT): Promise<OAWork | null> {
    switch (ref.kind) {
      case "openalex":
        return this.get<OAWork>(`/works/${ref.value}`, { select });
      case "doi":
        return this.get<OAWork>(`/works/doi:${ref.value}`, { select });
      case "pmid":
        return this.get<OAWork>(`/works/pmid:${ref.value}`, { select });
      case "pmcid":
        return this.get<OAWork>(`/works/pmcid:${ref.value}`, { select });
      default:
        return null;
    }
  }

  async getPaper(ref: PaperRef): Promise<NormalizedPaper | null> {
    const w = await this.getWork(ref);
    return w ? mapOpenAlexWork(w) : null;
  }

  /** Finds a work by exact (normalized) title — used to connect arXiv-only records. */
  async findByTitle(title: string, year: number | null, firstAuthor?: string): Promise<NormalizedPaper | null> {
    const clean = title.replace(/[,:|]/g, " ").trim();
    const data = await this.get<OAList>("/works", {
      filter: `title.search:${clean}`,
      "per-page": "5",
      select: SELECT,
    });
    const target = normalizeTitle(title);
    const candidates = (data?.results ?? []).map(mapOpenAlexWork).filter((p): p is NormalizedPaper => !!p);
    return (
      candidates
        .filter((p) => normalizeTitle(p.title) === target)
        .filter((p) => {
          const sameAuthor =
            !!firstAuthor && normalizeAuthorFamilyName(p.authors[0]?.name) === normalizeAuthorFamilyName(firstAuthor);
          const sameYear = !year || !p.year || Math.abs(p.year - year) <= 1;
          // Sources sometimes disagree on the year; a long exact title plus first author is strong evidence.
          return sameYear ? !firstAuthor || !p.authors.length || sameAuthor : sameAuthor && target.length >= 20;
        })
        .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0))[0] ?? null
    );
  }

  async getReferences(ref: PaperRef, offset: number, limit: number): Promise<CitationPage> {
    const work = await this.getWork(ref, "id,referenced_works");
    const all = (work?.referenced_works ?? []).map((u) => u.split("/").pop()!).filter(Boolean);
    const slice = all.slice(offset, offset + limit);
    const papers: NormalizedPaper[] = [];
    for (let i = 0; i < slice.length; i += 50) {
      const batch = slice.slice(i, i + 50);
      const data = await this.get<OAList>("/works", {
        filter: `openalex_id:${batch.join("|")}`,
        "per-page": "50",
        select: SELECT,
      });
      papers.push(...(data?.results ?? []).map(mapOpenAlexWork).filter((p): p is NormalizedPaper => !!p));
    }
    return {
      provider: this.name,
      entries: papers.map((paper) => ({ paper, isInfluential: null, intents: [], contexts: [] })),
      total: all.length,
      hasMore: offset + limit < all.length,
    };
  }

  async getCitations(ref: PaperRef, offset: number, limit: number): Promise<CitationPage> {
    const work = ref.kind === "openalex" ? { id: ref.value } : await this.getWork(ref, "id");
    const id = work ? normalizeOpenAlexId(work.id) : null;
    if (!id) return { provider: this.name, entries: [], total: 0, hasMore: false };
    const data = await this.get<OAList>("/works", {
      filter: `cites:${id}`,
      sort: "cited_by_count:desc",
      "per-page": String(limit),
      page: String(Math.floor(offset / limit) + 1),
      select: SELECT,
    });
    const papers = (data?.results ?? []).map(mapOpenAlexWork).filter((p): p is NormalizedPaper => !!p);
    const total = data?.meta?.count ?? null;
    return {
      provider: this.name,
      entries: papers.map((paper) => ({ paper, isInfluential: null, intents: [], contexts: [] })),
      total,
      hasMore: total !== null ? offset + limit < total : papers.length === limit,
    };
  }
}
