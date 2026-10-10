import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { PMNode } from "@/lib/prosemirror";
import type { ProposedChange } from "@/lib/types";
import { db } from "@/server/db/client";
import { concepts, noteLinks, papers } from "@/server/db/schema";
import { createConcept, getConceptDetail, linkPaper, relateConcepts } from "@/server/knowledge/concepts";
import { createNote, getNoteDetail, updateNote } from "@/server/knowledge/notes";
import { savePaper, setStatus } from "@/server/library/library";
import { addToCollection, createCollection } from "@/server/library/organize";
import { ingestPapers } from "@/server/papers/ingest";
import { toolFor } from "@/server/research/agent";
import { applyChanges, changeActionSchema, proposeChange, undoChanges } from "@/server/research/changes";
import { SourceRegistry } from "@/server/research/tools";
import type { AIProvider } from "@/server/ai/types";
import { listHighlights } from "@/server/files/highlights";
import { extractPdfText, uploadPdf } from "@/server/files/service";
import { createUser, makePdfPages, paper } from "./helpers";

type Ctx = Awaited<ReturnType<typeof createUser>>;

async function propose(ctx: Ctx, sources: SourceRegistry, action: unknown): Promise<ProposedChange> {
  const { change, message } = await proposeChange(ctx.workspaceId, changeActionSchema.parse(action), sources, []);
  expect(change, message).toBeTruthy();
  return change!;
}

const mention = (type: string, id: string, label: string): PMNode => ({
  type: "mention",
  attrs: { id: `${type}:${id}`, label },
});

describe("concept merge and rename", () => {
  let ctx: Ctx;
  let a: string, b: string, c: string;
  const sources = new SourceRegistry();

  beforeAll(async () => {
    ctx = await createUser("Concept merger");
    [a, b, c] = await ingestPapers([
      paper({ title: "Point cloud completion network", ids: { s2: "merge-1" } }),
      paper({ title: "Point set upsampling", ids: { s2: "merge-2" } }),
      paper({ title: "Sparse voxel convolutions", ids: { s2: "merge-3" } }),
    ]);
    for (const id of [a, b, c]) await savePaper(ctx.workspaceId, ctx.userId, id);
  });

  it("merges duplicates into one concept and undoes it exactly", async () => {
    const keep = await createConcept(ctx, { name: "Point cloud" });
    const dup = await createConcept(ctx, { name: "Point sets", description: "Unordered 3D points" });
    const broader = await createConcept(ctx, { name: "3D vision" });
    await linkPaper(ctx, keep.id, a);
    await linkPaper(ctx, dup.id, a);
    await linkPaper(ctx, dup.id, b);
    await relateConcepts(ctx, dup.id, broader.id, true);
    const note = await createNote(ctx, {
      title: "Point notes",
      content: { type: "doc", content: [{ type: "paragraph", content: [mention("concept", dup.id, "Point sets")] }] },
    });

    const change = await propose(ctx, sources, { tool: "merge_concepts", into: "point cloud", from: ["Point sets"] });
    expect(change.label).toBe("Merge your 1 concept “Point sets” into “Point cloud”");
    const [applied] = await applyChanges(ctx, [change]);
    expect(applied.status, applied.error).toBe("applied");

    const merged = await getConceptDetail(ctx, keep.id);
    expect(merged.papers.map((p) => p.id).sort()).toEqual([a, b].sort());
    expect(merged.aliases).toContain("Point sets");
    expect(merged.related.map((r) => r.id)).toContain(broader.id);
    expect(await db.select().from(concepts).where(eq(concepts.id, dup.id))).toEqual([]);
    const links = await db.select().from(noteLinks).where(eq(noteLinks.noteId, note.id));
    expect(links.map((l) => l.targetConceptId)).toEqual([keep.id]);

    const [undone] = await undoChanges(ctx, [applied]);
    expect(undone.status, undone.error).toBe("undone");
    const back = await getConceptDetail(ctx, dup.id);
    expect(back).toMatchObject({ name: "Point sets", description: "Unordered 3D points" });
    expect(back.papers.map((p) => p.id).sort()).toEqual([a, b].sort());
    expect(back.related.map((r) => r.id)).toContain(broader.id);
    const kept = await getConceptDetail(ctx, keep.id);
    expect(kept.papers.map((p) => p.id)).toEqual([a]);
    expect(kept.aliases).not.toContain("Point sets");
    expect(kept.related).toEqual([]);
    const noteBack = await db.select().from(noteLinks).where(eq(noteLinks.noteId, note.id));
    expect(noteBack.map((l) => l.targetConceptId)).toEqual([dup.id]);
  });

  it("renames a concept keeping the old name as an alias, and refuses a name in use", async () => {
    const vox = await createConcept(ctx, { name: "Voxels" });
    await linkPaper(ctx, vox.id, c);
    await createConcept(ctx, { name: "Meshes" });
    const { change } = await proposeChange(
      ctx.workspaceId,
      changeActionSchema.parse({ tool: "rename_concept", concept: "Voxels", name: "Meshes" }),
      sources,
      [],
    );
    expect(change).toBeUndefined();

    const rename = await propose(ctx, sources, { tool: "rename_concept", concept: "voxels", name: "Voxel grids" });
    const [applied] = await applyChanges(ctx, [rename]);
    expect(await getConceptDetail(ctx, vox.id)).toMatchObject({ name: "Voxel grids", aliases: ["Voxels"] });
    await undoChanges(ctx, [applied]);
    expect(await getConceptDetail(ctx, vox.id)).toMatchObject({ name: "Voxels", aliases: [] });
  });
});

