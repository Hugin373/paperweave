import { normalizeTitle } from "@/lib/identifiers";
import { env } from "@/server/env";
import { cached, cacheKey } from "./cache";
import { CircuitBreaker, QUOTA_RETRY_SECONDS } from "./http";
import { ArxivProvider } from "./providers/arxiv";
import { CrossrefProvider } from "./providers/crossref";
import { EuropePmcProvider } from "./providers/europepmc";
import { OpenReviewProvider, type OpenReviewInfo } from "./providers/openreview";
import { unpaywallLookup, unpaywallResult, type UnpaywallResult } from "./providers/unpaywall";
import { OpenAlexProvider } from "./providers/openalex";
import { SemanticScholarProvider } from "./providers/semantic-scholar";
import {
  ProviderError,
  type CitationPage,
  type NormalizedPaper,
  type PaperIds,
  type PaperRef,
  type ProviderName,
  type ScholarlyProvider,
  type SearchPage,
  type SearchRequest,
} from "./types";

interface Failure {
  provider: ProviderName;
  kind: string;
  message: string;
  /** The provider's daily quota is used up (not just a short burst limit). */
  quota?: boolean;
}

/** Raised when every capable provider failed. Carries a user-presentable explanation. */
export class ScholarlyUnavailableError extends Error {
  constructor(readonly failures: Failure[]) {
    const rateLimited = failures.some((f) => f.kind === "rate_limited");
    super(
      failures.some((f) => f.quota)
        ? "The free daily limit of the scholarly data sources is used up for this network (OpenAlex resets at midnight UTC). Add free API keys (OPENALEX_API_KEY, SEMANTIC_SCHOLAR_API_KEY) to keep searching."
        : rateLimited
          ? "Scholarly data sources are rate limiting requests right now. Please try again in a minute."
          : "Scholarly data sources are temporarily unavailable. Please try again shortly.",
    );
    this.name = "ScholarlyUnavailableError";
  }
}

const SEARCH_TTL_HOURS = 6;
const LIST_TTL_HOURS = 24;

export class ScholarlyService {
  readonly discovery: ScholarlyProvider[];
  readonly crossref: ScholarlyProvider;
  readonly arxiv: ScholarlyProvider;
  readonly openalex: OpenAlexProvider | undefined;
  /** Biomedical source (Europe PMC: PubMed, PMC, preprints). */
  readonly biomedical: ScholarlyProvider | undefined;
  /** ML venues on OpenReview. */
  readonly openreview: ScholarlyProvider | undefined;
  private readonly contactEmail: string | undefined;
  private readonly breaker = new CircuitBreaker();

  constructor(
    providers: ScholarlyProvider[],
    extras: {
      crossref: ScholarlyProvider;
      arxiv: ScholarlyProvider;
      biomedical?: ScholarlyProvider;
      openreview?: ScholarlyProvider;
      contactEmail?: string;
    },
    private readonly ttlHours: number,
  ) {
    this.discovery = providers;
    this.crossref = extras.crossref;
    this.arxiv = extras.arxiv;
    this.biomedical = extras.biomedical;
    this.openreview = extras.openreview;
    this.contactEmail = extras.contactEmail;
    this.openalex = providers.find((p): p is OpenAlexProvider => p instanceof OpenAlexProvider);
  }

