import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { PMNode } from "@/lib/prosemirror";
import { db } from "@/server/db/client";
import { jobs } from "@/server/db/schema";
import { exportBibtex, exportJson, exportMarkdownZip } from "@/server/export/export";
import { runImport, startBibtexImport, startIdentifierImport } from "@/server/import/import";
import { claimJob, enqueueJob, failJob, getWorkspaceJob } from "@/server/jobs/queue";
import { ScholarlyUnavailableError } from "@/server/scholarly/service";
import { runOneJob } from "@/server/jobs/worker";
import { createConcept, linkPaper } from "@/server/knowledge/concepts";
import { createNote } from "@/server/knowledge/notes";
import { listLibrary, savePaper } from "@/server/library/library";
import { addToCollection, createCollection, tagPapers } from "@/server/library/organize";
import { createUser, FakeProvider, installFakeScholarly, paper } from "./helpers";
import { eq } from "drizzle-orm";

const corpus = [
  paper({
    title: "Exported paper on depth",
    ids: { s2: "ex-1", doi: "10.1000/export.1" },
    authors: [{ name: "Marie Curie" }],
    year: 2019,
  }),
  paper({ title: "Imported by title", ids: { s2: "ex-2" }, authors: [{ name: "Emmy Noether" }], year: 2018 }),
];

describe("export", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let paperId: string;
  beforeAll(async () => {
    await installFakeScholarly(new FakeProvider("semantic_scholar", corpus));
    ctx = await createUser("Exporter");
    const { ingestPapers } = await import("@/server/papers/ingest");
    [paperId] = await ingestPapers([corpus[0]]);
    await savePaper(ctx.workspaceId, ctx.userId, paperId);
    await tagPapers(ctx.workspaceId, ctx.userId, [paperId], { names: ["important"] });
    const coll = await createCollection(ctx.workspaceId, { name: "Thesis" });
    await addToCollection(ctx.workspaceId, ctx.userId, coll.id, [paperId]);
    const concept = await createConcept(ctx, { name: "Metric depth", description: "Depth in meters." });
    await linkPaper(ctx, concept.id, paperId);
    const content: PMNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "About " },
            { type: "mention", attrs: { id: `concept:${concept.id}`, label: "Metric depth" } },
          ],
        },
      ],
    };
    await createNote(ctx, { title: "My note", paperId, content });
  });

  it("exports complete JSON with identifiers and relationships", async () => {
    const data = await exportJson(ctx.workspaceId);
    expect(data.format).toBe("paperweave-export");
    expect(data.papers[0]).toMatchObject({
      title: "Exported paper on depth",
      identifiers: { doi: "10.1000/export.1", s2: "ex-1" },
      tags: ["important"],
    });
    expect(data.collections[0]).toMatchObject({ name: "Thesis", paperIds: [paperId] });
    expect(data.concepts[0]).toMatchObject({ name: "Metric depth", paperIds: [paperId] });
    expect(data.notes[0].markdown).toContain("About [[Metric depth]]");
    expect(data.notes[0].links).toEqual([{ type: "concept", id: data.concepts[0].id }]);
  });

  it("exports a Markdown vault with resolvable wiki-links", async () => {
    const files = unzipSync(await exportMarkdownZip(ctx.workspaceId));
    const names = Object.keys(files).sort();
    expect(names).toEqual([
      "README.md",
      "concepts/Metric depth.md",
      "library.bib",
      "notes/My note.md",
      "papers/Exported paper on depth.md",
    ]);
    const note = strFromU8(files["notes/My note.md"]);
    expect(note).toContain("About: [[Exported paper on depth]]");
    expect(note).toContain("About [[Metric depth]]");
    expect(strFromU8(files["papers/Exported paper on depth.md"])).toContain('doi: "10.1000/export.1"');
  });

  it("exports BibTeX", async () => {
    const bib = await exportBibtex(ctx.workspaceId);
    expect(bib).toContain("@article{curie2019exported,");
    expect(bib).toContain("doi = {10.1000/export.1}");
  });
});

