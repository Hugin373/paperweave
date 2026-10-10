import type { GraphEdgeType, GraphNode } from "@/lib/types";

export type GraphMode = "knowledge" | "citation";

/** Reads the current theme's design tokens (works for light and dark mode). */
export function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    paper: v("--node-paper", "#3d63dd"),
    concept: v("--node-concept", "#c27a14"),
    note: v("--node-note", "#2b8a57"),
    text: v("--text", "#1d1c1a"),
    muted: v("--muted", "#69645c"),
    subtle: v("--subtle", "#8e887e"),
    bg: v("--bg", "#f8f7f4"),
    surface: v("--surface", "#ffffff"),
    border: v("--border", "#e3dfd8"),
    borderStrong: v("--border-strong", "#cfc9bf"),
    accent: v("--accent", "#3150c9"),
    success: v("--success", "#24804a"),
    warning: v("--warning", "#a8670a"),
  };
}

/**
 * A node's fill color — the same rules as the 2D stylesheet below, so the 3D view matches it:
 * a view override ("color by collection") first, then the citation role, then the node type.
 */
export function nodeFill(n: Pick<GraphNode, "type" | "role" | "color">, t: ReturnType<typeof readTokens>) {
  if (n.color) return n.color === "dim" ? t.borderStrong : n.color;
  if (n.role === "center") return t.accent;
  if (n.role === "reference") return t.paper;
  if (n.role === "citation") return t.note;
  if (n.role === "expanded") return t.subtle;
  return n.type === "paper" ? t.paper : n.type === "concept" ? t.concept : t.note;
}

/** The outline a paper node gets: its second collection, or (citation graphs) being in the library. */
export function nodeRing(n: Pick<GraphNode, "role" | "status" | "ring">, t: ReturnType<typeof readTokens>) {
  return n.ring ?? (n.role && n.status ? t.warning : null);
}

export type Position = { x: number; y: number };

/**
 * How a link is drawn in the 2D view: thin solid lines (Obsidian-style), told apart by color —
 * citations gray with an arrow, concept links amber, note links green.
 */
export function edgeLook(type: GraphEdgeType, t: ReturnType<typeof readTokens>) {
  switch (type) {
    case "cites":
      return { color: t.subtle, width: 1, arrow: true };
    case "paper_concept":
    case "concept_concept":
      return { color: t.concept, width: 1, arrow: false };
    default:
      return { color: t.note, width: 1, arrow: false };
  }
}

export const EDGE_LABEL: Record<GraphEdgeType, string> = {
  cites: "cites",
  paper_concept: "linked to concept",
  note_about_paper: "note about paper",
  note_paper: "note references paper",
  note_concept: "note mentions concept",
  note_note: "note links to note",
  concept_concept: "related concept",
};

export function truncateLabel(label: string, max = 42) {
  return label.length > max ? `${label.slice(0, max - 1).trimEnd()}…` : label;
}

/** Visual size: papers by citation count, concepts/notes by number of connections. */
export function nodeSize(node: GraphNode, degree: number) {
  if (node.role === "center") return 54;
  if (node.type === "paper") {
    const c = node.citationCount ?? 0;
    return Math.min(52, 18 + Math.log10(c + 1) * 8 + Math.min(degree, 10));
  }
  if (node.type === "concept") return Math.min(48, 26 + degree * 2.5);
  return Math.min(40, 20 + degree * 2);
}
