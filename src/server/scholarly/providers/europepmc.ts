import { normalizeDoi, normalizePmcid, normalizePmid } from "@/lib/identifiers";
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

const BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";

interface EpmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  authorList?: {
    author?: {
      fullName?: string;
      firstName?: string;
      lastName?: string;
      authorId?: { type?: string; value?: string };
    }[];
  };
  journalInfo?: { journal?: { title?: string } };
  bookOrReportDetails?: { publisher?: string };
  pubYear?: string | number;
  firstPublicationDate?: string;
  abstractText?: string;
  pubTypeList?: { pubType?: string[] };
  isOpenAccess?: string;
  citedByCount?: number;
  fullTextUrlList?: { fullTextUrl?: { availabilityCode?: string; documentStyle?: string; url?: string }[] };
  keywordList?: { keyword?: string[] };
}

interface EpmcSearch {
  hitCount?: number;
  resultList?: { result?: EpmcResult[] };
}

const stripTags = (s: string | undefined) =>
  s
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;

/** Europe PMC publication types → the app's vocabulary (first match wins). */
function pubTypes(r: EpmcResult): string[] {
  const raw = (r.pubTypeList?.pubType ?? []).map((t) => t.toLowerCase());
  if (r.source === "PPR" || raw.includes("preprint")) return ["preprint"];
  const out = new Set<string>();
  for (const t of raw) {
    if (t.includes("review") || t.includes("meta-analysis")) out.add("review");
    else if (t.includes("journal article") || t.includes("research-article")) out.add("journal_article");
    else if (t.includes("congress") || t.includes("conference")) out.add("conference");
    else if (t.includes("book")) out.add(normalizePublicationType("book"));
  }
  return [...out];
}

