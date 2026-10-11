/**
 * Free PDFs that follow from a paper's identifiers, without asking any service: every ACL Anthology paper
 * (ACL, EMNLP, NAACL, EACL, COLING, Findings, workshops…) is free at aclanthology.org, and its DOI
 * (10.18653/v1/<anthology id>) or Semantic Scholar's "ACL" id names the file.
 */

/** "10.18653/v1/2023.acl-long.1" → "2023.acl-long.1"; older ids look like "P17-1001". */
export function aclAnthologyId(doi: string | null | undefined, aclId?: string | null): string | null {
  const fromDoi = doi ? /^10\.18653\/v1\/([a-z0-9][a-z0-9.\-]*[a-z0-9])$/i.exec(doi.trim())?.[1] : null;
  const id = fromDoi ?? aclId?.trim() ?? null;
  return id && /^[a-z0-9][a-z0-9.\-]*[a-z0-9]$/i.test(id) ? id : null;
}

export function aclAnthologyPdf(doi: string | null | undefined, aclId?: string | null): string | null {
  const id = aclAnthologyId(doi, aclId);
  return id ? `https://aclanthology.org/${id}.pdf` : null;
}

/**
 * False for links that are not downloadable PDFs for a server, although sources report them as the free
 * PDF: DOI links (they open the article's web page) and PubMed Central / Europe PMC PDF links (bot-checked:
 * a reCAPTCHA page or HTTP 403). A browser can still open them, so they serve as "read free" links.
 */
export function serverCanFetchPdf(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "doi.org" || host === "dx.doi.org") return false;
  if (host === "pmc.ncbi.nlm.nih.gov" || (host === "ncbi.nlm.nih.gov" && u.pathname.startsWith("/pmc/"))) return false;
  if (host === "europepmc.org" && (u.searchParams.has("pdf") || u.pathname.includes("render"))) return false;
  return true;
}

/**
 * Versions of a PDF link to try, best first. Nature posts an "accepted article preview" (…_reference.pdf,
 * marked "article in press") before the final article, and sources keep pointing at it afterwards: the final
 * PDF is tried first, the preview only while the final one does not exist yet.
 */
export function pdfUrlVariants(url: string): string[] {
  const nature = /^(https:\/\/www\.nature\.com\/articles\/[a-z0-9.\-]+)_reference\.pdf$/i.exec(url);
  return nature ? [`${nature[1]}.pdf`, url] : [url];
}
