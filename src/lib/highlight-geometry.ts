/** Page geometry for highlights, shared by the reader and the server (re-anchoring). */
import type { HighlightRect } from "@/lib/types";

/**
 * Merges rects that sit on the same line and touch/overlap horizontally, so a highlight is
 * stored as one rect per line segment instead of one per text span.
 */
export function mergeLineRects(rects: HighlightRect[]): HighlightRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: HighlightRect[] = [];
  for (const r of sorted) {
    const last = lines.at(-1);
    const sameLine =
      last &&
      Math.abs(last.y + last.height / 2 - (r.y + r.height / 2)) < Math.min(last.height, r.height) * 0.6 &&
      r.x <= last.x + last.width + 0.015;
    if (last && sameLine) {
      const x = Math.min(last.x, r.x);
      const y = Math.min(last.y, r.y);
      const right = Math.max(last.x + last.width, r.x + r.width);
      const bottom = Math.max(last.y + last.height, r.y + r.height);
      Object.assign(last, { x, y, width: right - x, height: bottom - y });
    } else {
      lines.push({ ...r });
    }
  }
  // Drop rects fully contained in another (pdf.js sometimes emits duplicates).
  return lines.filter(
    (r, i) =>
      !lines.some(
        (o, j) =>
          j !== i &&
          o.x <= r.x + 1e-4 &&
          o.y <= r.y + 1e-4 &&
          o.x + o.width >= r.x + r.width - 1e-4 &&
          o.y + o.height >= r.y + r.height - 1e-4 &&
          (o.width * o.height > r.width * r.height || j < i),
      ),
  );
}

export function collapseWhitespace(s: string) {
  return s.replace(/\s+/g, " ").trim();
}
