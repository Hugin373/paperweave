/**
 * Unpaywall: legal open-access copies of papers by DOI (publisher sites, repositories, PMC). It needs
 * a contact email on every request, so it is only used when SCHOLARLY_CONTACT_EMAIL is set.
 */
import { normalizeDoi } from "@/lib/identifiers";

interface UnpaywallLocation {
  url_for_pdf?: string | null;
  /** The page where the free copy can be read (may be the PDF itself). */
  url?: string | null;
  host_type?: string;
  is_best?: boolean;
}

interface UnpaywallRecord {
  is_oa?: boolean;
  best_oa_location?: UnpaywallLocation | null;
  oa_locations?: UnpaywallLocation[];
}

/** What Unpaywall knows about a DOI: direct PDF links, and a free-to-read page when there is no PDF. */
export interface UnpaywallResult {
  pdfs: string[];
  freeReadUrl: string | null;
}

export function unpaywallResult(record: UnpaywallRecord | null): UnpaywallResult {
  const pdfs = unpaywallPdfUrls(record);
  const page = record?.is_oa
    ? [record.best_oa_location, ...(record.oa_locations ?? [])].find((l) => l?.url)?.url
    : null;
  if (pdfs.length || !page) return { pdfs, freeReadUrl: null };
  // PubMed Central pages get their current canonical address (older forms redirect).
  const pmcid = pmcidFromUrl(page);
  return {
    pdfs,
    freeReadUrl: pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/` : page.replace(/^http:\/\//i, "https://"),
  };
}

/** The PubMed Central id in a PMC article URL ("…/pmc/articles/PMC8574196/" or "…/articles/8574196"). */
export function pmcidFromUrl(url: string | null): string | null {
  const m = url && /\/(?:pmc\/)?articles\/(?:PMC)?(\d+)/i.exec(url);
  if (!m) return null;
  const host = new URL(url).hostname;
  return /(^|\.)ncbi\.nlm\.nih\.gov$|(^|\.)europepmc\.org$/.test(host) ? `PMC${m[1]}` : null;
}

/** Direct PDF links from an Unpaywall record: the best location first, publisher before repository. */
export function unpaywallPdfUrls(record: UnpaywallRecord | null): string[] {
  if (!record?.is_oa) return [];
  const locations = [
    ...(record.best_oa_location ? [record.best_oa_location] : []),
    ...[...(record.oa_locations ?? [])].sort(
      (a, b) => Number(b.host_type === "publisher") - Number(a.host_type === "publisher"),
    ),
  ];
  return [...new Set(locations.map((l) => l.url_for_pdf).filter((u): u is string => !!u))].map((u) =>
    u.replace(/^http:\/\//i, "https://"),
  );
}

export async function unpaywallLookup(doi: string, email: string): Promise<UnpaywallRecord | null> {
  const clean = normalizeDoi(doi);
  if (!clean) return null;
  const res = await fetch(
    `https://api.unpaywall.org/v2/${encodeURIComponent(clean)}?email=${encodeURIComponent(email)}`,
    { headers: { "User-Agent": "Paperweave/1.0" }, signal: AbortSignal.timeout(15000) },
  );
  // 404: Unpaywall does not know the DOI. Other failures throw, so they are not cached as "no PDF".
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Unpaywall responded with HTTP ${res.status}`);
  return (await res.json()) as UnpaywallRecord;
}
