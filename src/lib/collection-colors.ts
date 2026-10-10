/**
 * Collection colors: one even-lightness palette (OKLCH L≈0.64–0.79) that reads on both the light and
 * dark themes and stays distinguishable as graph nodes. Listed in hue order for the color picker.
 */
export const COLLECTION_COLORS = [
  "#5889e6", // blue
  "#3bacda", // sky
  "#25aea7", // teal
  "#37ab6b", // green
  "#85b749", // lime
  "#ecae30", // amber
  "#e78537", // orange
  "#e15955", // red
  "#df5e97", // pink
  "#9e66d7", // violet
];

/** The order new collections receive colors in, so neighbouring collections get far-apart hues. */
export const AUTO_COLOR_ORDER = [
  "#5889e6",
  "#e78537",
  "#37ab6b",
  "#df5e97",
  "#25aea7",
  "#ecae30",
  "#9e66d7",
  "#e15955",
  "#85b749",
  "#3bacda",
];

/** Earlier palette → its closest color in the current one (older rows are migrated, this covers stragglers). */
const LEGACY: Record<string, string> = {
  "#3150c9": "#5889e6",
  "#2b8a57": "#37ab6b",
  "#c27a14": "#ecae30",
  "#b8432f": "#e15955",
  "#7b4bc4": "#9e66d7",
  "#0f7c8a": "#25aea7",
  "#69645c": "#3bacda",
  "#c2417a": "#df5e97",
  "#4f7a12": "#85b749",
  "#2f6fb5": "#3bacda",
};

/** The least-used palette color, for a new collection created without one. */
export function nextCollectionColor(used: (string | null)[]): string {
  const counts = new Map(AUTO_COLOR_ORDER.map((c) => [c, 0]));
  for (const c of used) {
    const key = c && (LEGACY[c.toLowerCase()] ?? c.toLowerCase());
    if (key && counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  const fewest = Math.min(...counts.values());
  return AUTO_COLOR_ORDER.find((c) => counts.get(c) === fewest)!;
}

export function collectionColor(c: { id: string; color: string | null }): string {
  if (c.color) return LEGACY[c.color.toLowerCase()] ?? c.color;
  let h = 0;
  for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return AUTO_COLOR_ORDER[Math.abs(h) % AUTO_COLOR_ORDER.length];
}
