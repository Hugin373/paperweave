import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseArxivFeed } from "@/server/scholarly/providers/arxiv";
import { mapCrossrefWork, stripJats } from "@/server/scholarly/providers/crossref";
import { mapOpenAlexWork, rebuildAbstract } from "@/server/scholarly/providers/openalex";
import { mapS2Paper } from "@/server/scholarly/providers/semantic-scholar";
import { normalizePublicationType } from "@/server/scholarly/publication-types";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

describe("Semantic Scholar mapping", () => {
  it("normalizes identifiers, venue, types and authors", () => {
    const p = mapS2Paper(JSON.parse(fixture("s2-paper.json")))!;
    expect(p.source).toBe("semantic_scholar");
    expect(p.ids).toEqual({
      s2: "204e3073870fae3d05bcbc2f6a8e263d9b72e776",
      doi: "10.48550/arxiv.1706.03762",
      arxiv: "1706.03762",
      corpus: "13756489",
    });
    expect(p.venue).toBe("Neural Information Processing Systems");
    expect(p.publicationTypes).toEqual(["journal_article", "conference"]);
    expect(p.authors[0]).toEqual({ name: "Ashish Vaswani", ids: { s2: "40348417" } });
    expect(p.citationCount).toBe(150000);
    // Empty openAccessPdf URLs are ignored; arXiv papers fall back to the arXiv PDF.
    expect(p.openAccessPdfUrl).toBe("https://arxiv.org/pdf/1706.03762");
  });

  it("skips records without id or title", () => {
    expect(mapS2Paper({ paperId: null, title: "x" })).toBeNull();
    expect(mapS2Paper({ paperId: "abc", title: null })).toBeNull();
  });
});

describe("OpenAlex mapping", () => {
  it("maps a real work record", () => {
    const p = mapOpenAlexWork(JSON.parse(fixture("openalex-work.json")))!;
    expect(p.source).toBe("openalex");
    expect(p.ids.openalex).toMatch(/^W\d+$/);
    expect(p.ids.doi).toBe("10.1038/nature14539");
    expect(p.title).toBe("Deep learning");
    expect(p.year).toBe(2015);
    expect(p.authors.map((a) => a.name)).toContain("Yann LeCun");
    expect(p.citationCount).toBeGreaterThan(1000);
  });

  it("rebuilds abstracts from inverted indexes", () => {
    expect(rebuildAbstract({ world: [1], Hello: [0], again: [3], "!": [2] })).toBe("Hello world ! again");
    expect(rebuildAbstract(null)).toBeNull();
  });
});

describe("Crossref mapping", () => {
  it("maps DOI metadata", () => {
    const p = mapCrossrefWork(JSON.parse(fixture("crossref-work.json")))!;
    expect(p.ids).toEqual({ doi: "10.1038/nature14539" });
    expect(p.title).toBe("Deep learning");
    expect(p.venue).toBe("Nature");
    expect(p.year).toBe(2015);
    expect(p.authors.length).toBe(3);
  });

  it("strips JATS markup from abstracts", () => {
    expect(stripJats("<jats:title>Abstract</jats:title><jats:p>We study <jats:italic>x</jats:italic>.</jats:p>")).toBe(
      "We study x .",
    );
  });
});

describe("arXiv mapping", () => {
  it("parses the Atom feed", () => {
    const [p] = parseArxivFeed(fixture("arxiv-feed.xml"));
    expect(p.ids.arxiv).toBe("1706.03762");
    expect(p.title).toBe("Attention Is All You Need");
    expect(p.authors[0].name).toBe("Ashish Vaswani");
    expect(p.openAccessPdfUrl).toBe("https://arxiv.org/pdf/1706.03762");
    expect(p.publicationTypes).toEqual(["preprint"]);
  });

  it("ignores error entries", () => {
    expect(
      parseArxivFeed(
        "<feed xmlns='http://www.w3.org/2005/Atom'><entry><id>http://arxiv.org/api/errors</id><title>Error</title></entry></feed>",
      ),
    ).toEqual([]);
  });
});

describe("publication types", () => {
  it.each([
    ["JournalArticle", "journal_article"],
    ["proceedings-article", "conference"],
    ["posted-content", "preprint"],
    ["book-chapter", "book"],
    ["Editorial", "other"],
  ])("%s → %s", (raw, expected) => expect(normalizePublicationType(raw)).toBe(expected));
});
