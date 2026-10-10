import type { Position } from "./graph-style";

type Placeable = { id: string; year?: number | null };

const ROW_GAP = 62;
const COLUMN_GAP = 210;
const MAX_PER_COLUMN = 12;

const byYear = (a: Placeable, b: Placeable) => (a.year ?? 9999) - (b.year ?? 9999);

/**
 * Lineage layout: the focus paper in the middle, earlier work (references) to the left and
 * later work (citing papers) to the right, each column ordered by year from top to bottom.
 */
export function lineagePositions(center: string, references: Placeable[], citations: Placeable[]) {
  const pos: Record<string, Position> = { [center]: { x: 0, y: 0 } };
  const place = (items: Placeable[], dir: -1 | 1) => {
    const sorted = [...items].sort(byYear);
    const columns = Math.max(1, Math.ceil(sorted.length / MAX_PER_COLUMN));
    sorted.forEach((item, i) => {
      const col = Math.floor(i / MAX_PER_COLUMN);
      const inCol = col === columns - 1 ? sorted.length - col * MAX_PER_COLUMN : MAX_PER_COLUMN;
      const row = i % MAX_PER_COLUMN;
      pos[item.id] = {
        x: dir * (360 + col * COLUMN_GAP),
        y: (row - (inCol - 1) / 2) * ROW_GAP + (col % 2) * (ROW_GAP / 2),
      };
    });
  };
  place(references, -1);
  place(citations, 1);
  return pos;
}

/** Positions for papers added by expanding `anchor`, avoiding existing nodes. */
export function expansionPositions(
  anchor: Position,
  references: Placeable[],
  citations: Placeable[],
  existing: Record<string, Position>,
) {
  const taken = Object.values(existing);
  const out: Record<string, Position> = {};
  const free = (p: Position) =>
    ![...taken, ...Object.values(out)].some((q) => Math.abs(q.x - p.x) < 150 && Math.abs(q.y - p.y) < 42);
  const place = (items: Placeable[], dir: -1 | 1) => {
    const sorted = [...items].sort(byYear);
    const x = anchor.x + dir * 250;
    sorted.forEach((item, i) => {
      let y = anchor.y + (i - (sorted.length - 1) / 2) * 52;
      let p = { x, y };
      for (let step = 1; !free(p) && step < 60; step++) {
        y = anchor.y + (i - (sorted.length - 1) / 2) * 52 + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 46;
        p = { x: x + (step > 20 ? dir * 160 : 0), y };
      }
      out[item.id] = p;
    });
  };
  place(references, -1);
  place(citations, 1);
  return out;
}