  /** Runs `fn` against providers in order, failing over on errors. */
  private async withFailover<T>(
    providers: ScholarlyProvider[],
    fn: (p: ScholarlyProvider) => Promise<T>,
    acceptable: (value: T) => boolean = () => true,
  ): Promise<T | null> {
    const failures: Failure[] = [];
    let fallback: T | null = null;
    let limitedBeforeFallback = false;
    for (const provider of providers) {
      if (this.breaker.isOpen(provider.name)) {
        failures.push({
          provider: provider.name,
          kind: "rate_limited",
          message: "cooling down",
          quota: this.breaker.quotaExhausted(provider.name),
        });
        continue;
      }
      try {
        const value = await fn(provider);
        if (acceptable(value)) return value;
        if (fallback === null) {
          fallback = value;
          limitedBeforeFallback = failures.some((f) => f.kind === "rate_limited");
        }
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        const quota = err.kind === "rate_limited" && (err.retryAfterSeconds ?? 0) >= QUOTA_RETRY_SECONDS;
        failures.push({ provider: provider.name, kind: err.kind, message: err.message, quota });
        if (err.kind === "rate_limited") {
          // Without a stated wait it is a burst limit: pause briefly, the source recovers in seconds.
          this.breaker.trip(
            provider.name,
            Math.min(err.retryAfterSeconds ?? 20, 300),
            quota ? err.retryAfterSeconds : undefined,
          );
        } else if (err.kind === "unavailable") this.breaker.trip(provider.name, 20);
      }
    }
    // An empty answer is not trusted when a source before it was rate limited: for a venue only Semantic
    // Scholar knows (e.g. MICCAI), "no results" from the fallback would be wrong; "try again" is right.
    if (fallback !== null && !limitedBeforeFallback) return fallback;
    if (failures.length) throw new ScholarlyUnavailableError(failures);
    return fallback;
  }

  /** arXiv preprints with (about) this title; [] when arXiv is unavailable. */
  async arxivByTitle(title: string): Promise<NormalizedPaper[]> {
    const search = this.arxiv.searchTitle?.bind(this.arxiv);
    if (!search || this.breaker.isOpen("arxiv")) return [];
    return search(title, 5);
  }

