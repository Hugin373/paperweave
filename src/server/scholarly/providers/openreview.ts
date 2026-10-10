import { normalizeTitle } from "@/lib/identifiers";
import { providerFetch, Throttle } from "../http";
import type { IdentifierKind, NormalizedPaper, PaperRef, ScholarlyProvider, SearchPage, SearchRequest } from "../types";
import { ProviderError } from "../types";

const BASE = "https://api2.openreview.net";
const SITE = "https://openreview.net";

type Value<T> = { value?: T } | undefined;

export interface OrNote {
  id: string;
  forum?: string;
  replyto?: string | null;
  invitations?: string[];
  cdate?: number;
  pdate?: number | null;
  odate?: number | null;
  content: Record<string, Value<unknown>>;
}

const val = <T>(n: OrNote, key: string): T | undefined => (n.content[key] as Value<T>)?.value;
const isoDate = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

/** Imported bibliography records (DBLP, archive) carry no reviews and duplicate other indexes. */
function isImported(n: OrNote) {
  const venueId = val<string>(n, "venueid") ?? "";
  return venueId.startsWith("dblp.org") || venueId.startsWith("OpenReview.net/Archive");
}

/**
 * Papers still under double-blind review: OpenReview labels them "ICLR 2027 Conference Submission" (and
 * similar) until decisions are out; after that rejected papers read "Submitted to ICLR 2027".
 */
export function underReview(venue: string | null | undefined): boolean {
  return /\bsubmission\b|under review|blind/i.test(venue ?? "");
}

/** Lower is better: accepted at a main venue, then workshops, then submitted/rejected/under review, then withdrawn. */
export function venueRank(venue: string | null | undefined): number {
  const v = venue ?? "";
  if (/withdrawn|desk/i.test(v)) return 3;
  if (/submitted|rejected/i.test(v) || underReview(v)) return 2;
  if (/workshop/i.test(v) || !/\b(19|20)\d{2}\b/.test(v)) return 1;
  return 0;
}

/** "ICLR 2025 Poster", "Submitted to ICLR 2024", "NeurIPS 2023 oral" … */
export function venueYear(venue: string | undefined, fallback: number | null | undefined): number | null {
  const m = /\b(19|20)\d{2}\b/.exec(venue ?? "");
  return m ? Number(m[0]) : (fallback ?? null);
}

export function mapOrNote(n: OrNote): NormalizedPaper | null {
  const title = val<string>(n, "title")?.trim();
  if (!title) return null;
  const forum = n.forum ?? n.id;
  const venue = val<string>(n, "venue") ?? null;
  const date = isoDate(n.pdate ?? n.odate ?? n.cdate);
  const accepted = !!venue && !/submitted|withdrawn|rejected|desk/i.test(venue) && !underReview(venue);
  return {
    source: "openreview",
    ids: { openreview: forum },
    title,
    abstract: val<string>(n, "abstract")?.trim() || null,
    year: venueYear(venue ?? undefined, date ? Number(date.slice(0, 4)) : null),
    publicationDate: date,
    venue,
    publicationTypes: accepted ? ["conference"] : ["preprint"],
    fieldsOfStudy: [],
    authors: (val<string[]>(n, "authors") ?? []).map((name) => ({ name })),
    citationCount: null,
    referenceCount: null,
    influentialCitationCount: null,
    // OpenReview PDFs are public, but downloading them needs a signed-in account (bot check).
    isOpenAccess: val<string>(n, "pdf") ? true : null,
    openAccessPdfUrl: null,
    url: `${SITE}/forum?id=${forum}`,
  };
}

/** A paper's OpenReview record: venue / decision and (when signed in) its reviews. */
export interface OpenReviewInfo {
  forumId: string;
  url: string;
  title: string;
  venue: string | null;
  decision: string | null;
  reviews: { rating: string | null; confidence: string | null; summary: string | null }[];
  /** False when reviews could not be loaded because OpenReview requires sign-in. */
  reviewsLoaded: boolean;
}

/**
 * OpenReview: peer-reviewed ML venues (ICLR, NeurIPS, ICML, TMLR, CoRL, workshops…). Search works
 * anonymously; reading a forum (reviews, decisions) and PDFs requires an account, because anonymous
 * access is bot-checked. Set OPENREVIEW_USERNAME / OPENREVIEW_PASSWORD to enable those.
 */
export class OpenReviewProvider implements ScholarlyProvider {
  readonly name = "openreview" as const;
  readonly lookupKinds: readonly IdentifierKind[] = ["openreview"];
  readonly supportsSearch = true;
  readonly supportsCitations = false;
  private readonly throttle = new Throttle(500);
  private token: { value: string; at: number } | null = null;

  constructor(
    private readonly username?: string,
    private readonly password?: string,
  ) {}

  get signedIn() {
    return !!(this.username && this.password);
  }

