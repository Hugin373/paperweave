import { describe, expect, it } from "vitest";
import { mergePatch } from "@/server/papers/ingest";
import type { NormalizedPaper } from "@/server/scholarly/types";

const row = {
  id: "p1",
  ownerWorkspaceId: null,
  source: "openalex" as const,
  title: "Deep learning",
  abstract: null,
  year: 2015,
  publicationDate: null,
  venue: "Nature",
  publicationTypes: ["journal_article"],
  fieldsOfStudy: [],
  authors: [{ name: "Yann LeCun" }],
  authorsText: "Yann LeCun",
  citationCount: 100,
  referenceCount: null,
  influentialCitationCount: null,
  isOpenAccess: null,
  openAccessPdfUrl: null,
  url: null,
  titleNorm: "deep learning",
  firstAuthorNorm: "lecun",
  metadataRefreshedAt: null,
  oaCheckedAt: null,
  arxivCheckedAt: null,
  freeReadUrl: null,
  referencesSyncedAt: null,
  searchVector: "",
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Same authority as the stored row (both aggregators' level) → fill-in only.
const rec: NormalizedPaper = {
  source: "openalex",
  ids: { s2: "abc" },
  title: "Deep Learning (different casing)",
  abstract: "An abstract",
  year: 2016,
  publicationDate: "2015-05-27",
  venue: "Nature Journal",
  publicationTypes: ["review", "other"],
  fieldsOfStudy: ["Computer Science"],
  authors: [{ name: "Y. LeCun", ids: { s2: "1688882" } }],
  citationCount: 90,
  referenceCount: 100,
  influentialCitationCount: 5,
  isOpenAccess: true,
  openAccessPdfUrl: "https://example.org/x.pdf",
  url: "https://example.org",
};

describe("conservative metadata merging", () => {
  it("fills missing fields but never overwrites existing ones", () => {
    const patch = mergePatch(row, rec)!;
    expect(patch.abstract).toBe("An abstract");
    expect(patch.publicationDate).toBe("2015-05-27");
    expect(patch).not.toHaveProperty("title");
    expect(patch).not.toHaveProperty("year");
    expect(patch).not.toHaveProperty("venue");
    expect(patch.referenceCount).toBe(100);
    expect(patch).not.toHaveProperty("citationCount"); // 90 < 100: keep the larger count
    expect(patch.isOpenAccess).toBe(true);
    expect(patch.publicationTypes).toEqual(["journal_article", "review"]);
    expect(patch.authors).toEqual([{ name: "Yann LeCun", ids: { s2: "1688882" } }]);
  });

  it("returns null when there is nothing to change", () => {
    const full = { ...row, ...mergePatch(row, rec) };
    expect(mergePatch(full, rec)).toBeNull();
  });
});

describe("source authority", () => {
  it("lets identifier registries correct core fields from aggregators", () => {
    const corrupted = {
      ...row,
      title: "Unrelated title from a corrupted aggregator record",
      authors: [{ name: "Someone Else" }],
      year: 2018,
    };
    const arxiv: NormalizedPaper = {
      ...rec,
      source: "arxiv",
      title: "BERT: Pre-training of Deep Bidirectional Transformers",
      authors: [{ name: "Jacob Devlin" }],
      year: 2018,
      citationCount: null,
    };
    const patch = mergePatch(corrupted, arxiv)!;
    expect(patch).toMatchObject({
      title: "BERT: Pre-training of Deep Bidirectional Transformers",
      titleNorm: "bert pre training of deep bidirectional transformers",
      authors: [{ name: "Jacob Devlin" }],
      firstAuthorNorm: "devlin",
      source: "arxiv",
    });
    expect(patch).not.toHaveProperty("year");
  });

  it("does not let aggregators override registries", () => {
    const fromArxiv = { ...row, source: "arxiv" as const };
    expect(mergePatch(fromArxiv, { ...rec, source: "openalex" })).not.toHaveProperty("title");
  });
});

describe("OpenReview venues", () => {
  it("replace preprint and workshop venues with a main-venue acceptance, but not a journal", () => {
    const or: NormalizedPaper = { ...rec, source: "openreview", venue: "ICLR 2025 Poster" };
    expect(mergePatch({ ...row, venue: "arXiv.org" }, or)?.venue).toBe("ICLR 2025 Poster");
    expect(mergePatch({ ...row, source: "openreview", venue: "LFDM" }, or)?.venue).toBe("ICLR 2025 Poster");
    expect(mergePatch(row, or)?.venue).toBeUndefined();
    expect(
      mergePatch({ ...row, venue: "arXiv.org" }, { ...or, venue: "Submitted to ICLR 2025" })?.venue,
    ).toBeUndefined();
  });
});
