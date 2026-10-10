import type { ReadingStatus } from "./types";

export function formatAuthors(authors: string[], max = 3): string {
  if (!authors.length) return "Unknown authors";
  if (authors.length <= max) return authors.join(", ");
  return `${authors.slice(0, max).join(", ")} et al.`;
}

export function shortAuthors(authors: string[]): string {
  if (!authors.length) return "";
  const family = authors[0].split(/\s+/).at(-1) ?? authors[0];
  return authors.length > 1 ? `${family} et al.` : family;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export const STATUS_LABEL: Record<ReadingStatus, string> = {
  saved: "Saved",
  reading: "Reading",
  read: "Read",
  archived: "Archived",
};

export const STATUS_TONE: Record<ReadingStatus, "neutral" | "warning" | "success" | "outline"> = {
  saved: "neutral",
  reading: "warning",
  read: "success",
  archived: "outline",
};

export const PUBLICATION_TYPE_LABEL: Record<string, string> = {
  journal_article: "Journal article",
  conference: "Conference paper",
  preprint: "Preprint",
  review: "Review",
  book: "Book",
  dataset: "Dataset",
  dissertation: "Dissertation",
};

/** Splits a server snippet with ⟦highlight⟧ markers into parts for safe rendering. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const re = /⟦([^⟧]*)⟧/g;
  let last = 0;
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[1], hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}