  private async authHeader(): Promise<Record<string, string>> {
    if (!this.signedIn) return {};
    if (!this.token || Date.now() - this.token.at > 6 * 3600_000) {
      const res = await fetch(`${BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Paperweave/1.0" },
        body: JSON.stringify({ id: this.username, password: this.password }),
        signal: AbortSignal.timeout(15000),
      }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as { token?: string } | null) : null;
      if (!body?.token) throw new ProviderError(this.name, "unavailable", "OpenReview sign-in failed");
      this.token = { value: body.token, at: Date.now() };
    }
    return { Authorization: `Bearer ${this.token.value}` };
  }

  private async get<T>(path: string, params: Record<string, string>) {
    return providerFetch<T>(`${BASE}${path}?${new URLSearchParams(params)}`, {
      provider: this.name,
      throttle: this.throttle,
      headers: await this.authHeader(),
    });
  }

  async search(req: SearchRequest): Promise<SearchPage> {
    const term = req.query
      .replace(/[:"()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // The search API has no paging or filters: fetch a larger batch, then filter and page here.
    const data = await this.get<{ notes?: OrNote[]; count?: number }>("/notes/search", {
      term,
      type: "terms",
      content: req.mode === "title" ? "title" : req.mode === "author" ? "authors" : "all",
      group: "all",
      source: "forum",
      limit: "100",
    });
    const f = req.filters;
    let papers = (data?.notes ?? [])
      .filter((n) => !isImported(n))
      .map(mapOrNote)
      .filter((p): p is NormalizedPaper => p !== null)
      .filter((p) => (!f.yearFrom || (p.year ?? 0) >= f.yearFrom) && (!f.yearTo || (p.year ?? 9999) <= f.yearTo))
      .filter((p) => !f.venue || (p.venue ?? "").toLowerCase().includes(f.venue.toLowerCase()))
      .filter((p) => f.publicationType !== "conference" || p.publicationTypes.includes("conference"))
      // Anonymous submissions under double-blind review only when asked for.
      .filter((p) => f.includeUnderReview || !underReview(p.venue));
    // The same paper often has several forums (workshop and conference versions): keep the best venue.
    const best = new Map<string, NormalizedPaper>();
    for (const p of papers) {
      const key = normalizeTitle(p.title);
      const seen = best.get(key);
      if (!seen || venueRank(p.venue) < venueRank(seen.venue)) best.set(key, p);
    }
    papers = papers.filter((p) => best.get(normalizeTitle(p.title)) === p);
    if (req.sort === "newest") {
      papers = papers.sort((a, b) => (b.publicationDate ?? "").localeCompare(a.publicationDate ?? ""));
    }
    return { provider: this.name, papers: papers.slice(req.offset, req.offset + req.limit), total: papers.length };
  }

  async getPaper(ref: PaperRef): Promise<NormalizedPaper | null> {
    if (ref.kind !== "openreview" || !this.signedIn) return null;
    const data = await this.get<{ notes?: OrNote[] }>("/notes", { id: ref.value });
    const note = data?.notes?.[0];
    return note ? mapOrNote(note) : null;
  }

  /** The forum whose title matches exactly (best venue first: accepted > submitted > withdrawn). */
  async findForum(title: string): Promise<OrNote | null> {
    const data = await this.get<{ notes?: OrNote[] }>("/notes/search", {
      term: title.replace(/[:"()]/g, " "),
      type: "terms",
      content: "title",
      group: "all",
      source: "forum",
      limit: "20",
    });
    const target = normalizeTitle(title);
    const rank = (n: OrNote) => venueRank(val<string>(n, "venue"));
    return (
      (data?.notes ?? [])
        .filter((n) => !isImported(n) && normalizeTitle(val<string>(n, "title") ?? "") === target)
        .sort((a, b) => rank(a) - rank(b))[0] ?? null
    );
  }

  /** Decision and reviews of a forum (requires sign-in; otherwise returns reviewsLoaded: false). */
  async forumInfo(note: OrNote): Promise<OpenReviewInfo> {
    const forumId = note.forum ?? note.id;
    const info: OpenReviewInfo = {
      forumId,
      url: `${SITE}/forum?id=${forumId}`,
      title: val<string>(note, "title") ?? "",
      venue: val<string>(note, "venue") ?? null,
      decision: null,
      reviews: [],
      reviewsLoaded: false,
    };
    if (!this.signedIn) return info;
    const data = await this.get<{ notes?: OrNote[] }>("/notes", { forum: forumId, limit: "200" });
    const replies = (data?.notes ?? []).filter((n) => n.id !== forumId);
    const kind = (n: OrNote) => (n.invitations ?? []).map((i) => i.split("/-/").pop() ?? "").join(",");
    const text = (n: OrNote, keys: string[]) => {
      for (const k of keys) {
        const v = val<unknown>(n, k);
        if (v !== undefined && v !== null && v !== "") return String(v).trim();
      }
      return null;
    };
    const decision = replies.find((n) => /Decision/.test(kind(n)));
    info.decision = decision ? text(decision, ["decision", "recommendation"]) : null;
    info.reviews = replies
      .filter((n) => /Official_Review|Review$/.test(kind(n)) && !/Meta_Review/.test(kind(n)))
      .map((n) => ({
        rating: text(n, ["rating", "recommendation", "overall_assessment", "final_rating", "overall_recommendation"]),
        confidence: text(n, ["confidence"]),
        summary: text(n, ["summary", "summary_of_the_paper", "review", "main_review"])?.slice(0, 1500) ?? null,
      }));
    info.reviewsLoaded = true;
    return info;
  }

  /** The submission PDF (needs sign-in). */
  async pdf(forumId: string): Promise<Uint8Array | null> {
    if (!this.signedIn) return null;
    const res = await fetch(`${BASE}/pdf?id=${encodeURIComponent(forumId)}`, {
      headers: { ...(await this.authHeader()), "User-Agent": "Paperweave/1.0", Accept: "application/pdf" },
      signal: AbortSignal.timeout(45000),
    }).catch(() => null);
    if (!res?.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  }
}
