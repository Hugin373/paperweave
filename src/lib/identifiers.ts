/**
 * Parsing and normalization of scholarly identifiers. Shared by server and client
 * (the search box uses it to tell the user that an identifier was recognized).
 */

export type ParsedIdentifierKind = "doi" | "arxiv" | "s2" | "openalex" | "pmid" | "pmcid" | "openreview";

export interface ParsedIdentifier {
  kind: ParsedIdentifierKind;
  value: string;
}

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
const ARXIV_NEW_RE = /^(\d{4}\.\d{4,5})(v\d+)?$/i;
const ARXIV_OLD_RE = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?$/i;

export function normalizeDoi(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  s = s.replace(/^doi:\s*/i, "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const m = DOI_RE.exec(s);
  if (!m) return null;
  // Strip trailing punctuation commonly picked up from prose or URLs.
  return m[1].replace(/[.,;:)\]}>]+$/, "").toLowerCase();
}

export function normalizeArxivId(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  const doi = /10\.48550\/arxiv\.(.+)$/i.exec(s);
  if (doi) s = doi[1];
  s = s
    .replace(/^arxiv:\s*/i, "")
    .replace(/^https?:\/\/(www\.|export\.)?arxiv\.org\/(abs|pdf|html)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "");
  const m = ARXIV_NEW_RE.exec(s) ?? ARXIV_OLD_RE.exec(s);
  return m ? m[1].toLowerCase() : null;
}

export function normalizeOpenAlexId(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = /(?:openalex\.org\/(?:works\/)?)?\b(W\d{3,})\b/i.exec(input.trim());
  return m ? m[1].toUpperCase() : null;
}

export function normalizePmid(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = /(?:pmid:\s*|pubmed\.ncbi\.nlm\.nih\.gov\/|^)(\d{1,9})\/?$/i.exec(input.trim());
  return m ? m[1] : null;
}

export function normalizePmcid(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = /\b(PMC\d{4,10})\b/i.exec(input.trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * Recognizes a single identifier typed or pasted into the search box.
 * Returns null for ordinary keyword queries.
 */
export function detectIdentifier(raw: string): ParsedIdentifier | null {
  const q = raw.trim();
  if (!q || /\s/.test(q.replace(/^(doi|arxiv|pmid):\s+/i, (m) => m.trim()))) return null;

  if (/arxiv\.org\//i.test(q) || /^arxiv:/i.test(q) || /10\.48550\/arxiv\./i.test(q)) {
    const id = normalizeArxivId(q);
    if (id) return { kind: "arxiv", value: id };
  }
  if (/^(doi:|https?:\/\/(dx\.)?doi\.org\/|10\.\d{4,9}\/)/i.test(q)) {
    const doi = normalizeDoi(q);
    if (doi) return { kind: "doi", value: doi };
  }
  const s2 = /semanticscholar\.org\/paper\/(?:[^/]+\/)?([0-9a-f]{40})\b/i.exec(q) ?? /^([0-9a-f]{40})$/i.exec(q);
  if (s2) return { kind: "s2", value: s2[1].toLowerCase() };
  if (/openalex\.org\//i.test(q) || /^W\d{5,}$/i.test(q)) {
    const id = normalizeOpenAlexId(q);
    if (id) return { kind: "openalex", value: id };
  }
  if (/pubmed\.ncbi\.nlm\.nih\.gov\//i.test(q) || /^pmid:/i.test(q)) {
    const id = normalizePmid(q);
    if (id) return { kind: "pmid", value: id };
  }
  if (/^PMC\d{4,10}$/i.test(q)) return { kind: "pmcid", value: q.toUpperCase() };
  const openreview = /openreview\.net\/(?:forum|pdf)\?(?:[^#]*&)?id=([A-Za-z0-9_-]{6,})/i.exec(q);
  if (openreview) return { kind: "openreview", value: openreview[1] };
  const arxiv = normalizeArxivId(q);
  if (arxiv && (ARXIV_NEW_RE.test(q) || ARXIV_OLD_RE.test(q))) return { kind: "arxiv", value: arxiv };
  // A DOI embedded in some other URL (publisher landing pages often contain it).
  if (/^https?:\/\//i.test(q)) {
    const doi = normalizeDoi(q);
    if (doi) return { kind: "doi", value: doi };
  }
  return null;
}

export function identifierLabel(kind: string): string {
  switch (kind) {
    case "doi":
      return "DOI";
    case "arxiv":
      return "arXiv";
    case "s2":
      return "Semantic Scholar";
    case "openalex":
      return "OpenAlex";
    case "pmid":
      return "PubMed";
    case "pmcid":
      return "PubMed Central";
    case "corpus":
      return "S2 Corpus ID";
    case "openreview":
      return "OpenReview";
    default:
      return kind;
  }
}

export function identifierUrl(kind: string, value: string): string | null {
  switch (kind) {
    case "doi":
      return `https://doi.org/${value}`;
    case "arxiv":
      return `https://arxiv.org/abs/${value}`;
    case "s2":
      return `https://www.semanticscholar.org/paper/${value}`;
    case "openalex":
      return `https://openalex.org/${value}`;
    case "pmid":
      return `https://pubmed.ncbi.nlm.nih.gov/${value}/`;
    case "pmcid":
      return `https://www.ncbi.nlm.nih.gov/pmc/articles/${value}/`;
    case "openreview":
      return `https://openreview.net/forum?id=${value}`;
    default:
      return null;
  }
}

/** Lowercase, accent-free, punctuation-free title for duplicate detection. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normalized family name used as a secondary duplicate-detection signal. */
export function normalizeAuthorFamilyName(name: string | null | undefined): string | null {
  if (!name) return null;
  const plain = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
  if (!plain) return null;
  let family: string;
  if (plain.includes(",")) family = plain.split(",")[0];
  else {
    // "Bedoui A" / "van der Berg JK" (PubMed style: surname, then initials) as well as "A. Bedoui".
    const tokens = plain.split(/\s+/);
    while (tokens.length > 1 && /^(?:[A-Z]{1,3}|(?:[A-Z]\.){1,3})$/.test(tokens.at(-1)!)) tokens.pop();
    family = tokens.at(-1)!;
  }
  const out = family.toLowerCase().replace(/[^a-z]/g, "");
  return out || null;
}
