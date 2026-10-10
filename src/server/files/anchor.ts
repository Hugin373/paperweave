/**
 * Finding highlights again in a new version of a PDF. A highlight keeps the text it covers plus a
 * little context before and after it (a text-quote anchor); in the new version that text is looked up
 * on every page, and its position becomes the highlight's new rectangles.
 */
import { mergeLineRects } from "@/lib/highlight-geometry";
import type { HighlightRect } from "@/lib/types";

/** One run of text on a page, positioned in page coordinates normalized to 0..1 (y from the top). */
export interface LayoutItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PageLayout = LayoutItem[];

export interface PdfContents {
  /** Plain text per page (for search and AI). */
  texts: string[];
  /** Positioned text per page (for re-anchoring highlights). */
  layouts: PageLayout[];
}

interface TextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
}

/** Reads a PDF's text and text positions, page by page. */
export async function readPdfContents(bytes: Uint8Array): Promise<PdfContents> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js may take ownership of the buffer it is given, so it gets a copy.
  const pdf = await getDocumentProxy(bytes.slice());
  const layouts: PageLayout[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: PageLayout = [];
    for (const raw of content.items as TextItemLike[]) {
      if (!raw.str || !raw.transform) continue;
      const [, , c, d, e, f] = raw.transform;
      const fontHeight = Math.hypot(c, d);
      const [vx, vy] = viewport.convertToViewportPoint(e, f);
      // Like pdf.js's text layer: the glyphs rise about 0.8 of the font height above the baseline.
      items.push({
        str: raw.str,
        x: vx / viewport.width,
        y: (vy - fontHeight * 0.8) / viewport.height,
        width: (raw.width ?? 0) / viewport.width,
        height: fontHeight / viewport.height,
      });
    }
    layouts.push(items);
  }
  const { text } = await extractText(pdf, { mergePages: false });
  const texts = (text as string[]).map((t) =>
    t
      .replace(/\u0000/g, "")
      .replace(/[ \t]+/g, " ")
      .slice(0, 100_000),
  );
  return { texts, layouts };
}

export interface AnchorInput {
  kind: "highlight" | "note";
  pageNumber: number;
  rects: HighlightRect[];
  selectedText: string;
  prefix: string;
  suffix: string;
}

export type AnchorResult = { pageNumber: number; rects: HighlightRect[] } | null;

/** Page text without whitespace, with each character's item and offset (whitespace differs between PDFs). */
interface CompactPage {
  text: string;
  at: { item: number; offset: number }[];
}

const compact = (s: string) => s.replace(/\s+/g, "");

function compactPage(items: PageLayout): CompactPage {
  let text = "";
  const at: CompactPage["at"] = [];
  items.forEach((it, item) => {
    for (let offset = 0; offset < it.str.length; offset++) {
      const ch = it.str[offset];
      if (/\s/.test(ch)) continue;
      text += ch;
      at.push({ item, offset });
    }
  });
  return { text, at };
}

/** How many characters `a` and `b` share at their ends (`fromEnd`) or starts. */
function sharedLength(a: string, b: string, fromEnd: boolean) {
  let n = 0;
  while (n < a.length && n < b.length) {
    const x = fromEnd ? a[a.length - 1 - n] : a[n];
    const y = fromEnd ? b[b.length - 1 - n] : b[n];
    if (x !== y) break;
    n++;
  }
  return n;
}

/** Rectangles covering compact characters [start, end) of a page, one per line. */
function rectsFor(items: PageLayout, page: CompactPage, start: number, end: number): HighlightRect[] {
  const spans = new Map<number, { from: number; to: number }>();
  for (let i = start; i < end; i++) {
    const { item, offset } = page.at[i];
    const span = spans.get(item);
    if (span) span.to = offset + 1;
    else spans.set(item, { from: offset, to: offset + 1 });
  }
  const rects: HighlightRect[] = [];
  for (const [item, { from, to }] of spans) {
    const it = items[item];
    const perChar = it.width / Math.max(1, it.str.length);
    rects.push({ x: it.x + perChar * from, y: it.y, width: perChar * (to - from), height: it.height });
  }
  return mergeLineRects(rects).filter((r) => r.width > 0 && r.height > 0);
}

/**
 * Where a highlight belongs in another version of its PDF, or null when its text is not there any
 * more. Among several matches, the one whose surrounding text matches best (then the nearest to the
 * old page) wins. Page notes have no text: they keep their position, on the same page if it exists.
 */
export function anchorHighlight(layouts: PageLayout[], h: AnchorInput): AnchorResult {
  if (!layouts.length) return null;
  const quote = compact(h.selectedText);
  if (h.kind === "note" || !quote) {
    return { pageNumber: Math.min(Math.max(1, h.pageNumber), layouts.length), rects: h.rects };
  }
  const prefix = compact(h.prefix);
  const suffix = compact(h.suffix);
  let best: { page: number; start: number; score: number } | null = null;
  for (let i = 0; i < layouts.length; i++) {
    const page = compactPage(layouts[i]);
    for (let start = page.text.indexOf(quote); start >= 0; start = page.text.indexOf(quote, start + 1)) {
      const before = page.text.slice(Math.max(0, start - prefix.length), start);
      const after = page.text.slice(start + quote.length, start + quote.length + suffix.length);
      const context = sharedLength(before, prefix, true) + sharedLength(after, suffix, false);
      const score = context * 10 - Math.abs(i + 1 - h.pageNumber);
      if (!best || score > best.score) best = { page: i + 1, start, score };
    }
  }
  if (!best) return null;
  const { page, start } = best;
  const items = layouts[page - 1];
  const rects = rectsFor(items, compactPage(items), start, start + quote.length);
  return rects.length ? { pageNumber: page, rects } : null;
}