describe("editing a note by blocks", () => {
  let ctx: Ctx;
  let p: string;
  const sources = new SourceRegistry();
  const callout: PMNode = {
    type: "callout",
    attrs: { kind: "info" },
    content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this callout exactly." }] }],
  };

  beforeAll(async () => {
    ctx = await createUser("Note editor");
    [p] = await ingestPapers([paper({ title: "A paper the note links to", ids: { s2: "edit-1" } })]);
    await savePaper(ctx.workspaceId, ctx.userId, p);
  });

  async function noteWithBlocks() {
    const note = await createNote(ctx, {
      title: "Draft",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "First thought, rough." }] },
          callout,
          {
            type: "paragraph",
            content: [{ type: "text", text: "See " }, mention("paper", p, "Linked paper"), { type: "text", text: "." }],
          },
          { type: "paragraph", content: [{ type: "text", text: "Delete me." }] },
        ],
      },
    });
    return { note, key: sources.add({ type: "note", id: note.id, title: note.title }).key };
  }

  it("shows notes as numbered blocks and changes only the edited ones", async () => {
    const { note, key } = await noteWithBlocks();
    const read = await toolFor({ tool: "read_note", note: key }, sources).run({
      workspaceId: ctx.workspaceId,
      sources,
    });
    expect(read.report).toContain("[B1] First thought, rough.");
    expect(read.report).toContain("[B3] See [[Linked paper]].");

    const change = await propose(ctx, sources, {
      tool: "edit_note",
      note: key,
      edits: [
        { op: "replace", block: 1, content: "First thought, **polished**." },
        { op: "replace", block: 3, content: "See [[Linked paper]] for the details." },
        { op: "delete", block: 4 },
        { op: "insert", block: 0, content: "## Summary" },
      ],
    });
    expect(change.edits).toEqual([
      { op: "replace", block: 1, before: "First thought, rough.", after: "First thought, **polished**." },
      { op: "replace", block: 3, before: "See [[Linked paper]].", after: "See [[Linked paper]] for the details." },
      { op: "delete", block: 4, before: "Delete me." },
      { op: "insert", block: 0, after: "## Summary" },
    ]);

    const [applied] = await applyChanges(ctx, [change]);
    expect(applied.status, applied.error).toBe("applied");
    const doc = (await getNoteDetail(ctx, note.id)).content as PMNode;
    expect(doc.content?.map((b) => b.type)).toEqual(["heading", "paragraph", "callout", "paragraph"]);
    expect(doc.content?.[2]).toEqual(callout);
    // The link survived the rewrite of its block.
    const links = await db.select().from(noteLinks).where(eq(noteLinks.noteId, note.id));
    expect(links.map((l) => l.targetPaperId)).toEqual([p]);

    const [undone] = await undoChanges(ctx, [applied]);
    expect(undone.status).toBe("undone");
    expect(((await getNoteDetail(ctx, note.id)).content as PMNode).content).toHaveLength(4);
  });

  it("refuses to apply an edit to a note that changed since, and rejects unknown blocks", async () => {
    const { note, key } = await noteWithBlocks();
    const { change: none, message } = await proposeChange(
      ctx.workspaceId,
      changeActionSchema.parse({ tool: "edit_note", note: key, edits: [{ op: "delete", block: 9 }] }),
      sources,
      [],
    );
    expect(none).toBeUndefined();
    expect(message).toMatch(/block 9 does not exist/);

    const change = await propose(ctx, sources, { tool: "edit_note", note: key, edits: [{ op: "delete", block: 1 }] });
    await new Promise((r) => setTimeout(r, 1100));
    await updateNote(ctx, note.id, { title: "Changed meanwhile" });
    const [result] = await applyChanges(ctx, [change]);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/changed after this edit was proposed/);
  });
});

