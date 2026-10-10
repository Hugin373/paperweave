import { describe, expect, it } from "vitest";
import { interpretQuery, keywordsFromQuestion, looksLikeQuestion } from "@/lib/query";

describe("natural-language questions without AI", () => {
  it("detects questions", () => {
    expect(looksLikeQuestion("How well do current vision-language models understand 3D spatial relationships?")).toBe(
      true,
    );
    expect(looksLikeQuestion("what is metric depth estimation")).toBe(true);
    expect(looksLikeQuestion("monocular depth estimation")).toBe(false);
    expect(looksLikeQuestion("How")).toBe(false);
  });

  it("keeps the content-bearing terms", () => {
    expect(
      keywordsFromQuestion("How well do current vision-language models understand 3D spatial relationships?"),
    ).toBe("vision-language models 3D spatial relationships");
    expect(keywordsFromQuestion("What are the best approaches for amyloid PET quantification?")).toBe(
      "amyloid PET quantification",
    );
  });

  it("falls back to the original text when stripping removes too much", () => {
    expect(keywordsFromQuestion("What is it?")).toBe("What is it");
  });

  it("leaves keyword queries untouched", () => {
    expect(interpretQuery("  graph neural networks ")).toEqual({ query: "graph neural networks", rewritten: false });
    expect(interpretQuery("Why do transformers need positional encodings?").rewritten).toBe(true);
  });
});
