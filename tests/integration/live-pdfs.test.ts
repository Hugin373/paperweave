import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { paperFilePages, paperFiles } from "@/server/db/schema";
import { createHighlight, listHighlights } from "@/server/files/highlights";
import { toFileInfo } from "@/server/files/info";
import {
  attachPdfFromUrl,
  checkForNewVersion,
  extractPdfText,
  getWorkspaceFile,
  setFileLive,
  streamFile,
} from "@/server/files/service";
import { storage } from "@/server/files/storage";
import { ingestPapers } from "@/server/papers/ingest";
import type { ScholarlyProvider } from "@/server/scholarly/types";
import { createUser, installFakeScholarly, makePdf, makePdfPages, paper } from "./helpers";

// Host names resolve to a public address without the network.
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.215.14", family: 4 }] }));

/** Serves PDFs by URL through a stubbed fetch, counting requests. */
function serve(pdfs: Record<string, Uint8Array>) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      requests.push(url);
      const body = pdfs[url];
      return body
        ? new Response(body.slice(), { status: 200, headers: { "content-length": String(body.byteLength) } })
        : new Response("not found", { status: 404 });
    }),
  );
  return requests;
}

/** An arXiv source whose newest version can be changed by the test. */
function fakeArxiv(): ScholarlyProvider & { version: number } {
  return {
    name: "arxiv",
    lookupKinds: ["arxiv"],
    supportsSearch: false,
    supportsCitations: false,
    getPaper: async () => null,
    version: 2,
    async latestVersion() {
      return this.version;
    },
  };
}

const V2 = makePdfPages([
  ["Introduction to the method", "Sparse attention halves memory use", "A sentence that will be removed later"],
]);
const V3 = makePdfPages([
  ["Introduction to the method", "New paragraph added in version three", "More new text to push content"],
  ["Sparse attention halves memory use", "Closing remarks"],
]);