describe("finding saved papers with rich filters", () => {
  let ctx: Ctx;
  let ids: string[];
  const sources = new SourceRegistry();
  const run = (action: Parameters<typeof toolFor>[0]) =>
    toolFor(action, sources).run({ workspaceId: ctx.workspaceId, sources });

  beforeAll(async () => {
    ctx = await createUser("Filter user");
    ids = await ingestPapers(
      Array.from({ length: 5 }, (_, i) =>
        paper({ title: `Filter test paper number ${i + 1}`, ids: { s2: `filter-${i}` }, year: 2020 + i }),
      ),
    );
    for (const id of ids) await savePaper(ctx.workspaceId, ctx.userId, id);
    await db
      .update(papers)
      .set({ publicationTypes: ["review"] })
      .where(eq(papers.id, ids[4]));
    const a = await createCollection(ctx.workspaceId, { name: "A" });
    const b = await createCollection(ctx.workspaceId, { name: "B" });
    await addToCollection(ctx.workspaceId, ctx.userId, a.id, [ids[0], ids[1]]);
    await addToCollection(ctx.workspaceId, ctx.userId, b.id, [ids[2]]);
    await createNote(ctx, { title: "On paper 1", paperId: ids[0] });
    await setStatus(ctx.workspaceId, [ids[1]], "read");
  });

  it("combines any-of, exclusion and missing-relationship filters", async () => {
    const r = await run({ tool: "find_saved_papers", collection: ["A", "B"], has_notes: false, status: "saved" });
    expect(r.count).toBe(1);
    expect(r.report).toContain("Filter test paper number 3");

    const noReviews = await run({ tool: "find_saved_papers", not_types: ["review"], in_collection: false });
    expect(noReviews.count).toBe(1);
    expect(noReviews.report).toContain("number 4");

    await expect(run({ tool: "find_saved_papers", collection: "Nope" })).rejects.toThrow(/no collection “Nope”/);
  });

  it("reports the total and pages through it", async () => {
    const first = await run({ tool: "find_saved_papers", sort: "oldest", limit: 2 });
    expect(first.count).toBe(5);
    expect(first.report).toContain("showing 1–2");
    expect(first.report).toContain('"offset": 2');
    expect(first.report).toContain("number 1");
    const last = await run({ tool: "find_saved_papers", sort: "oldest", limit: 2, offset: 4 });
    expect(last.report).toContain("showing 5–5");
    expect(last.report).not.toContain('"offset"');
  });
});

