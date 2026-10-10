import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textToDoc } from "@/lib/prosemirror";
import { db } from "@/server/db/client";
import { textEmbeddings } from "@/server/db/schema";
import { setEmbedderForTests, type Embedder } from "@/server/embeddings/embedder";
import { indexFile, indexWorkspace } from "@/server/embeddings/index";
import { semanticSearch } from "@/server/embeddings/search";
import { extractPdfText, uploadPdf } from "@/server/files/service";
import { createNote, updateNote } from "@/server/knowledge/notes";
import { savePaper } from "@/server/library/library";
import { ingestPapers } from "@/server/papers/ingest";
import { toolFor } from "@/server/research/agent";
import { SourceRegistry } from "@/server/research/tools";
import { createUser, makePdfPages, paper } from "./helpers";

/** A stand-in model: words hashed into 64 dimensions, with a few words treated as meaning the same. */
const SAME = new Map([
  ["failure", "collapse"],
  ["collapses", "collapse"],
  ["degenerate", "collapse"],
  ["mode", "collapse"],
]);
function vector(text: string) {
  const v = new Array<number>(64).fill(0);
  for (const raw of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const w = SAME.get(raw) ?? raw.replace(/s$/, "");
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
const fake: Embedder = {
  model: "test-model",
  passages: async (texts) => texts.map(vector),
  query: async (text) => vector(text),
};

describe("meaning-based search", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let withPdf: string, abstractOnly: string;
  let fileId: string;

  beforeAll(async () => {
    setEmbedderForTests(fake);
    ctx = await createUser("Meaning searcher");
    [withPdf, abstractOnly] = await ingestPapers([
      paper({ title: "Learning deformable registration", ids: { s2: "emb-1" } }),
      paper({
        title: "Contrastive pretraining for scans",
        ids: { s2: "emb-2" },
        abstract: "Representations can degenerate during contrastive pretraining without negatives.",
      }),
    ]);
    await savePaper(ctx.workspaceId, ctx.userId, abstractOnly);
    const file = await uploadPdf(
      ctx.workspaceId,
      ctx.userId,
      withPdf,
      new File(
        [makePdfPages([["We describe the network."], ["Training sometimes collapses to the identity transform."]])],
        "reg.pdf",
      ),
    );
    fileId = file.id;
    await extractPdfText(file.id);
    await createNote(ctx, {
      title: "Reading log",
      content: textToDoc("Remember the failure of training on small data."),
    });
  });
  afterAll(() => setEmbedderForTests(undefined));

  it("indexes PDFs, abstracts and notes once, and again only when they change", async () => {
    expect(await indexWorkspace(ctx.workspaceId)).toEqual({ files: 1, abstracts: 1, notes: 1 });
    expect(await indexWorkspace(ctx.workspaceId)).toEqual({ files: 0, abstracts: 0, notes: 0 });
    expect(await indexFile(fileId)).toEqual({ chunks: 0 });

    const [note] = await db
      .select({ noteId: textEmbeddings.noteId })
      .from(textEmbeddings)
      .where(eq(textEmbeddings.sourceKind, "note"));
    await updateNote(ctx, note.noteId!, { title: "Reading log, revised" });
    expect((await indexWorkspace(ctx.workspaceId)).notes).toBe(1);
  });

  it("finds texts that share no words with the query", async () => {
    const hits = (await semanticSearch(ctx.workspaceId, "failure mode", { limit: 3 }))!;
    expect(hits.map((h) => h.kind).sort()).toEqual(["abstract", "note", "pdf"]);
    expect(hits.find((h) => h.kind === "pdf")).toMatchObject({ paperId: withPdf, page: 2 });

    const sources = new SourceRegistry();
    const r = await toolFor({ tool: "find_passages", queries: ["failure mode"] }, sources).run({
      workspaceId: ctx.workspaceId,
      sources,
    });
    expect(r.report).toContain("words and meaning combined");
    expect(r.report).toMatch(/P\d+ p\. 2 .*\(matched by meaning\): “Training sometimes collapses/);
    expect(r.report).toMatch(/abstract .*no PDF here\) \(matched by meaning\)/);
    expect(r.report).toMatch(/User's note N\d+ .*failure of training/);
  });
});
