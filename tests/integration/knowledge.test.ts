import { beforeAll, describe, expect, it } from "vitest";
import { AUTO_COLOR_ORDER } from "@/lib/collection-colors";
import type { PMNode } from "@/lib/prosemirror";
import { db } from "@/server/db/client";
import { papers } from "@/server/db/schema";
import { focusedGraph, workspaceGraph } from "@/server/graph/knowledge-graph";
import { createConcept, getConceptDetail, linkPaper, relateConcepts } from "@/server/knowledge/concepts";
import { searchLinkTargets } from "@/server/knowledge/link-targets";
import { createNote, getNoteDetail, updateNote } from "@/server/knowledge/notes";
import { savePaper } from "@/server/library/library";
import { addToCollection, createCollection, deleteCollection } from "@/server/library/organize";
import { ingestPapers } from "@/server/papers/ingest";
import { getPaperDetail } from "@/server/papers/service";
import { searchWorkspace } from "@/server/search/workspace-search";
import { createUser, paper } from "./helpers";

const mention = (type: string, id: string, label: string): PMNode => ({
  type: "mention",
  attrs: { id: `${type}:${id}`, label },
});
const doc = (...content: PMNode[]): PMNode => ({ type: "doc", content: [{ type: "paragraph", content }] });
const text = (t: string): PMNode => ({ type: "text", text: t });

describe("notes, concepts, backlinks, graph and workspace search", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let paperId: string;
  let conceptId: string;
  let relatedId: string;

  beforeAll(async () => {
    ctx = await createUser("Thinker");
    [paperId] = await ingestPapers([
      paper({ title: "Depth Anything: unleashing large-scale unlabeled data", ids: { s2: "kn-1" } }),
    ]);
    await savePaper(ctx.workspaceId, ctx.userId, paperId);
    conceptId = (
      await createConcept(ctx, {
        name: "Metric depth",
        aliases: ["absolute depth"],
        description: "Depth in physical units such as meters.",
      })
    ).id;
    relatedId = (await createConcept(ctx, { name: "Ordinal depth" })).id;
  });

  it("enforces unique concept names per workspace", async () => {
    await expect(createConcept(ctx, { name: "metric DEPTH" })).rejects.toThrow(/already exists/);
  });

  it("links papers and concepts and relates concepts", async () => {
    await linkPaper(ctx, conceptId, paperId);
    await relateConcepts(ctx, relatedId, conceptId, true);
    const detail = await getConceptDetail(ctx, conceptId);
    expect(detail.papers.map((p) => p.id)).toEqual([paperId]);
    expect(detail.related.map((c) => c.name)).toEqual(["Ordinal depth"]);
    expect((await getPaperDetail(ctx.workspaceId, paperId)).concepts.map((c) => c.name)).toEqual(["Metric depth"]);
  });

  it("derives links from note content and exposes backlinks", async () => {
    const target = await createNote(ctx, { title: "Reading log" });
    const note = await createNote(ctx, {
      title: "Depth survey",
      content: doc(
        text("Compare "),
        mention("concept", conceptId, "Metric depth"),
        text(" in "),
        mention("paper", paperId, "Depth Anything"),
        text(" — see "),
        mention("note", target.id, "Reading log"),
      ),
    });
    const detail = await getNoteDetail(ctx, note.id);
    expect(detail.links.concepts.map((c) => c.name)).toEqual(["Metric depth"]);
    expect(detail.links.papers.map((p) => p.id)).toEqual([paperId]);
    expect(detail.links.notes.map((n) => n.title)).toEqual(["Reading log"]);
    expect((await getNoteDetail(ctx, target.id)).backlinks.map((b) => b.title)).toEqual(["Depth survey"]);
    expect((await getConceptDetail(ctx, conceptId)).notes.map((n) => n.title)).toEqual(["Depth survey"]);
    expect((await getPaperDetail(ctx.workspaceId, paperId)).mentionedIn.map((n) => n.title)).toEqual(["Depth survey"]);

    // Editing the content replaces the links.
    await updateNote(ctx, note.id, { content: doc(text("Only "), mention("concept", relatedId, "Ordinal depth")) });
    const updated = await getNoteDetail(ctx, note.id);
    expect(updated.links.concepts.map((c) => c.name)).toEqual(["Ordinal depth"]);
    expect(updated.links.papers).toEqual([]);
  });

  it("drops links to other workspaces' objects", async () => {
    const other = await createUser("Stranger");
    const foreign = await createConcept(other, { name: "Private idea" });
    const note = await createNote(ctx, {
      title: "Sneaky",
      content: doc(mention("concept", foreign.id, "Private idea")),
    });
    expect((await getNoteDetail(ctx, note.id)).links.concepts).toEqual([]);
  });

  it("rejects stale concurrent edits", async () => {
    const note = await createNote(ctx, { title: "Versioned" });
    const base = note.updatedAt.toISOString();
    await updateNote(ctx, note.id, { title: "First edit", baseUpdatedAt: base });
    await expect(updateNote(ctx, note.id, { title: "Second edit", baseUpdatedAt: base })).rejects.toThrow(
      /changed elsewhere/,
    );
  });

  it("suggests link targets", async () => {
    const targets = await searchLinkTargets(ctx.workspaceId, "depth");
    expect(targets.map((t) => `${t.type}:${t.label}`)).toEqual(
      expect.arrayContaining([
        "concept:Metric depth",
        "concept:Ordinal depth",
        "paper:Depth Anything: unleashing large-scale unlabeled data",
        "note:Depth survey",
      ]),
    );
    expect((await searchLinkTargets(ctx.workspaceId, "absolute", ["concept"]))[0].label).toBe("Metric depth");
  });

  it("builds the workspace and focused knowledge graphs", async () => {
    const g = await workspaceGraph(ctx.workspaceId);
    const types = new Set(g.edges.map((e) => e.type));
    expect(types).toEqual(new Set(["paper_concept", "concept_concept", "note_concept"]));
    expect(g.nodes.some((n) => n.type === "paper" && n.status === "saved")).toBe(true);

    const focused = await focusedGraph(ctx.workspaceId, { type: "concept", id: conceptId }, 1);
    const labels = focused.nodes.map((n) => n.label).sort();
    expect(labels).toEqual(["Depth Anything: unleashing large-scale unlabeled data", "Metric depth", "Ordinal depth"]);
    const deeper = await focusedGraph(ctx.workspaceId, { type: "concept", id: conceptId }, 2);
    expect(deeper.nodes.length).toBeGreaterThan(focused.nodes.length);

    // Papers carry their collections, for "color by collection".
    expect(g.collections).toEqual([]);
    // Collections created without a color take the least-used palette color.
    const col = await createCollection(ctx.workspaceId, { name: "Depth reading" });
    const second = await createCollection(ctx.workspaceId, { name: "Depth later" });
    expect([col.color, second.color]).toEqual([AUTO_COLOR_ORDER[0], AUTO_COLOR_ORDER[1]]);
    await deleteCollection(ctx.workspaceId, second.id);
    await addToCollection(ctx.workspaceId, ctx.userId, col.id, [paperId]);
    const colored = await workspaceGraph(ctx.workspaceId);
    expect(colored.collections).toEqual([{ id: col.id, name: "Depth reading", color: AUTO_COLOR_ORDER[0] }]);
    expect(colored.nodes.find((n) => n.entityId === paperId)?.collectionIds).toEqual([col.id]);
    expect(colored.nodes.filter((n) => n.type !== "paper").every((n) => n.collectionIds === undefined)).toBe(true);
    expect((await focusedGraph(ctx.workspaceId, { type: "concept", id: conceptId }, 1)).collections).toHaveLength(1);
  });

  it("searches personal knowledge across object types", async () => {
    const res = await searchWorkspace(ctx.workspaceId, "depth");
    expect(res.papers.map((p) => p.paper.id)).toEqual([paperId]);
    expect(res.concepts.map((c) => c.name)).toEqual(expect.arrayContaining(["Metric depth", "Ordinal depth"]));
    expect(res.notes.map((n) => n.title)).toContain("Depth survey");
    const byAlias = await searchWorkspace(ctx.workspaceId, "absolute");
    expect(byAlias.concepts.map((c) => c.name)).toEqual(["Metric depth"]);
    const prefix = await searchWorkspace(ctx.workspaceId, "unlab");
    expect(prefix.papers).toHaveLength(1);
    const other = await createUser("Nosy");
    expect((await searchWorkspace(other.workspaceId, "depth")).concepts).toEqual([]);
  });
});

