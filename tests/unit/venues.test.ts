import { describe, expect, it } from "vitest";
import { aclAnthologyPdf } from "@/server/scholarly/free-pdf";
import { pickVenues } from "@/server/scholarly/providers/openalex";

const src = (id: string, display_name: string, works_count: number, more: Partial<Record<string, unknown>> = {}) => ({
  id: `https://openalex.org/${id}`,
  display_name,
  works_count,
  ...more,
});

describe("venue matching (OpenAlex)", () => {
  const sources = [
    src("S1", "Frontiers in Microbiology", 50_000),
    src("S2", "Frontiers in Aging Neuroscience", 12_000, { abbreviated_title: "Front. Aging Neurosci." }),
    src("S3", "Frontiers in Neurology", 30_000),
    src("S4", "Nature", 400_000),
    src("S5", "Nature Communications", 90_000),
    src("S6", "European Conference on Computer Vision", 9_000, { alternate_titles: ["ECCV"] }),
    src("S7", "The Lancet", 300_000),
  ];

  it("takes the venue a name, short name or alternate name equals", () => {
    expect(pickVenues("Nature", sources, "exact")).toEqual(["S4"]);
    expect(pickVenues("eccv", sources, "exact")).toEqual(["S6"]);
    expect(pickVenues("Front. Aging Neurosci.", sources, "exact")).toEqual(["S2"]);
    expect(pickVenues("Lancet", sources, "exact")).toEqual(["S7"]);
    expect(pickVenues("Frontiers", sources, "exact")).toEqual([]);
    const acl = [src("S8", "Annual Meeting of the Association for Computational Linguistics (ACL)", 12_000)];
    expect(pickVenues("Annual Meeting of the Association for Computational Linguistics", acl, "exact")).toEqual(["S8"]);
    expect(pickVenues("ACL", acl, "exact")).toEqual(["S8"]);
  });

  it("recognizes publishers by name or the start of their name", () => {
    const publishers = [
      src("P1", "Frontiers Media", 400_000),
      src("P2", "Institute of Electrical and Electronics Engineers", 5_000_000, { alternate_titles: ["IEEE"] }),
      src("P3", "Springer Nature", 9_000_000),
    ];
    expect(pickVenues("Frontiers", publishers, "publisher")).toEqual(["P1"]);
    expect(pickVenues("IEEE", publishers, "publisher")).toEqual(["P2"]);
    expect(pickVenues("springer nature", publishers, "publisher")).toEqual(["P3"]);
    expect(pickVenues("Wiley", publishers, "publisher")).toEqual([]);
  });

  it("otherwise groups the venues containing all its words, largest first", () => {
    expect(pickVenues("frontiers", sources, "similar")).toEqual(["S1", "S3", "S2"]);
    expect(pickVenues("frontiers aging", sources, "similar")).toEqual(["S2"]);
    expect(pickVenues("", sources, "similar")).toEqual([]);
  });
});

describe("ACL Anthology PDFs", () => {
  it("follow from the DOI or Semantic Scholar's ACL id", () => {
    expect(aclAnthologyPdf("10.18653/v1/2023.acl-long.1")).toBe("https://aclanthology.org/2023.acl-long.1.pdf");
    expect(aclAnthologyPdf("10.18653/v1/P17-1001")).toBe("https://aclanthology.org/P17-1001.pdf");
    expect(aclAnthologyPdf(null, "2022.emnlp-main.12")).toBe("https://aclanthology.org/2022.emnlp-main.12.pdf");
    expect(aclAnthologyPdf("10.1162/tacl_a_00001")).toBeNull();
    expect(aclAnthologyPdf(null, "../etc/passwd")).toBeNull();
  });
});

describe("venue short names", () => {
  it("adds the full names a short name stands for", async () => {
    const { venueNames } = await import("@/server/scholarly/venues");
    expect(venueNames("TPAMI")).toEqual(["TPAMI", "IEEE Transactions on Pattern Analysis and Machine Intelligence"]);
    expect(venueNames(" neurips ")).toEqual(["neurips", "Neural Information Processing Systems"]);
    expect(venueNames("Sci. Rep.")).toEqual(["Sci. Rep.", "Scientific Reports"]);
    expect(venueNames("Frontiers in Neurology")).toEqual(["Frontiers in Neurology"]);
  });
});
