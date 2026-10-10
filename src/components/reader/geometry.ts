import { collapseWhitespace } from "@/lib/highlight-geometry";
import type { HighlightRect } from "@/lib/types";

export { collapseWhitespace, mergeLineRects } from "@/lib/highlight-geometry";

export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** Converts client rects to rects normalized to the page box (0..1), clipped to the page. */
export function normalizeRects(rects: DOMRect[] | DOMRectList, page: DOMRect): HighlightRect[] {
  const out: HighlightRect[] = [];
  for (const r of Array.from(rects)) {
    const left = Math.max(r.left, page.left);
    const right = Math.min(r.right, page.right);
    const top = Math.max(r.top, page.top);
    const bottom = Math.min(r.bottom, page.bottom);
    if (right - left < 1 || bottom - top < 1) continue;
    out.push({
      x: (left - page.left) / page.width,
      y: (top - page.top) / page.height,
      width: (right - left) / page.width,
      height: (bottom - top) / page.height,
    });
  }
  return out;
}

/** Text-quote anchor context (≈32 characters on each side) for a selection on a page. */
export function quoteContext(pageText: string, selected: string, size = 32): { prefix: string; suffix: string } {
  const text = collapseWhitespace(pageText);
  const sel = collapseWhitespace(selected);
  const idx = sel ? text.indexOf(sel) : -1;
  if (idx < 0) return { prefix: "", suffix: "" };
  return {
    prefix: text.slice(Math.max(0, idx - size), idx),
    suffix: text.slice(idx + sel.length, idx + sel.length + size),
  };
}

export function pointInRects(x: number, y: number, rects: HighlightRect[], pad = 0.004) {
  return rects.some((r) => x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad);
}