describe("import", () => {
  it("imports BibTeX: matches known papers and keeps unknown ones as manual entries", async () => {
    await installFakeScholarly(new FakeProvider("semantic_scholar", corpus));
    const ctx = await createUser("Importer");
    const { jobId } = await startBibtexImport(
      ctx,
      `@article{a, title={Imported by title}, author={Noether, Emmy}, year={2018}}
       @article{b, title={A paper no source knows}, author={Doe, Jane}, year={2001}, doi={10.9999/unknown}}`,
      null,
    );
    const job = (await getWorkspaceJob(ctx.workspaceId, jobId!))!;
    const result = await runImport(job.id, job.payload as never);
    expect(result).toMatchObject({ total: 2, matched: 1, created: 1, failed: [] });
    const lib = await listLibrary(ctx.workspaceId, { status: "all", sort: "title_asc", offset: 0, limit: 10 });
    expect(lib.items.map((i) => [i.title, i.isUserPaper])).toEqual([
      ["A paper no source knows", true],
      ["Imported by title", false],
    ]);
    // Manually entered papers stay private to their workspace.
    const other = await createUser("Other");
    const { getPaperSummaries } = await import("@/server/papers/service");
    expect(await getPaperSummaries(other.workspaceId, [lib.items[0].id])).toEqual([]);
  });

  it("validates identifier lists", async () => {
    const ctx = await createUser("Lister");
    await expect(startIdentifierImport(ctx, "not an id\nanother", null)).rejects.toThrow(/No DOIs/);
    const { total } = await startIdentifierImport(ctx, "10.1000/export.1\n10.1000/export.1, arXiv:1706.03762", null);
    expect(total).toBe(2);
  });
});

describe("background jobs", () => {
  it("de-duplicates pending jobs, retries with backoff, and records failures", async () => {
    await db.delete(jobs);
    const first = await enqueueJob({ type: "unknown_job", dedupeKey: "dedupe-test", maxAttempts: 2 });
    const dup = await enqueueJob({ type: "unknown_job", dedupeKey: "dedupe-test" });
    expect(first).not.toBeNull();
    expect(dup).toBeNull();

    expect(await runOneJob()).toBe(true);
    let [row] = await db.select().from(jobs).where(eq(jobs.id, first!));
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row.lastError).toMatch(/Unknown job type/);
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());

    await db
      .update(jobs)
      .set({ runAt: new Date(0) })
      .where(eq(jobs.id, first!));
    const claimed = (await claimJob())!;
    await failJob(claimed, new Error("still failing"));
    [row] = await db.select().from(jobs).where(eq(jobs.id, first!));
    expect(row).toMatchObject({ status: "failed", attempts: 2, lastError: "still failing" });
    expect(await runOneJob()).toBe(false);
  });
  it("waits out a scholarly source's rate limit instead of giving up", async () => {
    await db.delete(jobs);
    const id = await enqueueJob({ type: "unknown_job", maxAttempts: 1 });
    const claimed = (await claimJob())!;
    const limited = new ScholarlyUnavailableError([
      { provider: "semantic_scholar", kind: "rate_limited", message: "cooling down", quota: false },
    ]);
    await failJob(claimed, limited);
    let [row] = await db.select().from(jobs).where(eq(jobs.id, id!));
    expect(row.status).toBe("queued"); // past maxAttempts, but rate limits get extra tries
    expect(row.runAt.getTime() - Date.now()).toBeGreaterThan(100_000); // minutes, not seconds

    // A used-up daily quota is not waited out.
    await db
      .update(jobs)
      .set({ runAt: new Date(0) })
      .where(eq(jobs.id, id!));
    const again = (await claimJob())!;
    await failJob(
      again,
      new ScholarlyUnavailableError([{ provider: "openalex", kind: "rate_limited", message: "quota", quota: true }]),
    );
    [row] = await db.select().from(jobs).where(eq(jobs.id, id!));
    expect(row.status).toBe("failed");
  });
});
