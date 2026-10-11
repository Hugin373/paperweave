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
