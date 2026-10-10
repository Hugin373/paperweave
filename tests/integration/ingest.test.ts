import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { paperIdentifiers, papers } from "@/server/db/schema";
import { ingestPapers } from "@/server/papers/ingest";
import { paper } from "./helpers";

async function identifiers(paperId: string) {
  const rows = await db.select().from(paperIdentifiers).where(eq(paperIdentifiers.paperId, paperId));
  return Object.fromEntries(rows.map((r) => [r.kind, r.value]));
}

describe("paper identity and de-duplication", () => {
  it("merges records that share a DOI and accumulates identifiers", async () => {
    const [a] = await ingestPapers([
      paper({ title: "Shared DOI paper", ids: { s2: "s2-doi-1", doi: "10.1000/dedup.1" }, abstract: null }),
    ]);
    const [b] = await ingestPapers([
      paper({
        source: "openalex",
        title: "Shared DOI Paper",
        ids: { openalex: "W900001", doi: "10.1000/dedup.1" },
        abstract: "Filled in",
        citationCount: 99,
      }),
    ]);
    expect(b).toBe(a);
    expect(await identifiers(a)).toEqual({ s2: "s2-doi-1", doi: "10.1000/dedup.1", openalex: "W900001" });
    const [row] = await db.select().from(papers).where(eq(papers.id, a));
    expect(row.abstract).toBe("Filled in");
    expect(row.citationCount).toBe(99);
  });

  it("merges by arXiv id", async () => {
    const [a] = await ingestPapers([paper({ title: "An arXiv preprint", ids: { arxiv: "2401.00001" } })]);
    const [b] = await ingestPapers([
      paper({ title: "An arXiv preprint (v2)", ids: { arxiv: "2401.00001", s2: "s2-arx" } }),
    ]);
    expect(b).toBe(a);
  });

  it("falls back to title + first author + year when no identifier matches", async () => {
    const base = { title: "Learning to see in three dimensions", authors: [{ name: "Grace Hopper" }], year: 2021 };
    const [a] = await ingestPapers([paper({ ...base, ids: { s2: "s2-title-a" } })]);
    const [b] = await ingestPapers([paper({ ...base, source: "openalex", ids: { openalex: "W900002" }, year: 2022 })]);
    expect(b).toBe(a);
  });

  it("does not merge on title alone", async () => {
    const [a] = await ingestPapers([
      paper({ title: "Introduction to the special issue", authors: [{ name: "A Smith" }], ids: { s2: "s2-intro-1" } }),
    ]);
    const [b] = await ingestPapers([
      paper({ title: "Introduction to the special issue", authors: [{ name: "B Jones" }], ids: { s2: "s2-intro-2" } }),
    ]);
    expect(b).not.toBe(a);
  });

  it("does not merge same-title records with conflicting DOIs", async () => {
    const base = {
      title: "A very specific identical title for testing",
      authors: [{ name: "Alan Turing" }],
      year: 2020,
    };
    const [a] = await ingestPapers([paper({ ...base, ids: { doi: "10.1000/conflict.a" } })]);
    const [b] = await ingestPapers([paper({ ...base, ids: { doi: "10.1000/conflict.b" } })]);
    expect(b).not.toBe(a);
  });

  it("is safe under concurrent ingestion of the same new paper", async () => {
    const rec = paper({ title: "Concurrent paper", ids: { doi: "10.1000/concurrent" } });
    const results = await Promise.all(Array.from({ length: 6 }, () => ingestPapers([rec])));
    expect(new Set(results.map((r) => r[0])).size).toBe(1);
    const rows = await db
      .select()
      .from(papers)
      .where(inArray(papers.title, ["Concurrent paper"]));
    expect(rows).toHaveLength(1);
  });

  it("de-duplicates within one batch", async () => {
    const ids = await ingestPapers([
      paper({ title: "Batch twin", ids: { s2: "s2-batch" } }),
      paper({ source: "openalex", title: "Batch twin", ids: { openalex: "W900003", s2: "s2-batch" } }),
    ]);
    expect(ids[0]).toBe(ids[1]);
  });

  it("does not merge on title when the new record has no author or year to confirm it", async () => {
    const title = "Introduction to statistical learning";
    const [a] = await ingestPapers([
      paper({ title, ids: { s2: "s2-bare-a" }, authors: [{ name: "Alice Alpha" }], year: 2020 }),
    ]);
    const [b] = await ingestPapers([paper({ title, ids: { s2: "s2-bare-b" }, authors: [], year: null })]);
    expect(b).not.toBe(a);
  });
});
