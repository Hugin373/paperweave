import { XMLParser } from "fast-xml-parser";
import { normalizeArxivId, normalizeDoi } from "@/lib/identifiers";
import { providerFetch, Throttle } from "../http";
import type { IdentifierKind, NormalizedPaper, PaperRef, ScholarlyProvider } from "../types";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

type Many<T> = T | T[] | undefined;
const arr = <T>(v: Many<T>): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

interface AtomEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  author?: Many<{ name?: string }>;
  "arxiv:doi"?: string | { "#text"?: string };
  "arxiv:journal_ref"?: string | { "#text"?: string };
  "arxiv:primary_category"?: { "@_term"?: string };
}

const text = (v: unknown): string | null =>
  typeof v === "string"
    ? v
    : v && typeof v === "object" && "#text" in v
      ? String((v as { "#text": unknown })["#text"])
      : null;

export function parseArxivFeed(xml: string): NormalizedPaper[] {
  const doc = parser.parse(xml) as { feed?: { entry?: Many<AtomEntry> } };
  return arr(doc.feed?.entry)
    .map((e): NormalizedPaper | null => {
      const id = normalizeArxivId(e.id ?? null);
      const title = e.title?.replace(/\s+/g, " ").trim();
      if (!id || !title || title === "Error") return null;
      const published = e.published?.slice(0, 10) ?? null;
      const doi = normalizeDoi(text(e["arxiv:doi"]));
      return {
        source: "arxiv",
        ids: doi ? { arxiv: id, doi } : { arxiv: id },
        title,
        abstract: e.summary?.replace(/\s+/g, " ").trim() || null,
        year: published ? Number(published.slice(0, 4)) : null,
        publicationDate: published,
        venue: text(e["arxiv:journal_ref"])?.trim() || "arXiv",
        publicationTypes: ["preprint"],
        fieldsOfStudy: e["arxiv:primary_category"]?.["@_term"] ? [e["arxiv:primary_category"]["@_term"]] : [],
        authors: arr(e.author)
          .map((a) => a.name?.trim())
          .filter((n): n is string => !!n)
          .map((name) => ({ name })),
        citationCount: null,
        referenceCount: null,
        influentialCitationCount: null,
        isOpenAccess: true,
        openAccessPdfUrl: `https://arxiv.org/pdf/${id}`,
        url: `https://arxiv.org/abs/${id}`,
      };
    })
    .filter((p): p is NormalizedPaper => p !== null);
}

/** The version number in the first entry's id (`http://arxiv.org/abs/2401.00001v3` → 3). */
export function arxivFeedVersion(xml: string): number | null {
  const doc = parser.parse(xml) as { feed?: { entry?: Many<AtomEntry> } };
  const m = /v(\d+)$/.exec(arr(doc.feed?.entry)[0]?.id?.trim() ?? "");
  return m ? Number(m[1]) : null;
}

/** arXiv: authoritative metadata for arXiv identifiers (no citation data). */
export class ArxivProvider implements ScholarlyProvider {
  readonly name = "arxiv" as const;
  readonly lookupKinds: readonly IdentifierKind[] = ["arxiv"];
  readonly supportsSearch = false;
  readonly supportsCitations = false;
  // arXiv asks clients to wait ~3 seconds between API calls.
  private readonly throttle = new Throttle(3000);

  async getPaper(ref: PaperRef): Promise<NormalizedPaper | null> {
    if (ref.kind !== "arxiv") return null;
    const xml = await providerFetch<string>(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ref.value)}&max_results=1`,
      { provider: this.name, throttle: this.throttle, as: "text", headers: { Accept: "application/atom+xml" } },
    );
    return xml ? (parseArxivFeed(xml)[0] ?? null) : null;
  }

  /**
   * Preprints with this title: the exact phrase first, then all of its words (arXiv's search is strict
   * about punctuation and stop words, so the phrase alone misses some).
   */
  async searchTitle(title: string, limit: number): Promise<NormalizedPaper[]> {
    const words = arxivTerms(title);
    if (!words.length) return [];
    const phrase = words.join(" ");
    const exact = await this.query(`ti:"${phrase}"`, limit);
    if (exact.length) return exact;
    return words.length > 1 ? this.query(words.map((w) => `ti:${w}`).join(" AND "), limit) : [];
  }

  private async query(searchQuery: string, limit: number): Promise<NormalizedPaper[]> {
    const params = new URLSearchParams({ search_query: searchQuery, start: "0", max_results: String(limit) });
    const xml = await providerFetch<string>(`https://export.arxiv.org/api/query?${params}`, {
      provider: this.name,
      throttle: this.throttle,
      as: "text",
      headers: { Accept: "application/atom+xml" },
    });
    return xml ? parseArxivFeed(xml) : [];
  }

  async latestVersion(id: string): Promise<number | null> {
    const xml = await providerFetch<string>(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`,
      { provider: this.name, throttle: this.throttle, as: "text", headers: { Accept: "application/atom+xml" } },
    );
    return xml ? arxivFeedVersion(xml) : null;
  }

  /**
   * The most recently submitted preprints matching all query terms. arXiv lists papers the day they
   * are posted, before the large scholarly indexes pick them up.
   */
  async searchLatest(query: string, limit: number): Promise<NormalizedPaper[]> {
    const terms = arxivTerms(query);
    if (!terms.length) return [];
    // The query as a phrase in the title or abstract is far more precise; if that finds too little,
    // fall back to all words anywhere in the title or abstract.
    const phrase = terms.length >= 2 && terms.length <= 5 ? `"${terms.join(" ")}"` : null;
    const found = phrase ? await this.newest(`ti:${phrase} OR abs:${phrase}`, limit) : [];
    if (found.length >= limit) return found;
    const more = await this.newest(terms.map((t) => `(ti:${t} OR abs:${t})`).join(" AND "), limit);
    const seen = new Set(found.map((p) => p.ids.arxiv));
    return [...found, ...more.filter((p) => !seen.has(p.ids.arxiv))].slice(0, limit);
  }

  private async newest(searchQuery: string, limit: number): Promise<NormalizedPaper[]> {
    const params = new URLSearchParams({
      search_query: searchQuery,
      sortBy: "submittedDate",
      sortOrder: "descending",
      start: "0",
      max_results: String(limit),
    });
    const xml = await providerFetch<string>(`https://export.arxiv.org/api/query?${params}`, {
      provider: this.name,
      throttle: this.throttle,
      as: "text",
      headers: { Accept: "application/atom+xml" },
    });
    return xml ? parseArxivFeed(xml) : [];
  }
}

/** Query words usable in an arXiv search (letters/digits only; at most 8). */
export function arxivTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !["and", "or", "not", "the", "of", "for", "in", "on", "with", "a"].includes(t))
    .slice(0, 8);
}
