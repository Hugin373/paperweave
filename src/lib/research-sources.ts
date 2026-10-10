/**
 * Ranks the sources an assistant reply cites by how the reply uses them, so the list under a report
 * leads with what matters: the "Where to start reading" papers in their reading order (with the
 * reason given), then the other cited sources by how often and where the report relies on them.
 */
import type { ResearchSource } from "./types";

export const CITATION_GROUP = /\[((?:[PN]\d+)(?:\s*[,;]\s*[PN]\d+)*)\](?!\()/g;
const START_HEADING = /where to start|start (?:reading|here)|reading order|suggested reading|recommended reading/i;

export interface StartHereSource {
  source: ResearchSource;
  /** The report's one-line reason for reading it, when it gives one. */
  reason: string | null;
}

export interface CitedSource {
  source: ResearchSource;
  /** How many times the report cites it. */
  mentions: number;
  /** The report sections that cite it, in order. */
  sections: string[];
  /** Position of its first citation (for stable ordering). */
  first: number;
}

function keysIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITATION_GROUP)) {
    for (const k of m[1].split(/\s*[,;]\s*/)) out.push(k);
  }
  return out;
}

/** "1. **[P3] Segment Anything (2023)** — the base model; read first." → "the base model; read first." */
function reasonFrom(line: string, title: string): string | null {
  let plain = line
    .replace(CITATION_GROUP, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")
    .replace(/[*_`"“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Drop the paper's own title (and a year after it), which the line often repeats.
  const at = title ? plain.toLowerCase().indexOf(title.toLowerCase()) : -1;
  if (at >= 0) plain = `${plain.slice(0, at)} ${plain.slice(at + title.length).replace(/^\s*\(\d{4}\)/, "")}`;
  const sep = /\s[—–-]\s|:\s/.exec(` ${plain}`);
  const reason = (sep ? ` ${plain}`.slice(sep.index + sep[0].length) : plain).replace(/^[\s—–:;,.-]+/, "").trim();
  if (!reason) return null;
  return reason.length > 220 ? `${reason.slice(0, 219).trimEnd()}…` : reason;
}

export function rankSources(markdown: string, sources: ResearchSource[]) {
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const startHere: StartHereSource[] = [];
  const cited = new Map<string, CitedSource>();
  let heading = "";
  let inStart = false;
  let position = 0;
  for (const line of markdown.split("\n")) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      heading = h[1].replace(/[*_`]/g, "").trim();
      inStart = START_HEADING.test(heading);
      continue;
    }
    const keys = keysIn(line).filter((k) => byKey.has(k));
    if (!keys.length) continue;
    // Only list items count as reading suggestions; a closing remark under the list is a plain mention.
    if (inStart && /^\s*(?:[-*+]|\d+[.)])\s/.test(line)) {
      // A step can name several papers ("[P22] → [P3]"); each is listed, sharing the reason.
      for (const key of keys) {
        if (startHere.some((s) => s.source.key === key)) continue;
        const source = byKey.get(key)!;
        startHere.push({ source, reason: reasonFrom(line, keys.length === 1 ? source.title : "") });
      }
      continue;
    }
    for (const k of keys) {
      const entry = cited.get(k) ?? { source: byKey.get(k)!, mentions: 0, sections: [], first: position++ };
      entry.mentions++;
      if (heading && !entry.sections.includes(heading)) entry.sections.push(heading);
      cited.set(k, entry);
    }
  }
  const start = new Set(startHere.map((s) => s.source.key));
  const rest = [...cited.values()]
    .filter((c) => !start.has(c.source.key))
    .sort((a, b) => b.mentions - a.mentions || a.first - b.first);
  const used = new Set([...start, ...cited.keys()]);
  return { startHere, cited: rest, others: sources.filter((s) => !used.has(s.key)) };
}

export type SourceOrder = "relevance" | "newest" | "citations";

/** Re-sorts ranked sources for the "sort by" choice (relevance keeps the report's ranking). */
export function sortCited(items: CitedSource[], order: SourceOrder): CitedSource[] {
  if (order === "relevance") return items;
  const value = (c: CitedSource) => (order === "newest" ? (c.source.year ?? 0) : (c.source.citationCount ?? -1));
  return [...items].sort((a, b) => value(b) - value(a) || b.mentions - a.mentions);
}

/**
 * Turns [P3] / [P3, N1] into links the Markdown renderer shows as citation chips, and a page right after
 * a paper citation — "[P3] (p. 5)" — into a link to that page in the reader (code is left alone).
 */
export function linkCitations(markdown: string) {
  return markdown
    .split(/(```[\s\S]*?```|`[^`]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(CITATION_GROUP, (_m, keys: string) =>
              keys
                .split(/\s*[,;]\s*/)
                .map((k) => `[${k}](#cite-${k})`)
                .join(""),
            )
            .replace(
              /(\[(P\d+)\]\(#cite-P\d+\))\s*\((pp?\.)\s*(\d+)((?:\s*[–-]\s*\d+)?)\)/g,
              (_m, chip: string, key: string, pp: string, page: string, rest: string) =>
                `${chip} [(${pp} ${page}${rest.replace(/\s/g, "")})](#page-${key}-${page})`,
            ),
    )
    .join("");
}
