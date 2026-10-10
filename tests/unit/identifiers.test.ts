import { describe, expect, it } from "vitest";
import {
  detectIdentifier,
  normalizeArxivId,
  normalizeAuthorFamilyName,
  normalizeDoi,
  normalizeTitle,
} from "@/lib/identifiers";

describe("normalizeDoi", () => {
  it.each([
    ["10.1038/nature14539", "10.1038/nature14539"],
    ["https://doi.org/10.1038/NATURE14539", "10.1038/nature14539"],
    ["doi:10.1145/3292500.3330701.", "10.1145/3292500.3330701"],
    ["http://dx.doi.org/10.1000/xyz123)", "10.1000/xyz123"],
  ])("%s → %s", (input, expected) => expect(normalizeDoi(input)).toBe(expected));

  it("rejects non-DOIs", () => {
    expect(normalizeDoi("hello world")).toBeNull();
    expect(normalizeDoi(null)).toBeNull();
  });
});

describe("normalizeArxivId", () => {
  it.each([
    ["1706.03762", "1706.03762"],
    ["arXiv:1706.03762v5", "1706.03762"],
    ["https://arxiv.org/abs/2411.16537v2", "2411.16537"],
    ["https://arxiv.org/pdf/2411.16537v2.pdf", "2411.16537"],
    ["10.48550/arXiv.1706.03762", "1706.03762"],
    ["hep-th/9901001v1", "hep-th/9901001"],
  ])("%s → %s", (input, expected) => expect(normalizeArxivId(input)).toBe(expected));
});

describe("detectIdentifier", () => {
  it.each([
    ["10.1038/nature14539", { kind: "doi", value: "10.1038/nature14539" }],
    ["doi: 10.1038/nature14539", { kind: "doi", value: "10.1038/nature14539" }],
    ["https://doi.org/10.1038/nature14539", { kind: "doi", value: "10.1038/nature14539" }],
    ["arXiv:1706.03762", { kind: "arxiv", value: "1706.03762" }],
    ["https://arxiv.org/abs/1706.03762v7", { kind: "arxiv", value: "1706.03762" }],
    ["1706.03762", { kind: "arxiv", value: "1706.03762" }],
    [
      "https://www.semanticscholar.org/paper/Attention-is-All-you-Need-Vaswani/204e3073870fae3d05bcbc2f6a8e263d9b72e776",
      { kind: "s2", value: "204e3073870fae3d05bcbc2f6a8e263d9b72e776" },
    ],
    ["https://openalex.org/W2919115771", { kind: "openalex", value: "W2919115771" }],
    ["PMID:26017442", { kind: "pmid", value: "26017442" }],
    ["https://pubmed.ncbi.nlm.nih.gov/26017442/", { kind: "pmid", value: "26017442" }],
    ["PMC4567890", { kind: "pmcid", value: "PMC4567890" }],
    ["https://www.nature.com/articles/10.1038/nature14539", { kind: "doi", value: "10.1038/nature14539" }],
  ])("recognizes %s", (input, expected) => expect(detectIdentifier(input)).toEqual(expected));

  it("treats keyword queries as non-identifiers", () => {
    expect(detectIdentifier("vision language models")).toBeNull();
    expect(detectIdentifier("attention is all you need")).toBeNull();
    expect(detectIdentifier("2017")).toBeNull();
  });
});

describe("normalization for duplicate detection", () => {
  it("normalizes titles", () => {
    expect(normalizeTitle("Attention Is <i>All</i> You Need!")).toBe("attention is all you need");
    expect(normalizeTitle("Über-Modelle: Ein Überblick")).toBe("uber modelle ein uberblick");
  });
  it("extracts family names", () => {
    expect(normalizeAuthorFamilyName("Ashish Vaswani")).toBe("vaswani");
    expect(normalizeAuthorFamilyName("Vaswani, Ashish")).toBe("vaswani");
    expect(normalizeAuthorFamilyName("José García")).toBe("garcia");
    expect(normalizeAuthorFamilyName("")).toBeNull();
  });
});

describe("author family names across name formats", () => {
  it("finds the surname in given-first, surname-first-with-initials and comma forms", async () => {
    const { normalizeAuthorFamilyName } = await import("@/lib/identifiers");
    for (const name of ["Amine Bedoui", "A. Bedoui", "Bedoui A", "Bedoui, Amine", "Bedoui AJ", "Bedoui A.J."]) {
      expect(normalizeAuthorFamilyName(name), name).toBe("bedoui");
    }
    expect(normalizeAuthorFamilyName("J. K. van der Berg")).toBe(normalizeAuthorFamilyName("van der Berg JK"));
    expect(normalizeAuthorFamilyName("Kaiming He")).toBe("he");
    expect(normalizeAuthorFamilyName("Li Q")).toBe("li");
  });
});
