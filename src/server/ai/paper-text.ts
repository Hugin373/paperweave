/**
 * The text of a paper that AI tasks read, and what was included. The workspace's own PDF comes
 * first; without one, the legal open-access copy is read (kept briefly in memory, not stored), then
 * PubMed Central's full text. Long papers are fitted to the model's context without dropping pages:
 * the reference list is left out, then pages are shortened evenly.
 */
import { and, desc, eq } from "drizzle-orm";
import type { AiBasis } from "@/lib/types";
import { db } from "@/server/db/client";
import { paperFilePages, paperFiles } from "@/server/db/schema";
import { openAccessPageTexts } from "@/server/files/service";
import { identifiersFor } from "@/server/papers/service";
import { scholarly } from "@/server/scholarly/service";
import type { AIProvider } from "./types";

export interface PaperText {
  source: Exclude<AiBasis["source"], "abstract">;
  unit: AiBasis["unit"];
  /** Pages (or sections) in order; `n` is 1-based. */
  parts: { n: number; text: string }[];
}

export const ABSTRACT_BASIS: AiBasis = {
  source: "abstract",
  unit: "page",
  total: 0,
  included: [],
  selection: "whole",
  skippedReferences: 0,
  condensed: false,
};

/** The newest PDF in the workspace whose text has been extracted. */
export async function readyFile(workspaceId: string, paperId: string) {
  const [file] = await db
    .select({ id: paperFiles.id })
    .from(paperFiles)
    .where(
      and(eq(paperFiles.workspaceId, workspaceId), eq(paperFiles.paperId, paperId), eq(paperFiles.textStatus, "ready")),
    )
    .orderBy(desc(paperFiles.createdAt))
    .limit(1);
  return file ?? null;
}

/** The best full text available for a paper, or null when only the abstract is. */
export async function loadPaperText(workspaceId: string, paperId: string): Promise<PaperText | null> {
  const file = await readyFile(workspaceId, paperId);
  if (file) {
    const pages = await db
      .select({ n: paperFilePages.pageNumber, text: paperFilePages.text })
      .from(paperFilePages)
      .where(eq(paperFilePages.fileId, file.id))
      .orderBy(paperFilePages.pageNumber);
    const parts = pages.filter((p) => p.text.trim());
    if (parts.length) return { source: "pdf", unit: "page", parts };
  }
  const open = await openAccessPageTexts(workspaceId, paperId).catch(() => null);
  if (open?.some((t) => t.trim())) {
    return {
      source: "open_access",
      unit: "page",
      parts: open.map((text, i) => ({ n: i + 1, text })).filter((p) => p.text.trim()),
    };
  }
  const pmcid = (await identifiersFor([paperId])).get(paperId)?.pmcid;
  const sections = pmcid
    ? await scholarly()
        .pmcFullText(pmcid)
        .catch(() => null)
    : null;
  if (sections?.length)
    return { source: "pmc", unit: "section", parts: sections.map((text, i) => ({ n: i + 1, text })) };
  return null;
}

/** Characters of paper text a provider is given for whole-paper tasks and for questions. */
export function contextBudget(provider: Pick<AIProvider, "kind" | "local">) {
  // Self-hosted models often have small context windows; hosted models take a whole paper. Local models get
  // what their Context setting says.
  const small =
    provider.kind === "ollama" || provider.kind === "openai_compatible" || provider.local?.context === "low";
  return small ? { whole: 48_000, question: 24_000 } : { whole: 200_000, question: 64_000 };
}

const REFERENCES_HEADING = /^\s*(references|bibliography|literature cited|works cited|reference list)\s*$/im;
const CITATION_LINE =
  /^\s*\[\d{1,3}\]|^\s*\d{1,3}\.\s+\p{Lu}|\b(?:19|20)\d{2}[a-z]?\b\s*[.,);:]|\bet al\.|arxiv|\bdoi\b|\bpp\.|proceedings|conference|journal|\bin:/iu;

/** The share of a text's lines that look like parts of bibliography entries. */
function citationShare(text: string) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 6) return 0;
  return lines.filter((l) => CITATION_LINE.test(l)).length / lines.length;
}

/**
 * Whether a page reads like (a continuation of) a reference list. Entries wrap over several lines
 * and only some lines carry a year, venue or "et al.", so a third of the lines is a strong signal.
 */
export function looksLikeReferences(text: string) {
  return citationShare(text) >= 0.3;
}

/**
 * The reference list's extent: from the page with the "References" heading (after the first
 * quarter of the paper) through the following pages that read like bibliography entries, allowing
 * one weaker page in between. Appendices after it are kept. Null when none is recognized.
 */
export function referenceList(parts: PaperText["parts"]): { start: number; cut: number; end: number } | null {
  for (let i = Math.max(1, Math.floor(parts.length / 4)); i < parts.length; i++) {
    const m = REFERENCES_HEADING.exec(parts[i].text);
    if (!m) continue;
    const after = parts[i].text.slice(m.index + m[0].length);
    // A "References" line followed by ordinary prose is something else (e.g. a section about references).
    if (after.trim().split("\n").length >= 6 && !looksLikeReferences(after)) continue;
    let end = i;
    for (;;) {
      if (end + 1 < parts.length && looksLikeReferences(parts[end + 1].text)) end++;
      else if (
        end + 2 < parts.length &&
        citationShare(parts[end + 1].text) >= 0.15 &&
        looksLikeReferences(parts[end + 2].text)
      )
        end += 2;
      else break;
    }
    return { start: i, cut: m.index, end };
  }
  return null;
}

