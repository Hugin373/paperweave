import { describe, expect, it } from "vitest";
import { describeBasis, pageRanges } from "@/lib/ai-basis";
import { looksLikeReferences, referenceList, relevantParts, wholePaper, type PaperText } from "@/server/ai/paper-text";

const prose = (topic: string, lines = 12) =>
  Array.from({ length: lines }, (_, i) => `We study ${topic} in setting ${i} and report what we find there`).join("\n");
const refs = (from: number) =>
  Array.from({ length: 12 }, (_, i) =>
    i % 2 === 0
      ? `[${from + i}] A. Author, B. Author, et al. A study of things. In Proceedings of CVPR, 2021.`
      : "Some continued title words for the entry",
  ).join("\n");

function paper(pages: string[]): PaperText {
  return { source: "pdf", unit: "page", parts: pages.map((text, i) => ({ n: i + 1, text })) };
}

describe("paper text for AI", () => {
  const p = paper([
    prose("depth estimation"),
    prose("the method"),
    prose("datasets and evaluation"),
    prose("results") + "\nReferences\n" + refs(1),
    refs(13),
    prose("appendix proofs"),
  ]);

  it("recognizes the reference list and keeps appendices after it", () => {
    expect(looksLikeReferences(refs(1))).toBe(true);
    expect(looksLikeReferences(prose("x"))).toBe(false);
    expect(referenceList(p.parts)).toMatchObject({ start: 3, end: 4 });
    const { body, basis } = wholePaper(p, 100_000);
    expect(body).toContain("We study results");
    expect(body).not.toContain("[13] A. Author");
    expect(body).toContain("[Page 6]\nWe study appendix proofs");
    expect(basis).toMatchObject({ included: [1, 2, 3, 4, 6], total: 6, skippedReferences: 1, condensed: false });
  });

  it("shortens long pages evenly instead of dropping the end of the paper", () => {
    const long = paper([prose("intro", 400), "short page", prose("conclusion", 400)]);
    const { body, basis } = wholePaper(long, 20_000);
    expect(body.length).toBeLessThanOrEqual(20_000);
    expect(body).toContain("short page");
    expect(body).toContain("[Page 3]\nWe study conclusion");
    expect(basis).toMatchObject({ included: [1, 2, 3], condensed: true });
  });

  it("picks the first page and the pages matching a question, without references", () => {
    const { body, basis } = relevantParts(p, "Which datasets are used for evaluation?", 2_000);
    expect(basis.selection).toBe("relevant");
    expect(basis.included[0]).toBe(1);
    expect(basis.included).toContain(3);
    expect(body).not.toContain("et al.");
    expect(relevantParts(p, "Which papers does it cite?", 100_000).body).toContain("et al.");
  });

  it("describes what was read", () => {
    expect(pageRanges([5, 1, 2, 3, 9])).toBe("1–3, 5, 9");
    expect(describeBasis(wholePaper(p, 100_000).basis)).toBe(
      "Read the full text: 5 of 6 pages of your PDF (reference list skipped).",
    );
    expect(
      describeBasis({
        source: "open_access",
        unit: "page",
        total: 9,
        included: [1, 4, 5],
        selection: "relevant",
        skippedReferences: 0,
        condensed: false,
      }),
    ).toBe("Read pages 1, 4–5 of 9 (the ones matching your question, not saved) from the free open-access copy.");
    expect(
      describeBasis({
        source: "abstract",
        unit: "page",
        total: 0,
        included: [],
        selection: "whole",
        skippedReferences: 0,
        condensed: false,
      }),
    ).toMatch(/abstract only/);
  });
});