describe("live PDFs", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let arxiv: ReturnType<typeof fakeArxiv>;
  afterEach(() => vi.unstubAllGlobals());
  beforeAll(async () => {
    ctx = await createUser("Live reader");
  });

  async function arxivPaper(id: string) {
    arxiv = fakeArxiv();
    await installFakeScholarly(arxiv);
    const [paperId] = await ingestPapers([paper({ title: `Preprint ${id} on sparse attention`, ids: { arxiv: id } })]);
    return paperId;
  }

  it("reads a free arXiv PDF live at its newest version, without storing it", async () => {
    const paperId = await arxivPaper("2401.00001");
    serve({ "https://arxiv.org/pdf/2401.00001v2": V2 });
    const file = await attachPdfFromUrl(ctx.workspaceId, ctx.userId, paperId);
    expect(file).toMatchObject({ storageKey: null, version: "v2", sourceUrl: "https://arxiv.org/pdf/2401.00001v2" });
    // The browser loads it from arXiv directly.
    expect(toFileInfo(file)).toMatchObject({ live: true, viewUrl: "https://arxiv.org/pdf/2401.00001v2" });
    // Text extraction reuses the bytes just downloaded.
    vi.stubGlobal("fetch", vi.fn());
    await extractPdfText(file.id);
    const pages = await db.select().from(paperFilePages).where(eq(paperFilePages.fileId, file.id));
    expect(pages[0].text).toContain("Sparse attention halves memory use");
    // Reading it again opens the same PDF.
    expect((await attachPdfFromUrl(ctx.workspaceId, ctx.userId, paperId)).id).toBe(file.id);
  });

  it("moves to a new version and takes the highlights along", async () => {
    const paperId = await arxivPaper("2401.00002");
    serve({ "https://arxiv.org/pdf/2401.00002v2": V2 });
    const file = await attachPdfFromUrl(ctx.workspaceId, ctx.userId, paperId);
    const rect = [{ x: 0.1, y: 0.13, width: 0.5, height: 0.03 }];
    const kept = await createHighlight(ctx.workspaceId, ctx.userId, file.id, {
      kind: "highlight",
      pageNumber: 1,
      rects: rect,
      selectedText: "Sparse attention halves memory use",
      prefix: "Introduction to the method",
      suffix: "A sentence",
      color: "yellow",
      comment: "key result",
    });
    const gone = await createHighlight(ctx.workspaceId, ctx.userId, file.id, {
      kind: "highlight",
      pageNumber: 1,
      rects: rect,
      selectedText: "A sentence that will be removed later",
      prefix: "memory use",
      suffix: "",
      color: "green",
      comment: "",
    });

    // Not due yet: a recent check is trusted, nothing is fetched.
    const quiet = serve({});
    expect((await checkForNewVersion(ctx.workspaceId, file.id)).updated).toBe(false);
    expect(quiet).toEqual([]);

    arxiv.version = 3;
    serve({ "https://arxiv.org/pdf/2401.00002v3": V3 });
    const { file: updated, updated: changed } = await checkForNewVersion(ctx.workspaceId, file.id, { force: true });
    expect(changed).toBe(true);
    expect(updated).toMatchObject({ id: file.id, version: "v3", pageCount: 2, storageKey: null });
    expect(updated.versionNotice).toMatchObject({ from: "v2", to: "v3", moved: 1, lost: 1 });

    const hl = await listHighlights(ctx.workspaceId, file.id);
    const moved = hl.find((h) => h.id === kept.id)!;
    expect(moved).toMatchObject({ pageNumber: 2, lost: false, comment: "key result" });
    // At the top of page 2, where the text now is (72pt from the left of a 612pt-wide page).
    expect(moved.rects[0].x).toBeCloseTo(72 / 612, 2);
    expect(moved.rects[0].y).toBeLessThan(0.1);
    expect(hl.find((h) => h.id === gone.id)).toMatchObject({ lost: true, pageNumber: 1 });

    const pages = await db.select().from(paperFilePages).where(eq(paperFilePages.fileId, file.id));
    expect(pages.map((p) => p.pageNumber).sort()).toEqual([1, 2]);
  });

  it("detects a changed PDF at a link without versions by its contents, and streams it through", async () => {
    await installFakeScholarly();
    const url = "https://repository.example/paper.pdf";
    const [paperId] = await ingestPapers([
      paper({ title: "A repository preprint about voxels", ids: { s2: "live-repo-1" }, openAccessPdfUrl: url }),
    ]);
    serve({ [url]: makePdf("First draft of the voxel paper") });
    const file = await attachPdfFromUrl(ctx.workspaceId, ctx.userId, paperId);
    expect(toFileInfo(file)).toMatchObject({
      live: true,
      version: null,
      viewUrl: expect.stringMatching(`^/api/files/${file.id}\\?v=`),
    });

    const res = await streamFile(file, null);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("First draft of the voxel paper");
    const download = await streamFile(file, null, true);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="paper\.pdf"/);
    await download.body?.cancel();

    serve({ [url]: makePdf("Revised version of the voxel paper") });
    const { updated } = await checkForNewVersion(ctx.workspaceId, file.id, { force: true });
    expect(updated).toBe(true);
    serve({ [url]: makePdf("Revised version of the voxel paper") });
    expect((await checkForNewVersion(ctx.workspaceId, file.id, { force: true })).updated).toBe(false);
  });

  it("keeps a copy on request, and goes back to live reading", async () => {
    const paperId = await arxivPaper("2401.00003");
    serve({ "https://arxiv.org/pdf/2401.00003v2": V2 });
    const file = await attachPdfFromUrl(ctx.workspaceId, ctx.userId, paperId);

    const kept = (await setFileLive(ctx.workspaceId, file.id, false)).file;
    expect(kept.storageKey).toBeTruthy();
    expect(toFileInfo(kept)).toMatchObject({
      live: false,
      viewUrl: expect.stringMatching(`^/api/files/${file.id}\\?v=`),
    });
    expect(await storage().getBytes(kept.storageKey!)).toHaveLength(V2.byteLength);

    const live = (await setFileLive(ctx.workspaceId, file.id, true)).file;
    expect(live.storageKey).toBeNull();
    await expect(storage().getBytes(kept.storageKey!)).rejects.toThrow();
    expect((await getWorkspaceFile(ctx.workspaceId, file.id)).storageKey).toBeNull();
  });

  it("never checks uploads for versions", async () => {
    const [paperId] = await ingestPapers([paper({ title: "An uploaded paper for checking", ids: { s2: "live-up" } })]);
    const { uploadPdf } = await import("@/server/files/service");
    const file = await uploadPdf(ctx.workspaceId, ctx.userId, paperId, new File([makePdf("Upload")], "u.pdf"));
    const requests = serve({});
    expect((await checkForNewVersion(ctx.workspaceId, file.id, { force: true })).updated).toBe(false);
    expect(requests).toEqual([]);
    await expect(setFileLive(ctx.workspaceId, file.id, true)).rejects.toThrow(/uploads are always stored/);
    const [row] = await db.select().from(paperFiles).where(eq(paperFiles.id, file.id));
    expect(row.storageKey).toBeTruthy();
  });
});