/** Leaves out the reference list (keeping the text before its heading); returns how many pages went. */
function withoutReferences(parts: PaperText["parts"]) {
  const refs = referenceList(parts);
  if (!refs) return { parts, skipped: 0 };
  const head = parts[refs.start].text.slice(0, refs.cut).trim();
  return {
    parts: [
      ...parts.slice(0, refs.start),
      ...(head ? [{ n: parts[refs.start].n, text: head }] : []),
      ...parts.slice(refs.end + 1),
    ],
    skipped: refs.end - refs.start + (head ? 0 : 1),
  };
}

/** Shortens parts evenly (short parts keep their full text) so the total fits the budget. */
function fitParts(parts: PaperText["parts"], budget: number) {
  const overhead = parts.length * 16;
  let left = Math.max(0, budget - overhead);
  const caps = new Map<number, number>();
  const bySize = [...parts].sort((a, b) => a.text.length - b.text.length);
  bySize.forEach((p, i) => {
    const take = Math.min(p.text.length, Math.floor(left / (bySize.length - i)));
    caps.set(p.n, take);
    left -= take;
  });
  return {
    parts: parts.map((p) => ({ n: p.n, text: p.text.slice(0, caps.get(p.n)) })),
    condensed: parts.some((p) => caps.get(p.n)! < p.text.length),
  };
}

function render(t: PaperText, parts: PaperText["parts"]) {
  const label = t.unit === "section" ? "Section" : "Page";
  return parts.map((p) => `[${label} ${p.n}]\n${p.text.trim()}`).join("\n\n");
}

/** The whole paper for summaries and other paper-level tasks, fitted to the budget. */
export function wholePaper(t: PaperText, budget: number): { body: string; basis: AiBasis } {
  const trimmed = t.parts.map((p) => ({ ...p, text: p.text.trim() }));
  const { parts, skipped: skippedReferences } =
    t.unit === "page" ? withoutReferences(trimmed) : { parts: trimmed, skipped: 0 };
  const fitted = fitParts(parts, budget);
  return {
    body: render(
      t,
      fitted.parts.filter((p) => p.text),
    ),
    basis: {
      source: t.source,
      unit: t.unit,
      total: t.parts.length,
      included: fitted.parts.filter((p) => p.text).map((p) => p.n),
      selection: "whole",
      skippedReferences,
      condensed: fitted.condensed,
    },
  };
}

/** Parses "5-8" / "7" into an inclusive range; null when it is not one. */
export function pageRange(spec: string): { from: number; to: number } | null {
  const m = /^(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?$/.exec(spec.trim());
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2] ?? m[1]);
  return from >= 1 && to >= from ? { from, to } : null;
}

/** Specific pages (or sections) in order, at most `maxParts`, shortened evenly to fit the budget. */
export function partsInRange(t: PaperText, range: { from: number; to: number }, budget: number, maxParts = 8) {
  const wanted = t.parts.filter((p) => p.n >= range.from && p.n <= range.to).slice(0, maxParts);
  const fitted = fitParts(
    wanted.map((p) => ({ ...p, text: p.text.trim() })),
    budget,
  );
  return {
    body: render(
      t,
      fitted.parts.filter((p) => p.text),
    ),
    included: fitted.parts.map((p) => p.n),
  };
}

/** Question words reduced to a short prefix, so "segmentation" also matches "segmenting". */
function stems(question: string) {
  return [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^\p{L}\p{N}-]+/u)
        .filter((w) => w.length > 3)
        .map((w) => w.slice(0, 6)),
    ),
  ];
}

/** The first page plus the pages most relevant to a question, in order, within the budget. */
export function relevantParts(t: PaperText, question: string, budget: number): { body: string; basis: AiBasis } {
  const words = stems(question);
  const perPart = Math.min(12_000, Math.floor(budget / 3));
  // The reference list only helps questions about citations.
  const candidates =
    t.unit === "page" && !/\b(cit|refer|bibliograph|related work|prior work)/i.test(question)
      ? withoutReferences(t.parts).parts
      : t.parts;
  const scored = candidates.map((p, i) => {
    const lower = p.text.toLowerCase();
    return { ...p, i, score: words.reduce((n, w) => n + (lower.split(w).length - 1), 0) };
  });
  const order = [scored[0], ...scored.slice(1).sort((a, b) => b.score - a.score || a.i - b.i)].filter(Boolean);
  const chosen: typeof scored = [];
  let size = 0;
  for (const p of order) {
    if (chosen.length > 0 && words.length && p.score === 0 && chosen.length >= 4) break;
    const len = Math.min(p.text.length, perPart) + 16;
    if (size + len > budget) continue;
    chosen.push(p);
    size += len;
  }
  chosen.sort((a, b) => a.i - b.i);
  const parts = chosen.map((p) => ({ n: p.n, text: p.text.trim().slice(0, perPart) }));
  return {
    body: render(t, parts),
    basis: {
      source: t.source,
      unit: t.unit,
      total: t.parts.length,
      included: parts.map((p) => p.n),
      selection: "relevant",
      skippedReferences: 0,
      condensed: chosen.some((p) => p.text.trim().length > perPart),
    },
  };
}