  /** The newest arXiv preprints for a query (cached for an hour unless `fresh`, e.g. for saved searches). */
  async latestPreprints(query: string, limit: number, fresh = false): Promise<NormalizedPaper[]> {
    if (!this.arxiv.searchLatest || this.breaker.isOpen("arxiv")) return [];
    try {
      const run = () => this.arxiv.searchLatest!(query, limit);
      return await (fresh ? run() : cached(cacheKey("arxiv-latest", query.toLowerCase(), limit), 1, run));
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "rate_limited") this.breaker.trip("arxiv", 60);
      throw err;
    }
  }

  /** Searches the literature (cached for hours unless `fresh`, e.g. for saved searches checking for new papers). */
  async search(req: SearchRequest, opts: { fresh?: boolean } = {}): Promise<SearchPage> {
    const source = req.source ?? "general";
    const chosen =
      source === "biomedical" ? [this.biomedical] : source === "openreview" ? [this.openreview] : this.discovery;
    const providers = chosen.filter((p): p is ScholarlyProvider => !!p?.supportsSearch && !!p.search);
    const result = await this.withFailover(
      providers,
      (p) =>
        opts.fresh ? p.search!(req) : cached(cacheKey("search", p.name, req), SEARCH_TTL_HOURS, () => p.search!(req)),
      // No results on the first page from one source is worth asking the next one (it is kept as the
      // answer if every source comes back empty).
      (page) => page.papers.length > 0 || req.offset > 0,
    );
    return result ?? { provider: providers[0]?.name ?? "openalex", papers: [], total: 0 };
  }

  /**
   * Works published per year matching a query in titles and abstracts (all works when null), from OpenAlex
   * (cached for a day). Keys are the years, missing years had none.
   */
  async yearCounts(query: string | null, yearFrom: number, yearTo: number): Promise<Map<number, number>> {
    const openalex = this.openalex ?? (this.yearCountSource ??= new OpenAlexProvider(this.contactEmail));
    const entries = await this.withFailover([openalex], () =>
      cached(cacheKey("year-counts", query?.toLowerCase() ?? null, yearFrom, yearTo), 24, async () => [
        ...(await openalex.countsByYear(query, yearFrom, yearTo)).entries(),
      ]),
    );
    return new Map(entries ?? []);
  }
  private yearCountSource: OpenAlexProvider | undefined;

  private refFor(provider: ScholarlyProvider, ids: PaperIds): PaperRef | null {
    for (const kind of provider.lookupKinds) {
      const value = ids[kind];
      if (value) return { kind, value };
    }
    return null;
  }

  /**
   * Collects every record describing the paper identified by `ids` from all providers that can
   * resolve it. Used both for identifier search and for enrichment. Records are returned in
   * priority order; the caller merges them conservatively.
   */
  async lookup(ids: PaperIds): Promise<NormalizedPaper[]> {
    // arXiv goes first for arXiv ids: it is authoritative and often reveals the published DOI.
    // Crossref goes last and only runs if some source produced a DOI.
    const providers: ScholarlyProvider[] = [
      ...(ids.arxiv ? [this.arxiv] : []),
      ...this.discovery,
      // Europe PMC and OpenReview only for identifiers that are theirs (avoids a request per lookup).
      ...(this.biomedical && (ids.pmid || ids.pmcid) ? [this.biomedical] : []),
      ...(this.openreview && ids.openreview ? [this.openreview] : []),
      this.crossref,
    ];
    const records: NormalizedPaper[] = [];
    const failures: Failure[] = [];
    let currentIds: PaperIds = { ...ids };

    for (const provider of providers) {
      const ref = this.refFor(provider, currentIds);
      if (!ref || this.breaker.isOpen(provider.name)) continue;
      try {
        const rec = await cached(cacheKey("paper", provider.name, ref), this.ttlHours, () => provider.getPaper(ref));
        if (rec) {
          records.push(rec);
          // Later providers can use identifiers discovered by earlier ones (e.g. arXiv → DOI).
          currentIds = { ...rec.ids, ...currentIds };
        }
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        const quota = err.kind === "rate_limited" && (err.retryAfterSeconds ?? 0) >= QUOTA_RETRY_SECONDS;
        failures.push({ provider: provider.name, kind: err.kind, message: err.message, quota });
        if (err.kind === "rate_limited") {
          this.breaker.trip(
            provider.name,
            Math.min(err.retryAfterSeconds ?? 60, 300),
            quota ? err.retryAfterSeconds : undefined,
          );
        }
      }
    }

    // arXiv-only records are not addressable in OpenAlex by id; connect them by exact title.
    if (this.openalex && !records.some((r) => r.ids.openalex) && records.length && !this.breaker.isOpen("openalex")) {
      const base = records[0];
      try {
        const match = await cached(cacheKey("title", "openalex", base.title, base.year), this.ttlHours, () =>
          this.openalex!.findByTitle(base.title, base.year, base.authors[0]?.name),
        );
        if (match && (!match.ids.doi || !currentIds.doi || match.ids.doi === currentIds.doi)) records.push(match);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
      }
    }

    if (!records.length && failures.length) throw new ScholarlyUnavailableError(failures);
    return records;
  }

  private async listing(
    kind: "references" | "citations",
    ids: PaperIds,
    offset: number,
    limit: number,
  ): Promise<CitationPage | null> {
    // Europe PMC is a last resort for biomedical papers (PubMed ids) the main indexes cannot list.
    const providers = [...this.discovery, ...(this.biomedical ? [this.biomedical] : [])].filter(
      (p) => p.supportsCitations && this.refFor(p, ids),
    );
    return this.withFailover(
      providers,
      (p) => {
        const ref = this.refFor(p, ids)!;
        const call = kind === "references" ? p.getReferences!.bind(p) : p.getCitations!.bind(p);
        return cached(cacheKey(kind, p.name, ref, offset, limit), LIST_TTL_HOURS, () => call(ref, offset, limit));
      },
      // An empty first page from one source is worth double-checking with the next one.
      (page) => page.entries.length > 0 || offset > 0,
    );
  }

  /**
   * The newest arXiv version number of a preprint, or null when unknown. Cached for an hour unless
   * `fresh` (the reader asked to check now).
   */
  async arxivLatestVersion(id: string, fresh = false): Promise<number | null> {
    const latest = this.arxiv.latestVersion?.bind(this.arxiv);
    if (!latest) return null;
    const lookup = () => latest(id);
    return (fresh ? lookup() : cached(cacheKey("arxiv-version", id.toLowerCase()), 1, lookup)).catch(() => null);
  }

  /** Legal open-access PDF links for a DOI from Unpaywall (cached for a week); [] when unavailable. */
  async unpaywallPdfs(doi: string): Promise<string[]> {
    return (await this.unpaywallCheck(doi).catch(() => null))?.pdfs ?? [];
  }

  /** Whether Unpaywall lookups are possible (they need SCHOLARLY_CONTACT_EMAIL). */
  get unpaywallEnabled() {
    return !!this.contactEmail;
  }

  /**
   * Unpaywall's PDF links and free-to-read page for a DOI (cached for a week), or null when lookups
   * are off. Throws when Unpaywall cannot be reached, so a failed lookup is not mistaken for "no PDF".
   */
  async unpaywallCheck(doi: string): Promise<UnpaywallResult | null> {
    if (!this.contactEmail) return null;
    const email = this.contactEmail;
    return cached(cacheKey("unpaywall-v2", doi.toLowerCase()), 168, async () =>
      unpaywallResult(await unpaywallLookup(doi, email)),
    );
  }

  /** Open-access full text of a PubMed Central article, by section (cached for a week). */
  async pmcFullText(pmcid: string): Promise<string[] | null> {
    const epmc = this.biomedical;
    if (!(epmc instanceof EuropePmcProvider)) return null;
    return cached(cacheKey("pmc-fulltext", pmcid), 168, () => epmc.fullText(pmcid)).catch(() => null);
  }

  /** The paper's OpenReview forum (matched by exact title): venue, decision and reviews when signed in. */
  async openReviewFor(title: string): Promise<OpenReviewInfo | null> {
    const or = this.openreview;
    if (!(or instanceof OpenReviewProvider) || this.breaker.isOpen("openreview")) return null;
    const forum = await cached(cacheKey("openreview-forum", normalizeTitle(title)), 72, () => or.findForum(title));
    if (!forum) return null;
    return cached(cacheKey("openreview-info", forum.forum ?? forum.id, or.signedIn), 24, () => or.forumInfo(forum));
  }

  /** The OpenReview submission PDF (requires an OpenReview account). */
  async openReviewPdf(forumId: string): Promise<Uint8Array | null> {
    const or = this.openreview;
    return or instanceof OpenReviewProvider ? or.pdf(forumId) : null;
  }

  references(ids: PaperIds, offset: number, limit: number) {
    return this.listing("references", ids, offset, limit);
  }

  citations(ids: PaperIds, offset: number, limit: number) {
    return this.listing("citations", ids, offset, limit);
  }
}

