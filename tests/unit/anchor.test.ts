import { describe, expect, it } from "vitest";
import { anchorHighlight, type PageLayout } from "@/server/files/anchor";

const line = (str: string, y: number) => ({ str, x: 0.1, y, width: str.length * 0.01, height: 0.02 });

describe("re-anchoring highlights", () => {
  const pages: PageLayout[] = [
    [line("We use attention here.", 0.1), line("Results follow.", 0.2)],
    [line("Related work also uses attention here.", 0.1), line("Our attention here is sparse.", 0.3)],
  ];
  const base = { kind: "highlight" as const, pageNumber: 1, rects: [] };

  it("picks the occurrence whose surrounding text matches", () => {
    const placed = anchorHighlight(pages, {
      ...base,
      selectedText: "attention here",
      prefix: "Our",
      suffix: "is sparse",
    });
    expect(placed?.pageNumber).toBe(2);
    expect(placed?.rects[0].y).toBeCloseTo(0.3);
    // "Our " is 4 characters into the line.
    expect(placed?.rects[0].x).toBeCloseTo(0.1 + 4 * 0.01);
  });

  it("ignores whitespace differences between versions", () => {
    const placed = anchorHighlight(pages, { ...base, selectedText: "Results  follow.", prefix: "", suffix: "" });
    expect(placed).toMatchObject({ pageNumber: 1 });
  });

  it("returns null when the text is gone, and keeps page notes where they were", () => {
    expect(anchorHighlight(pages, { ...base, selectedText: "dense convolution", prefix: "", suffix: "" })).toBeNull();
    const note = { kind: "note" as const, pageNumber: 5, rects: [{ x: 0.5, y: 0.5, width: 0, height: 0 }] };
    expect(anchorHighlight(pages, { ...note, selectedText: "", prefix: "", suffix: "" })).toEqual({
      pageNumber: 2,
      rects: note.rects,
    });
  });
});
