import { describe, expect, it } from "vitest";
import { citationKey, escapeBib, parseBibtex, toBibtex } from "@/server/export/bibtex";

describe("BibTeX export", () => {
  const paper = {
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani", "Noam Shazeer"],
    year: 2017,
    venue: "Neural Information Processing Systems",
    publicationTypes: ["conference"],
    abstract: "Uses 100% attention & no recurrence_",
    url: null,
    ids: { arxiv: "1706.03762", doi: "10.5555/3295222" },
  };

  it("builds stable citation keys", () => {
    expect(citationKey(paper)).toBe("vaswani2017attention");
  });

  it("escapes LaTeX special characters", () => {
    expect(escapeBib("A & B_c 50% {x}")).toBe("A \\& B\\_c 50\\% \\{x\\}");
  });

  it("produces entries with identifiers", () => {
    const bib = toBibtex([paper, { ...paper }]);
    expect(bib).toContain("@inproceedings{vaswani2017attention,");
    expect(bib).toContain("@inproceedings{vaswani2017attentiona,");
    expect(bib).toContain("booktitle = {Neural Information Processing Systems}");
    expect(bib).toContain("doi = {10.5555/3295222}");
    expect(bib).toContain("eprint = {1706.03762}");
    expect(bib).toContain("author = {Ashish Vaswani and Noam Shazeer}");
  });

  it("round-trips through the parser", () => {
    const { entries } = parseBibtex(toBibtex([paper]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      year: 2017,
      doi: "10.5555/3295222",
      arxiv: "1706.03762",
    });
  });
});

describe("BibTeX import parsing", () => {
  it("reads Zotero-style entries and tolerates broken ones", () => {
    const { entries, errors } = parseBibtex(`
      @article{he2016,
        title = {Deep {Residual} Learning for Image Recognition},
        author = {He, Kaiming and Zhang, Xiangyu},
        journaltitle = {CVPR}, date = {2016-06},
        doi = {https://doi.org/10.1109/CVPR.2016.90}
      }
      @misc{arx, title={A preprint}, url={https://arxiv.org/abs/2411.16537v1}}
      @broken{`);
    expect(errors).toBeGreaterThan(0);
    expect(entries[0]).toMatchObject({
      title: "Deep Residual Learning for Image Recognition",
      year: 2016,
      doi: "10.1109/cvpr.2016.90",
      venue: "CVPR",
    });
    expect(entries[1]).toMatchObject({ arxiv: "2411.16537" });
  });
});
