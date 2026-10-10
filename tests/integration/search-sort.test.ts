import { beforeAll, describe, expect, it } from "vitest";
import { discover } from "@/server/papers/discovery";
import { createUser, FakeProvider, installFakeScholarly, paper } from "./helpers";

const corpus = [
  paper({ title: "Sparse attention survey", ids: { s2: "ss-1" }, year: 2019, citationCount: 900 }),
  paper({ title: "Sparse attention for long documents", ids: { s2: "ss-2" }, year: 2024, citationCount: 40 }),
  paper({ title: "Sparse attention kernels", ids: { s2: "ss-3" }, year: 2022, citationCount: 300 }),
];
const preprints = [
  paper({ title: "Sparse attention at scale", ids: { arxiv: "2610.01234" }, year: 2026, citationCount: 0 }),
  // Already among the main results: not repeated in the preprint section.
  paper({ title: "Sparse attention for long documents", ids: { s2: "ss-2" }, year: 2024 }),
];

describe("sorted search and latest preprints", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  const search = (sort?: "relevance" | "newest" | "citations") =>
    discover(ctx.workspaceId, { q: "sparse attention", mode: "all", filters: {}, offset: 0, limit: 10, sort });

  beforeAll(async () => {
    const arxiv = new FakeProvider("arxiv", preprints);
    await installFakeScholarly(new FakeProvider("semantic_scholar", corpus), arxiv);
    ctx = await createUser("Sorter");
  });

  it("orders by newest or most cited, and adds the newest arXiv preprints for newest first", async () => {
    const newest = await search("newest");
    expect(newest.items.map((p) => p.year)).toEqual([2024, 2022, 2019]);
    expect(newest.latestPreprints?.map((p) => p.title)).toEqual(["Sparse attention at scale"]);

    const cited = await search("citations");
    expect(cited.items.map((p) => p.citationCount)).toEqual([900, 300, 40]);
    expect(cited.latestPreprints).toBeUndefined();
    expect((await search()).latestPreprints).toBeUndefined();
  });

  it("still returns results when arXiv is unavailable", async () => {
    const arxiv = new FakeProvider("arxiv", preprints);
    arxiv.failWith = "unavailable";
    await installFakeScholarly(new FakeProvider("semantic_scholar", corpus), arxiv);
    const res = await search("newest");
    expect(res.items).toHaveLength(3);
    expect(res.latestPreprints).toBeUndefined();
  });
});

describe("search robustness", () => {
  it("asks the next source when the first finds nothing, and lists each work once", async () => {
    const { installFakeScholarly, FakeProvider, paper, createUser } = await import("./helpers");
    const { discover, oneVersionEach } = await import("@/server/papers/discovery");
    const ctx = await createUser("Robust searcher");
    await installFakeScholarly(
      new FakeProvider("semantic_scholar", []),
      new FakeProvider("openalex", [paper({ title: "Robust registration of brain scans", ids: { openalex: "W77" } })]),
    );
    const r = await discover(ctx.workspaceId, {
      q: "robust registration",
      mode: "all",
      filters: {},
      offset: 0,
      limit: 20,
      exact: true,
    });
    expect(r.provider).toBe("openalex");
    expect(r.items.map((p) => p.title)).toEqual(["Robust registration of brain scans"]);

    const versions = oneVersionEach([
      { title: "VentrEX: ventricular segmentation", authors: ["A Bedoui"] },
      { title: "VentrEX — Ventricular Segmentation", authors: ["Bedoui A"] },
      { title: "VentrEX: ventricular segmentation", authors: ["Someone Else"] },
    ]);
    expect(versions).toHaveLength(2);
  });
});