export function mapEpmcResult(r: EpmcResult): NormalizedPaper | null {
  const title = stripTags(r.title)?.replace(/\.$/, "");
  if (!title) return null;
  const pmid = r.source === "MED" ? normalizePmid(r.pmid ?? r.id) : r.pmid ? normalizePmid(r.pmid) : null;
  const ids = {
    ...(normalizeDoi(r.doi) ? { doi: normalizeDoi(r.doi)! } : {}),
    ...(pmid ? { pmid } : {}),
    ...(normalizePmcid(r.pmcid) ? { pmcid: normalizePmcid(r.pmcid)! } : {}),
  };
  if (!Object.keys(ids).length) return null;
  const authors = (r.authorList?.author ?? [])
    .map((a) => {
      const name = a.fullName ?? [a.firstName, a.lastName].filter(Boolean).join(" ");
      if (!name) return null;
      const orcid = a.authorId?.type === "ORCID" ? a.authorId.value : undefined;
      return { name, ids: orcid ? { orcid } : undefined };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
  const fallbackAuthors =
    authors.length || !r.authorString
      ? authors
      : r.authorString
          .replace(/\.$/, "")
          .split(/,\s*/)
          .filter(Boolean)
          .map((name) => ({ name }));
  const date =
    r.firstPublicationDate && /^\d{4}-\d{2}-\d{2}$/.test(r.firstPublicationDate) ? r.firstPublicationDate : null;
  const year = Number(r.pubYear) || (date ? Number(date.slice(0, 4)) : null);
  const pdf = (r.fullTextUrlList?.fullTextUrl ?? []).find(
    (u) => u.availabilityCode === "OA" && u.documentStyle === "pdf" && u.url && !/europepmc\.org\/articles/.test(u.url),
  );
  const isOpen = r.isOpenAccess === "Y" || !!ids.pmcid;
  // Europe PMC's own PDFs refuse automated downloads, but open articles can be read on its site.
  const readOnline =
    r.isOpenAccess === "Y"
      ? ((r.fullTextUrlList?.fullTextUrl ?? []).find(
          (u) => u.availabilityCode === "OA" && u.documentStyle === "html" && u.url,
        )?.url ?? (ids.pmcid ? `https://europepmc.org/articles/${ids.pmcid}` : null))
      : null;
  return {
    source: "europepmc",
    ids,
    title,
    abstract: stripTags(r.abstractText),
    year,
    publicationDate: date,
    venue: r.journalInfo?.journal?.title ?? r.bookOrReportDetails?.publisher ?? null,
    publicationTypes: pubTypes(r),
    fieldsOfStudy: [],
    authors: fallbackAuthors,
    citationCount: typeof r.citedByCount === "number" ? r.citedByCount : null,
    referenceCount: null,
    influentialCitationCount: null,
    isOpenAccess: r.isOpenAccess ? isOpen : null,
    openAccessPdfUrl: pdf?.url ?? null,
    freeReadUrl: pdf ? null : readOnline,
    url: ids.pmid
      ? `https://europepmc.org/article/MED/${ids.pmid}`
      : r.source && r.id
        ? `https://europepmc.org/article/${r.source}/${r.id}`
        : null,
  };
}

const RERANK_POOL = 100;

/** Orders papers by the share of query words in their title, then by citations. */
export function rerank(papers: NormalizedPaper[], query: string): NormalizedPaper[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((w) => w.length > 2);
  const score = (p: NormalizedPaper) => {
    const title = p.title.toLowerCase();
    const inTitle = words.filter((w) => title.includes(w)).length / Math.max(1, words.length);
    return inTitle * 10 + Math.log10((p.citationCount ?? 0) + 1);
  };
  return papers
    .map((p, i) => ({ p, s: score(p), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.p);
}

/** Builds a Europe PMC query from search terms and filters. */
export function epmcQuery(req: SearchRequest): string {
  const f = req.filters;
  // Field syntax characters in user text would change the query's meaning.
  const text = req.query
    .replace(/[:()[\]{}"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = [
    req.mode === "title"
      ? `TITLE:"${text}"`
      : req.mode === "author"
        ? `AUTH:"${text}"`
        : req.scope === "fulltext"
          ? `(${text})`
          : // Every word in the title or abstract: the default search also matches full texts, which
            // buries relevant papers under ones that mention the words in passing.
            `TITLE_ABS:(${text
              .split(" ")
              .filter((w) => !/^(and|or|not)$/i.test(w))
              .join(" AND ")})`,
  ];
  if (f.yearFrom || f.yearTo) parts.push(`PUB_YEAR:[${f.yearFrom ?? 1800} TO ${f.yearTo ?? 3000}]`);
  if (f.openAccessOnly) parts.push("OPEN_ACCESS:y");
  if (f.minCitations) parts.push(`CITED:[${f.minCitations} TO *]`);
  if (f.venue) parts.push(`JOURNAL:"${f.venue.replace(/"/g, " ")}"`);
  if (f.publicationType === "preprint") parts.push("SRC:PPR");
  if (f.publicationType === "review") parts.push('PUB_TYPE:"review"');
  return parts.join(" AND ");
}

/**
 * Europe PMC: the biomedical literature — all of PubMed/MEDLINE, PubMed Central (with open-access full
 * text) and preprints (medRxiv, bioRxiv, Research Square). Used for the "Biomedical" search source,
 * PubMed/PMC identifier lookups, and as a fallback for biomedical citation lists.
 */
export class EuropePmcProvider implements ScholarlyProvider {
  readonly name = "europepmc" as const;
  readonly lookupKinds: readonly IdentifierKind[] = ["pmid", "pmcid", "doi"];
  readonly supportsSearch = true;
  readonly supportsCitations = true;
  // Europe PMC asks for at most ~10 requests per second.
  private readonly throttle = new Throttle(150);

  private get<T>(path: string, params: Record<string, string>) {
    return providerFetch<T>(`${BASE}${path}?${new URLSearchParams({ format: "json", ...params })}`, {
      provider: this.name,
      throttle: this.throttle,
    });
  }

  async search(req: SearchRequest): Promise<SearchPage> {
    // Europe PMC orders matches newest first even for relevance; rank the first 100 by how well the
    // title matches the query, then by citations.
    if ((req.sort ?? "relevance") === "relevance" && req.mode === "all" && req.offset < RERANK_POOL) {
      const pool = await this.searchPage({ ...req, offset: 0, limit: RERANK_POOL });
      return { ...pool, papers: rerank(pool.papers, req.query).slice(req.offset, req.offset + req.limit) };
    }
    return this.searchPage(req);
  }

  private async searchPage(req: SearchRequest): Promise<SearchPage> {
    const params: Record<string, string> = {
      query: epmcQuery(req),
      resultType: "core",
      pageSize: String(req.limit),
      // Europe PMC pages with "page" for small offsets (offset is a multiple of limit).
      page: String(Math.floor(req.offset / req.limit) + 1),
    };
    if (req.sort === "newest") {
      params.sort = "P_PDATE_D desc";
      // Journal issues are often dated ahead; "newest" means published by today.
      params.query += ` AND FIRST_PDATE:[1800-01-01 TO ${new Date().toISOString().slice(0, 10)}]`;
    } else if (req.sort === "citations") params.sort = "CITED desc";
    const data = await this.get<EpmcSearch>("/search", params);
    const papers = (data?.resultList?.result ?? []).map(mapEpmcResult).filter((p): p is NormalizedPaper => p !== null);
    // Very specific queries can miss in titles and abstracts; then the full text is worth searching.
    if (req.mode === "all" && req.scope !== "fulltext" && req.offset === 0 && papers.length < Math.min(5, req.limit)) {
      const wider = await this.searchPage({ ...req, scope: "fulltext" });
      if (wider.papers.length > papers.length) return wider;
    }
    return { provider: this.name, papers, total: data?.hitCount ?? null };
  }

  async getPaper(ref: PaperRef): Promise<NormalizedPaper | null> {
    const query =
      ref.kind === "pmid"
        ? `EXT_ID:${ref.value} AND SRC:MED`
        : ref.kind === "pmcid"
          ? `PMCID:${ref.value}`
          : ref.kind === "doi"
            ? `DOI:"${ref.value}"`
            : null;
    if (!query) return null;
    const data = await this.get<EpmcSearch>("/search", { query, resultType: "core", pageSize: "1" });
    const r = data?.resultList?.result?.[0];
    return r ? mapEpmcResult(r) : null;
  }

  private async listing(kind: "references" | "citations", ref: PaperRef, offset: number, limit: number) {
    if (ref.kind !== "pmid") return { provider: this.name, entries: [], total: 0, hasMore: false };
    const pageSize = Math.min(Math.max(limit, 1), 1000);
    const data = await this.get<{
      hitCount?: number;
      referenceList?: { reference?: EpmcCitation[] };
      citationList?: { citation?: EpmcCitation[] };
    }>(`/MED/${ref.value}/${kind}`, { page: String(Math.floor(offset / pageSize) + 1), pageSize: String(pageSize) });
    const rows = (kind === "references" ? data?.referenceList?.reference : data?.citationList?.citation) ?? [];
    const entries: CitationEntry[] = rows.map((c) => ({
      paper: mapCitation(c),
      rawTitle: stripTags(c.title),
      isInfluential: null,
      intents: [],
      contexts: [],
    }));
    const total = data?.hitCount ?? null;
    return { provider: this.name, entries, total, hasMore: total !== null && offset + rows.length < total };
  }

  getReferences(ref: PaperRef, offset: number, limit: number): Promise<CitationPage> {
    return this.listing("references", ref, offset, limit);
  }

  getCitations(ref: PaperRef, offset: number, limit: number): Promise<CitationPage> {
    return this.listing("citations", ref, offset, limit);
  }

  /** The text of an open-access PMC article (per section), or null. Europe PMC serves it as XML. */
  async fullText(pmcid: string): Promise<string[] | null> {
    const xml = await providerFetch<string>(`${BASE}/${encodeURIComponent(pmcid)}/fullTextXML`, {
      provider: this.name,
      throttle: this.throttle,
      as: "text",
      headers: { Accept: "application/xml" },
      timeoutMs: 30000,
    }).catch(() => null);
    return xml ? jatsSections(xml) : null;
  }
}

interface EpmcCitation {
  id?: string;
  source?: string;
  title?: string;
  authorString?: string;
  journalAbbreviation?: string;
  pubYear?: string | number;
  doi?: string;
}

function mapCitation(c: EpmcCitation): NormalizedPaper | null {
  if (c.source !== "MED" && !c.doi) return null;
  return mapEpmcResult({
    id: c.id,
    source: c.source,
    pmid: c.source === "MED" ? c.id : undefined,
    doi: c.doi,
    title: c.title,
    authorString: c.authorString,
    journalInfo: c.journalAbbreviation ? { journal: { title: c.journalAbbreviation } } : undefined,
    pubYear: c.pubYear,
  });
}

/** Splits a JATS article into readable sections ("Title\n text"), dropping references and markup. */
export function jatsSections(xml: string): string[] {
  const body = /<body[\s>][\s\S]*<\/body>/i.exec(xml)?.[0] ?? "";
  const abstract = /<abstract[\s>][\s\S]*?<\/abstract>/i.exec(xml)?.[0] ?? "";
  const text = (s: string) =>
    s
      .replace(/<(xref|ext-link)[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/<[^>]+>/g, ""))
      .replace(/<(table-wrap|fig|disp-formula|ref-list)[\s>][\s\S]*?<\/\1>/gi, " ")
      .replace(/<title>([\s\S]*?)<\/title>/gi, "\n$1\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim();
  const sections = body.split(/<sec\b[^>]*>/i).slice(1);
  const parts = [abstract && `Abstract\n${text(abstract)}`, ...sections.map(text)];
  // Bare headings of sections whose text sits in nested sections are dropped.
  return parts.filter((p): p is string => !!p && p.length > 40);
}
