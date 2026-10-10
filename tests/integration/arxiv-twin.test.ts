import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { jobs, papers } from "@/server/db/schema";
import { savePaper } from "@/server/library/library";
import { findArxivTwin, linkArxivVersion, queueArxivTwinBackfill, sameTitle } from "@/server/papers/arxiv-twin";
import { ingestPapers } from "@/server/papers/ingest";
import { getPaperDetail } from "@/server/papers/service";
import type { NormalizedPaper, ScholarlyProvider } from "@/server/scholarly/types";
import { createUser, installFakeScholarly, paper } from "./helpers";

const onArxiv = [
  paper({
    source: "arxiv",
    title: "Beyond Spatial Benchmarks: From Spatial Reasoning to Navigation",
    ids: { arxiv: "2609.29934" },
    authors: [{ name: "Xun Huang" }, { name: "Shijia Zhao" }],
    abstract: "We move from spatial benchmarks to navigation.",
    openAccessPdfUrl: "https://arxiv.org/pdf/2609.29934",
    venue: "arXiv",
  }),
  paper({
    source: "arxiv",
    title: "A geometry-preserving way to compress tokens",
    ids: { arxiv: "2610.11111" },
    authors: [{ name: "Grace Hopper" }],
    openAccessPdfUrl: "https://arxiv.org/pdf/2610.11111",
    venue: "arXiv",
  }),
];
const arxiv: ScholarlyProvider = {
  name: "arxiv",
  lookupKinds: ["arxiv"],
  supportsSearch: false,
  supportsCitations: false,
  getPaper: async (ref) => onArxiv.find((p) => p.ids.arxiv === ref.value) ?? null,
  searchTitle: async (title) => onArxiv.filter((p) => sameTitle(p.title, title)),
};
const fromOpenReview = (title: string, id: string): NormalizedPaper =>
  paper({
    source: "openreview",
    title,
    ids: { openreview: id },
    authors: [],
    abstract: null,
    venue: "ICLR 2027 Conference Submission",
    year: 2027,
  });

describe("the arXiv version of a paper under review", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  beforeAll(async () => {
    ctx = await createUser("Twin finder");
    await installFakeScholarly(arxiv);
  });

  it("finds it by title and takes its authors, abstract and free PDF", async () => {
    const [id] = await ingestPapers([
      fromOpenReview("Beyond Spatial Benchmarks: From Spatial Reasoning to Navigation", "6lBNTLNwNe"),
    ]);
    expect(await findArxivTwin(id)).toBe("2609.29934");
    const p = await getPaperDetail(ctx.workspaceId, id);
    expect(p).toMatchObject({
      authors: ["Xun Huang", "Shijia Zhao"],
      abstract: "We move from spatial benchmarks to navigation.",
      venue: "ICLR 2027 Conference Submission",
      pdfAvailable: true,
    });
    expect(p.ids).toMatchObject({ arxiv: "2609.29934", openreview: "6lBNTLNwNe" });
  });

  it("records a miss, and links a version the user names even under another title", async () => {
    const [id] = await ingestPapers([
      fromOpenReview("GeoPACT: Geometry-Preserving Token Compression for Spatial Reasoning in VLMs", "8g0NO9Avvm"),
    ]);
    expect(await findArxivTwin(id)).toBeNull();
    const [row] = await db.select().from(papers).where(eq(papers.id, id));
    expect(row.arxivCheckedAt).not.toBeNull();

    expect(await linkArxivVersion(ctx.workspaceId, id, "https://arxiv.org/abs/2610.11111v2")).toBe("2610.11111");
    expect(await getPaperDetail(ctx.workspaceId, id)).toMatchObject({ authors: ["Grace Hopper"], pdfAvailable: true });
    await expect(linkArxivVersion(ctx.workspaceId, id, "not an id")).rejects.toThrow(/not an arXiv id/);
  });

  it("looks again daily for saved papers still without an arXiv version", async () => {
    const [waiting, linked] = await ingestPapers([
      fromOpenReview("A paper whose authors have not posted it on arXiv yet", "Wait1234"),
      fromOpenReview("Beyond Spatial Benchmarks: From Spatial Reasoning to Navigation", "Linked123"),
    ]);
    await findArxivTwin(linked);
    await db
      .update(papers)
      .set({ arxivCheckedAt: new Date(Date.now() - 4 * 24 * 3600_000) })
      .where(eq(papers.id, waiting));
    await savePaper(ctx.workspaceId, ctx.userId, waiting);
    await savePaper(ctx.workspaceId, ctx.userId, linked);
    await db.delete(jobs).where(eq(jobs.type, "find_arxiv_twin"));

    expect(await queueArxivTwinBackfill()).toBeGreaterThanOrEqual(1);
    const queued = await db
      .select({ key: jobs.dedupeKey })
      .from(jobs)
      .where(and(eq(jobs.type, "find_arxiv_twin")));
    expect(queued.map((j) => j.key)).toContain(`find_arxiv_twin:${waiting}`);
    expect(queued.map((j) => j.key)).not.toContain(`find_arxiv_twin:${linked}`);
  });
});

describe("title matching", () => {
  it("tolerates punctuation and small wording differences, but not short or different titles", () => {
    expect(
      sameTitle(
        "Beyond Spatial Benchmarks: From Spatial Reasoning to Navigation",
        "beyond spatial benchmarks — from spatial reasoning to navigation",
      ),
    ).toBe(true);
    expect(
      sameTitle(
        "A study of spatial reasoning in large vision models today",
        "A study of spatial reasoning in large vision models",
      ),
    ).toBe(true);
    expect(sameTitle("Spatial reasoning", "Spatial reasoning in VLMs")).toBe(false);
    expect(sameTitle("Spatial reasoning for robots in homes", "Temporal reasoning for robots in homes")).toBe(false);
  });
});
