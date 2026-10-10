/** BibTeX generation and parsing. */
import { parse } from "@retorquere/bibtex-parser";
import { normalizeArxivId, normalizeDoi } from "@/lib/identifiers";

export interface BibPaper {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  publicationTypes: string[];
  abstract: string | null;
  url: string | null;
  ids: Partial<Record<string, string>>;
}

const LATEX_SPECIAL: [RegExp, string][] = [
  [/\\/g, "\\textbackslash{}"],
  [/([{}])/g, "\\$1"],
  [/([&%$#_])/g, "\\$1"],
  [/~/g, "\\textasciitilde{}"],
  [/\^/g, "\\textasciicircum{}"],
];

export function escapeBib(value: string): string {
  return LATEX_SPECIAL.reduce((s, [re, rep]) => s.replace(re, rep), value);
}

function keyPart(s: string | undefined) {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
}

const STOP = new Set(["a", "an", "the", "on", "of", "in", "for", "to", "and", "with", "towards", "toward"]);

export function citationKey(p: BibPaper): string {
  const family = keyPart(p.authors[0]?.split(/\s+/).at(-1)).toLowerCase() || "anon";
  const word = keyPart(p.title.split(/\s+/).find((w) => !STOP.has(w.toLowerCase()))).toLowerCase();
  return `${family}${p.year ?? "nd"}${word}`;
}

export function toBibtex(papers: BibPaper[]): string {
  const used = new Map<string, number>();
  return papers
    .map((p) => {
      let key = citationKey(p);
      const n = used.get(key) ?? 0;
      used.set(key, n + 1);
      if (n > 0) key += String.fromCharCode(97 + ((n - 1) % 26));

      const types = new Set(p.publicationTypes);
      const isArxivOnly = !!p.ids.arxiv && !p.ids.doi;
      const type = types.has("conference")
        ? "inproceedings"
        : types.has("journal_article") && p.venue
          ? "article"
          : types.has("book")
            ? "book"
            : "misc";
      const fields: [string, string | null | undefined][] = [
        ["title", `{${escapeBib(p.title)}}`],
        ["author", p.authors.map(escapeBib).join(" and ") || undefined],
        ["year", p.year ? String(p.year) : undefined],
        [
          type === "inproceedings" ? "booktitle" : "journal",
          p.venue && !(isArxivOnly && /arxiv/i.test(p.venue)) ? escapeBib(p.venue) : undefined,
        ],
        ["doi", p.ids.doi],
        ["eprint", p.ids.arxiv],
        ["archiveprefix", p.ids.arxiv ? "arXiv" : undefined],
        ["pmid", p.ids.pmid],
        [
          "url",
          p.url ??
            (p.ids.doi
              ? `https://doi.org/${p.ids.doi}`
              : p.ids.arxiv
                ? `https://arxiv.org/abs/${p.ids.arxiv}`
                : undefined),
        ],
        ["abstract", p.abstract ? escapeBib(p.abstract) : undefined],
      ];
      const body = fields
        .filter(([, v]) => v)
        .map(([k, v]) => `  ${k} = {${v}}`)
        .join(",\n");
      return `@${type}{${key},\n${body}\n}`;
    })
    .join("\n\n")
    .concat("\n");
}

export interface ParsedBibEntry {
  key: string;
  title: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxiv: string | null;
  abstract: string | null;
  url: string | null;
  type: string;
}

function fieldText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v))
    return (
      v
        .map((x) => (typeof x === "string" ? x : ""))
        .join(" ")
        .trim() || null
    );
  return null;
}

export function parseBibtex(text: string): { entries: ParsedBibEntry[]; errors: number } {
  const result = parse(text, { sentenceCase: false });
  const entries = result.entries
    .filter((e) => e.key && Object.keys(e.fields).length)
    .map((e) => {
      const f = e.fields as Record<string, unknown>;
      const authors = Array.isArray(f.author)
        ? (f.author as { firstName?: string; lastName?: string; name?: string }[])
            .map((a) => a.name ?? [a.firstName, a.lastName].filter(Boolean).join(" "))
            .filter(Boolean)
        : [];
      const eprint = fieldText(f.eprint);
      const archive = fieldText(f.archiveprefix) ?? fieldText(f.eprinttype);
      const url = fieldText(f.url);
      const year = Number(fieldText(f.year) ?? fieldText(f.date)?.slice(0, 4));
      return {
        key: e.key,
        title: fieldText(f.title),
        authors,
        year: Number.isFinite(year) && year > 1000 ? year : null,
        venue: fieldText(f.journal) ?? fieldText(f.booktitle) ?? fieldText(f.journaltitle) ?? fieldText(f.publisher),
        doi: normalizeDoi(fieldText(f.doi)),
        arxiv:
          (eprint && (!archive || /arxiv/i.test(archive)) ? normalizeArxivId(eprint) : null) ??
          (url && /arxiv\.org/i.test(url) ? normalizeArxivId(url) : null),
        abstract: fieldText(f.abstract),
        url,
        type: e.type,
      };
    });
  return { entries, errors: result.errors.length };
}
