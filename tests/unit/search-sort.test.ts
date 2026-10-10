import { afterEach, describe, expect, it, vi } from "vitest";
import { arxivTerms } from "@/server/scholarly/providers/arxiv";
import { OpenAlexProvider } from "@/server/scholarly/providers/openalex";
import { SemanticScholarProvider } from "@/server/scholarly/providers/semantic-scholar";

const s2Paper = (i: number) => ({
  paperId: `p${i}`,
  title: `Paper ${i}`,
  year: 2026,
  publicationDate: `2026-09-${String(30 - i).padStart(2, "0")}`,
  authors: [{ authorId: "a", name: "Ada Lovelace" }],
  externalIds: {},
});

function stubFetch(body: unknown) {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe("sorted search", () => {
  it("uses Semantic Scholar's bulk endpoint for most cited, paging from one batch", async () => {
    const urls = stubFetch({ total: 5000, data: Array.from({ length: 25 }, (_, i) => s2Paper(i)) });
    const s2 = new SemanticScholarProvider("key");
    const req = {
      query: 'vision-language "models" (3D)',
      mode: "all" as const,
      filters: { yearFrom: 2020, minCitations: 5 },
      offset: 0,
      limit: 20,
      sort: "citations" as const,
    };
    const first = await s2.search(req);
    const second = await s2.search({ ...req, offset: 20 });

    expect(urls).toHaveLength(1); // the second page comes from the same batch
    const url = urls[0];
    expect(url.pathname).toBe("/graph/v1/paper/search/bulk");
    expect(url.searchParams.get("sort")).toBe("citationCount:desc");
    expect(url.searchParams.get("query")).toBe("vision language models 3D"); // operators removed
    expect(url.searchParams.get("year")).toBe("2020-");
    expect(url.searchParams.get("minCitationCount")).toBe("5");
    expect(first.papers.map((p) => p.title).slice(0, 2)).toEqual(["Paper 0", "Paper 1"]);
    expect(first.total).toBe(25); // only the fetched batch can be paged through
    expect(second.papers.map((p) => p.title)).toEqual(["Paper 20", "Paper 21", "Paper 22", "Paper 23", "Paper 24"]);
  });

  it("leaves relevance search on the regular endpoint", async () => {
    const urls = stubFetch({ total: 1, data: [s2Paper(1)] });
    await new SemanticScholarProvider("key").search({ query: "depth", mode: "all", filters: {}, offset: 0, limit: 10 });
    expect(urls[0].pathname).toBe("/graph/v1/paper/search");
    expect(urls[0].searchParams.has("sort")).toBe(false);
  });

  it("asks OpenAlex for title/abstract matches sorted by citations", async () => {
    const urls = stubFetch({ results: [], meta: { count: 0 } });
    await new OpenAlexProvider().search({
      query: "monocular depth",
      mode: "all",
      filters: {},
      offset: 0,
      limit: 10,
      sort: "citations",
    });
    expect(urls[0].searchParams.get("sort")).toBe("cited_by_count:desc");
    expect(urls[0].searchParams.has("search")).toBe(false);
    expect(urls[0].searchParams.get("filter")).toBe("title_and_abstract.search:monocular depth");
  });

  it("searches arXiv for the phrase first, then for all words", async () => {
    const feed = (ids: string[]) =>
      `<feed>${ids.map((id) => `<entry><id>http://arxiv.org/abs/${id}v1</id><title>Paper ${id}</title><published>2026-10-06T10:00:00Z</published></entry>`).join("")}</feed>`;
    const urls: URL[] = [];
    const bodies = [feed(["2610.00001"]), feed(["2610.00001", "2610.00002"])];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        urls.push(new URL(String(input)));
        return new Response(bodies.shift(), { status: 200, headers: { "content-type": "application/atom+xml" } });
      }),
    );
    const { ArxivProvider } = await import("@/server/scholarly/providers/arxiv");
    const arxiv = new ArxivProvider();
    (arxiv as unknown as { throttle: { wait: () => Promise<void> } }).throttle = { wait: async () => {} };
    const papers = await arxiv.searchLatest("Monocular depth estimation", 5);
    expect(urls.map((u) => u.searchParams.get("search_query"))).toEqual([
      'ti:"monocular depth estimation" OR abs:"monocular depth estimation"',
      "(ti:monocular OR abs:monocular) AND (ti:depth OR abs:depth) AND (ti:estimation OR abs:estimation)",
    ]);
    expect(urls[0].searchParams.get("sortBy")).toBe("submittedDate");
    expect(papers.map((p) => p.ids.arxiv)).toEqual(["2610.00001", "2610.00002"]);
  });

  it("builds arXiv terms from a query", () => {
    expect(arxivTerms("Vision-Language models for 3D spatial reasoning and the like")).toEqual([
      "vision",
      "language",
      "models",
      "3d",
      "spatial",
      "reasoning",
      "like",
    ]);
    expect(arxivTerms("??")).toEqual([]);
  });
});
