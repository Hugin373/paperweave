import { normalizeDoi } from "@/lib/identifiers";
import { providerFetch, Throttle } from "../http";
import { normalizePublicationType } from "../publication-types";
import type { IdentifierKind, NormalizedPaper, PaperRef, ScholarlyProvider } from "../types";

interface CrossrefWork {
  DOI: string;
  title?: string[];
  abstract?: string;
  author?: { given?: string; family?: string; name?: string; ORCID?: string }[];
  "container-title"?: string[];
  issued?: { "date-parts"?: (number | null)[][] };
  published?: { "date-parts"?: (number | null)[][] };
  "is-referenced-by-count"?: number;
  "reference-count"?: number;
  type?: string;
  URL?: string;
  link?: { URL: string; "content-type"?: string; "intended-application"?: string }[];
  license?: { URL?: string }[];
}

/** Crossref abstracts are JATS XML fragments. */
export function stripJats(text: string | undefined): string | null {
  if (!text) return null;
  const out = text
    .replace(/<jats:title>[^<]*<\/jats:title>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out || null;
}

function dateFrom(parts: (number | null)[][] | undefined): { year: number | null; date: string | null } {
  const p = parts?.[0];
  if (!p || !p[0]) return { year: null, date: null };
  const [y, m, d] = p;
  const date = m && d ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
  return { year: y ?? null, date };
}

const OPEN_LICENSE = /creativecommons\.org|open-access|openaccess/i;

export function mapCrossrefWork(w: CrossrefWork): NormalizedPaper | null {
  const doi = normalizeDoi(w.DOI);
  const title = w.title?.[0]?.replace(/<[^>]+>/g, "").trim();
  if (!doi || !title) return null;
  const { year, date } = dateFrom(w.issued?.["date-parts"] ?? w.published?.["date-parts"]);
  const isOpen = (w.license ?? []).some((l) => l.URL && OPEN_LICENSE.test(l.URL));
  const pdf = isOpen ? ((w.link ?? []).find((l) => l["content-type"] === "application/pdf")?.URL ?? null) : null;
  return {
    source: "crossref",
    ids: { doi },
    title,
    abstract: stripJats(w.abstract),
    year,
    publicationDate: date,
    venue: w["container-title"]?.[0] ?? null,
    publicationTypes: w.type
      ? [
          normalizePublicationType(
            w.type === "proceedings-article" ? "conference" : w.type === "posted-content" ? "preprint" : w.type,
          ),
        ]
      : [],
    fieldsOfStudy: [],
    authors: (w.author ?? [])
      .map((a) => {
        const name = a.name ?? [a.given, a.family].filter(Boolean).join(" ");
        if (!name) return null;
        const orcid = a.ORCID?.split("/").pop();
        return { name, ids: orcid ? { orcid } : undefined };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null),
    citationCount: w["is-referenced-by-count"] ?? null,
    referenceCount: w["reference-count"] ?? null,
    influentialCitationCount: null,
    isOpenAccess: isOpen ? true : null,
    openAccessPdfUrl: pdf,
    url: w.URL ?? `https://doi.org/${doi}`,
  };
}

/** Crossref: authoritative DOI metadata. Used for DOI lookup and enrichment only. */
export class CrossrefProvider implements ScholarlyProvider {
  readonly name = "crossref" as const;
  readonly lookupKinds: readonly IdentifierKind[] = ["doi"];
  readonly supportsSearch = false;
  readonly supportsCitations = false;
  private readonly throttle = new Throttle(120);

  constructor(private readonly contactEmail?: string) {}

  async getPaper(ref: PaperRef): Promise<NormalizedPaper | null> {
    if (ref.kind !== "doi") return null;
    const qs = this.contactEmail ? `?mailto=${encodeURIComponent(this.contactEmail)}` : "";
    const data = await providerFetch<{ message?: CrossrefWork }>(
      `https://api.crossref.org/works/${encodeURIComponent(ref.value)}${qs}`,
      { provider: this.name, throttle: this.throttle },
    );
    return data?.message ? mapCrossrefWork(data.message) : null;
  }
}
