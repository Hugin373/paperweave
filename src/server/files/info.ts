import { normalizeArxivId } from "@/lib/identifiers";
import type { PaperFileInfo } from "@/lib/types";
import type { paperFiles } from "@/server/db/schema";

const ARXIV_PDF_URL = /^https?:\/\/(www\.|export\.)?arxiv\.org\/pdf\//i;

/** The arXiv id of an arXiv PDF link, or null for any other link. */
export function arxivIdOfPdfUrl(url: string | null): string | null {
  return url && ARXIV_PDF_URL.test(url) ? normalizeArxivId(url) : null;
}

/** Hosts that let the browser load their PDFs directly, so live PDFs from them skip this server. */
const BROWSER_READABLE = /^https:\/\/arxiv\.org\/pdf\//i;

export function toFileInfo(f: typeof paperFiles.$inferSelect): PaperFileInfo {
  const live = !f.storageKey;
  return {
    id: f.id,
    filename: f.filename,
    source: f.source,
    sourceUrl: f.sourceUrl,
    sizeBytes: f.sizeBytes,
    pageCount: f.pageCount,
    textStatus: f.textStatus,
    createdAt: f.createdAt.toISOString(),
    live,
    version: f.version,
    // The content fingerprint makes a newer version a new URL, so browser caches never show the old one.
    viewUrl:
      live && f.sourceUrl && BROWSER_READABLE.test(f.sourceUrl)
        ? f.sourceUrl
        : `/api/files/${f.id}?v=${f.sha256.slice(0, 12)}`,
    arxivId: arxivIdOfPdfUrl(f.sourceUrl),
    versionNotice: f.versionNotice ?? null,
    canSwitch: f.source === "open_access" && !!f.sourceUrl,
  };
}
