import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { publicationTrendTool } from "@/server/research/tools";
import { growth, publicationTrend } from "@/server/search/trend";
import { FakeProvider, installFakeScholarly } from "./helpers";

const NOW = new Date("2026-06-01T12:00:00Z");

/** OpenAlex grouped counts: all works grow 5% a year; "spatial reasoning" doubles every year from 2019. */
function stubOpenAlex() {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      const filter = url.searchParams.get("filter") ?? "";
      const topic = /title_and_abstract\.search:([^,]*)/.exec(filter)?.[1];
      const group_by = Array.from({ length: 11 }, (_, i) => 2016 + i).map((year) => ({
        key: String(year),
        count:
          topic === "spatial reasoning"
            ? year < 2019
              ? 0
              : 10 * 2 ** (year - 2019)
            : topic
              ? 0
              : Math.round(1_000_000 * 1.05 ** (year - 2016)),
      }));
      return new Response(JSON.stringify({ meta: { count: 1 }, group_by }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return urls;
}

describe("publication trends", () => {
  beforeAll(async () => {
    await installFakeScholarly(new FakeProvider("semantic_scholar", []));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("compares the last three full years with the three before", () => {
    const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
    expect(growth([10, 10, 10, 20, 20, 20, 99], years, 2025)).toBe(1);
    expect(growth([1, 1, 1, 2, 2, 2], years.slice(0, 6), null)).toBeNull(); // too few papers
    expect(growth([10, 10, 10, 20, 20], years.slice(0, 5), null)).toBeNull(); // too few years
  });

  it("counts papers per year from OpenAlex, against all papers, without AI", async () => {
    const urls = stubOpenAlex();
    const t = await publicationTrend(["spatial reasoning", "nothing here"], { now: NOW });
    expect(t.years).toEqual([2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    expect(t.partialYear).toBe(2026);
    const [spatial, nothing] = t.series;
    expect(spatial.counts.slice(3, 6)).toEqual([10, 20, 40]);
    // 2023–2025 (160+320+640) against 2020–2022 (20+40+80); the unfinished 2026 is left out.
    expect(spatial.growth).toBeCloseTo(1120 / 140 - 1);
    expect(spatial.shareGrowth!).toBeLessThan(spatial.growth!); // all papers grew too
    expect(nothing.growth).toBeNull();
    expect(
      urls.every((u) => u.hostname === "api.openalex.org" && u.searchParams.get("group_by") === "publication_year"),
    ).toBe(true);
    expect(urls.some((u) => u.searchParams.get("filter") === "publication_year:2016-2026")).toBe(true);
  });

  it("gives the assistant a table with growth figures", async () => {
    stubOpenAlex();
    const { report } = await publicationTrendTool({ queries: ["spatial reasoning"], yearFrom: 2019 }, NOW);
    expect(report).toContain("| Year | All papers | “spatial reasoning” |");
    expect(report).toContain("| 2020 | 1.2M | 20 |");
    expect(report).toContain("| 2026 (so far) |");
    expect(report).toContain("2026 is not complete yet");
    expect(report).toMatch(
      /“spatial reasoning”: \+700% in the last three full years against the three before \(\+\d+% as a share/,
    );
  });
});