describe("evidence tools", () => {
  let ctx: Ctx;
  let p: string;
  let q: string;
  const sources = new SourceRegistry();
  const run = (action: Parameters<typeof toolFor>[0], provider?: AIProvider) =>
    toolFor(action, sources).run({ workspaceId: ctx.workspaceId, sources, provider });

  beforeAll(async () => {
    ctx = await createUser("Evidence user");
    [p, q] = await ingestPapers([
      paper({ title: "Robust registration of brain scans", ids: { s2: "ev-1" } }),
      paper({ title: "Another paper without a PDF", ids: { s2: "ev-2" } }),
    ]);
    const pdf = makePdfPages([
      ["Introduction. We study image registration.", "Prior work is fast but brittle."],
      [
        "Results. Training sometimes collapses to the identity map.",
        "This degenerate solution appears with strong smoothness.",
        "We report a Dice score of 0.87 on OASIS.",
      ],
    ]);
    const file = await uploadPdf(ctx.workspaceId, ctx.userId, p, new File([pdf], "reg.pdf"));
    await extractPdfText(file.id);
    sources.add({ type: "paper", id: p, title: "Robust registration of brain scans" });
    sources.add({ type: "paper", id: q, title: "Another paper without a PDF" });
  });

  it("finds passages by any phrasing, with page numbers, in a paper and across the library", async () => {
    const inPaper = await run({
      tool: "find_passages",
      queries: ["failure mode", "collapse", "degenerate"],
      papers: ["P1"],
    });
    expect(inPaper.report).toMatch(/P1 p\. 2: “.*collapses to the identity map/);
    const library = await run({ tool: "find_passages", queries: ["degenerate solutions"] });
    expect(library.report).toMatch(/P1 p\. 2 .*degenerate solution/);
    const none = await run({ tool: "find_passages", queries: ["collapse"], papers: ["P2"] });
    expect(none.report).toContain("No full text available for P2");
  });

  it("extracts the same fields from each paper with pages, and says what is not reported", async () => {
    const provider: AIProvider = {
      kind: "mock",
      model: "fields",
      async *stream() {
        yield JSON.stringify({
          fields: {
            Dataset: { value: "OASIS", page: 2, quote: "We report a Dice score of 0.87 on OASIS." },
            "main result": { value: "Dice 0.87", page: 2, quote: "We report a Dice score of 0.87" },
            compute: { value: null },
          },
        });
      },
    };
    const r = await run(
      { tool: "extract_fields", papers: ["P1"], fields: ["dataset", "main result", "compute"] },
      provider,
    );
    expect(r.report).toContain("| dataset | OASIS (p. 2) |");
    expect(r.report).toContain("| compute | not reported |");
    expect(r.report).toContain("P1 · main result (p. 2): “We report a Dice score of 0.87”");
  });

  it("highlights an exactly quoted passage in the PDF, and undoes it", async () => {
    const { change: none, message } = await proposeChange(
      ctx.workspaceId,
      changeActionSchema.parse({ tool: "add_highlight", paper: "P1", text: "words that are not in the paper" }),
      sources,
      [],
    );
    expect(none).toBeUndefined();
    expect(message).toMatch(/not found in the PDF/);

    const change = await propose(ctx, sources, {
      tool: "add_highlight",
      paper: "P1",
      text: "This degenerate solution appears with strong smoothness.",
      comment: "the failure mode",
    });
    expect(change.highlight).toMatchObject({ pageNumber: 2, comment: "the failure mode" });
    expect(change.highlight!.prefix).toContain("identity map");
    const [applied] = await applyChanges(ctx, [change]);
    expect(applied.status, applied.error).toBe("applied");
    const list = await listHighlights(ctx.workspaceId, change.highlight!.fileId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pageNumber: 2, comment: "the failure mode" });
    await undoChanges(ctx, [applied]);
    expect(await listHighlights(ctx.workspaceId, change.highlight!.fileId)).toEqual([]);
  });
});