describe("isolation and concurrency", () => {
  it("does not show another workspace's private paper in a focused graph", async () => {
    const owner = await createUser("Private owner");
    const other = await createUser("Unrelated viewer");
    const [p] = await db
      .insert(papers)
      .values({
        ownerWorkspaceId: owner.workspaceId,
        source: "user",
        title: "Secret unpublished work",
        titleNorm: "secret unpublished work",
        firstAuthorNorm: "",
        authorsText: "",
      })
      .returning();
    expect((await focusedGraph(other.workspaceId, { type: "paper", id: p.id })).nodes).toEqual([]);
    expect((await focusedGraph(owner.workspaceId, { type: "paper", id: p.id })).nodes).toHaveLength(1);
  });

  it("ignores another workspace's collection in the graph filter", async () => {
    const owner = await createUser("Graph owner");
    const other = await createUser("Graph observer");
    const [id] = await ingestPapers([paper({ title: "Graph collection probe paper", ids: { s2: "graph-oracle" } })]);
    const collection = await createCollection(owner.workspaceId, { name: "Hidden" });
    await addToCollection(owner.workspaceId, owner.userId, collection.id, [id]);
    await savePaper(other.workspaceId, other.userId, id);
    expect((await workspaceGraph(other.workspaceId, { collectionId: collection.id })).nodes).toEqual([]);
  });

  it("accepts only one of several saves based on the same note version", async () => {
    const ctx = await createUser("Concurrent editor");
    const note = await createNote(ctx, { title: "Original" });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        updateNote(ctx, note.id, { title: `Edit ${i}`, baseUpdatedAt: note.updatedAt.toISOString() }),
      ),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
