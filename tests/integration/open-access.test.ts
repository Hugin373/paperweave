import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { jobs, papers } from "@/server/db/schema";
import { savePaper } from "@/server/library/library";
import { ingestPapers } from "@/server/papers/ingest";
import { checkOpenAccess, queueOpenAccessBackfill } from "@/server/papers/open-access";
import { getPaperDetail } from "@/server/papers/service";
import { createUser, FakeProvider, installFakeScholarlyWith, paper } from "./helpers";

/**
 * Answers Unpaywall lookups: a PDF for 10.1000/free, none for 10.1000/closed, a free-to-read PubMed
 * Central page for 10.1000/green, and an outage for anything else.
 */
function stubUnpaywall() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("10.1000%2Ffree")) {
        return Response.json({ is_oa: true, best_oa_location: { url_for_pdf: "https://journal.example/free.pdf" } });
      }
      if (url.includes("10.1000%2Fclosed")) return Response.json({ is_oa: false, oa_locations: [] });
      if (url.includes("10.1000%2Fgreen")) {
        return Response.json({
          is_oa: true,
          best_oa_location: { url_for_pdf: null, url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC777/" },
        });
      }
      return new Response("unavailable", { status: 503 });
    }),
  );
}

const queued = (paperId: string) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, `find_open_access:${paperId}`), eq(jobs.status, "queued")));

describe("free-PDF availability", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let free: string, closed: string, down: string, arxiv: string, green: string;

  beforeAll(async () => {
    await installFakeScholarlyWith({ contactEmail: "me@example.org" }, new FakeProvider("semantic_scholar", []));
    ctx = await createUser("PdfFinder");
    [free, closed, down, arxiv, green] = await ingestPapers([
      paper({ title: "Free journal paper", ids: { s2: "oa-free", doi: "10.1000/free" } }),
      paper({ title: "Closed journal paper", ids: { s2: "oa-closed", doi: "10.1000/closed" } }),
      paper({ title: "Paper during an outage", ids: { s2: "oa-down", doi: "10.1000/down" } }),
      paper({ title: "Preprint", ids: { s2: "oa-arxiv", arxiv: "2401.00001" } }),
      paper({ title: "Author manuscript", ids: { s2: "oa-green", doi: "10.1000/green" } }),
    ]);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("offers Get PDF only when a free copy is known", async () => {
    expect((await getPaperDetail(ctx.workspaceId, arxiv)).pdfAvailable).toBe(true);
    // A DOI alone is not enough: nobody has confirmed a free copy yet.
    expect((await getPaperDetail(ctx.workspaceId, free)).pdfAvailable).toBe(false);
  });

  it("queues a check when a journal paper is saved, and records what Unpaywall finds", async () => {
    await savePaper(ctx.workspaceId, ctx.userId, free);
    await savePaper(ctx.workspaceId, ctx.userId, arxiv);
    expect(await queued(free)).toHaveLength(1);
    stubUnpaywall();
    expect(await checkOpenAccess(free)).toBe("https://journal.example/free.pdf");
    expect((await getPaperDetail(ctx.workspaceId, free)).pdfAvailable).toBe(true);

    expect(await checkOpenAccess(closed)).toBeNull();
    const [row] = await db.select().from(papers).where(eq(papers.id, closed));
    expect(row.oaCheckedAt).not.toBeNull();
    expect(row.openAccessPdfUrl).toBeNull();
  });

  it("links papers that are free to read without a PDF, and records their PubMed Central id", async () => {
    stubUnpaywall();
    expect(await checkOpenAccess(green)).toBeNull();
    const detail = await getPaperDetail(ctx.workspaceId, green);
    expect(detail.pdfAvailable).toBe(false);
    expect(detail.freeReadUrl).toBe("https://pmc.ncbi.nlm.nih.gov/articles/PMC777/");
    expect(detail.ids.pmcid).toBe("PMC777");
  });

  it("retries after an outage instead of recording 'no PDF'", async () => {
    stubUnpaywall();
    await expect(checkOpenAccess(down)).rejects.toThrow(/503/);
    const [row] = await db.select().from(papers).where(eq(papers.id, down));
    expect(row.oaCheckedAt).toBeNull();
  });

  it("backfills saved papers that were never checked", async () => {
    await savePaper(ctx.workspaceId, ctx.userId, closed);
    await savePaper(ctx.workspaceId, ctx.userId, down);
    await db.delete(jobs).where(eq(jobs.type, "find_open_access"));
    await queueOpenAccessBackfill();
    // Only the paper whose check failed: the others have a PDF, a recent check, or an arXiv copy.
    expect(await queued(down)).toHaveLength(1);
    expect(await queued(closed)).toHaveLength(0);
    expect(await queued(free)).toHaveLength(0);
    expect(await queued(arxiv)).toHaveLength(0);
  });
});