let instance: ScholarlyService | undefined;

export function scholarly(): ScholarlyService {
  if (!instance) {
    const e = env();
    const order = e.SCHOLARLY_PROVIDERS.split(",").map((s) => s.trim());
    const providers: ScholarlyProvider[] = [];
    for (const name of order) {
      if (name === "semantic_scholar") providers.push(new SemanticScholarProvider(e.SEMANTIC_SCHOLAR_API_KEY));
      else if (name === "openalex") providers.push(new OpenAlexProvider(e.SCHOLARLY_CONTACT_EMAIL, e.OPENALEX_API_KEY));
    }
    if (!providers.length) providers.push(new OpenAlexProvider(e.SCHOLARLY_CONTACT_EMAIL, e.OPENALEX_API_KEY));
    instance = new ScholarlyService(
      providers,
      {
        crossref: new CrossrefProvider(e.SCHOLARLY_CONTACT_EMAIL),
        arxiv: new ArxivProvider(),
        biomedical: new EuropePmcProvider(),
        openreview: new OpenReviewProvider(e.OPENREVIEW_USERNAME, e.OPENREVIEW_PASSWORD),
        contactEmail: e.SCHOLARLY_CONTACT_EMAIL,
      },
      e.SCHOLARLY_CACHE_TTL_HOURS,
    );
  }
  return instance;
}

/** Test hook: replace the service (e.g. with fake providers). */
export function setScholarlyServiceForTests(service: ScholarlyService | undefined) {
  instance = service;
}
