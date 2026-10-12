import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { citations } from "@/server/db/schema";
import { createConcept, linkPaper } from "@/server/knowledge/concepts";
import { savePaper } from "@/server/library/library";
import { addToCollection, createCollection } from "@/server/library/organize";
import { namedIn, placementHints } from "@/server/library/placement";
import { ingestPapers } from "@/server/papers/ingest";
import { toolFor } from "@/server/research/agent";
import { changeActionSchema, proposeChange } from "@/server/research/changes";
import { SourceRegistry } from "@/server/research/tools";
import { createUser, paper } from "./helpers";

describe("where a paper being saved may belong", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let saved: string, fresh: string, unrelated: string;

  beforeAll(async () => {
    ctx = await createUser("Placement user");
    [saved, fresh, unrelated] = await ingestPapers([
      paper({ title: "Cardiac MRI segmentation", ids: { s2: "place-1" } }),
      paper({
        title: "Faster cardiac segmentation",
        abstract: "We segment magnetic resonance images and point clouds of the heart.",
        ids: { s2: "place-2" },
      }),
      paper({ title: "Sorting algorithms", abstract: "We act on lists.", ids: { s2: "place-3" } }),
    ]);
    await savePaper(ctx.workspaceId, ctx.userId, saved);
    const col = await createCollection(ctx.workspaceId, { name: "Heart imaging" });
    await addToCollection(ctx.workspaceId, ctx.userId, col.id, [saved]);
    const mri = await createConcept(ctx, { name: "MRI", aliases: ["magnetic resonance"] });
    await linkPaper(ctx, mri.id, saved);
    await createConcept(ctx, { name: "Point cloud" });
    await createConcept(ctx, { name: "CT" });
    await db
      .insert(citations)
      .values({ citingPaperId: fresh, citedPaperId: saved, source: "semantic_scholar" as const });
  });

  it("matches concept names as whole words, plurals included, acronyms by case", () => {
    expect(namedIn("Point cloud", "completing point-clouds of rooms")).toBe(true);
    expect(namedIn("MRI", "brain MRIs")).toBe(true);
    expect(namedIn("CT", "we act on it")).toBe(false);
    expect(namedIn("CT", "the ct scanner")).toBe(false);
    expect(namedIn("CT", "low-dose CT scans")).toBe(true);
    expect(namedIn("transformer", "transformers")).toBe(true);
    expect(namedIn("graph", "photographs")).toBe(false);
  });

  it("finds collections and concepts from citations and concept names, without AI", async () => {
    const hints = await placementHints(ctx.workspaceId, [fresh, unrelated]);
    expect(hints.get(fresh)).toEqual({
      collections: [{ name: "Heart imaging", why: "it cites 1 of its papers" }],
      concepts: [
        { name: "MRI", why: "“magnetic resonance” in its abstract; it cites 1 of its papers" },
        { name: "Point cloud", why: "named in its abstract" },
      ],
    });
    expect(hints.get(unrelated)).toEqual({ collections: [], concepts: [] });
    // Where a paper already is is not suggested again.
    expect((await placementHints(ctx.workspaceId, [saved])).get(saved)).toEqual({ collections: [], concepts: [] });
  });

  it("tells the assistant where the papers it saves may go", async () => {
    const sources = new SourceRegistry();
    sources.add({ type: "paper", id: fresh, title: "Faster cardiac segmentation" });
    sources.add({ type: "paper", id: unrelated, title: "Sorting algorithms" });
    const { change, message } = await proposeChange(
      ctx.workspaceId,
      changeActionSchema.parse({ tool: "save_papers", papers: ["P1", "P2"] }),
      sources,
      [],
    );
    expect(change?.label).toBe("Save 2 papers to your library");
    expect(message).toContain(
      "- P1: collection “Heart imaging” (it cites 1 of its papers); concept “MRI” (“magnetic resonance” in its abstract; it cites 1 of its papers); concept “Point cloud” (named in its abstract)",
    );
    expect(message).toContain("- P2: no hints");
    // Placing them is the next step, once the user agrees.
    expect(message).toMatch(/Placement not proposed yet/);
  });

  it("suggests where papers could go when the user agrees to place them", async () => {
    const sources = new SourceRegistry();
    sources.add({ type: "paper", id: fresh, title: "Faster cardiac segmentation" });
    sources.add({ type: "paper", id: saved, title: "Cardiac MRI segmentation" });
    const { report } = await toolFor({ tool: "suggest_placement", papers: ["P1", "p2", "P1"] }, sources).run({
      workspaceId: ctx.workspaceId,
      sources,
    });
    expect(report).toContain("- P1: collection “Heart imaging”");
    expect(report).toContain("Abstract: We segment magnetic resonance images and point clouds of the heart.");
    expect(report).toContain("- P2: no hints\n  Already in: collections “Heart imaging”; concepts “MRI”");
    expect(report.match(/- P1:/g)).toHaveLength(1);
  });

  it("shows when saved papers were added, to find the ones just saved", async () => {
    const sources = new SourceRegistry();
    const { report } = await toolFor({ tool: "find_saved_papers", sort: "added" }, sources).run({
      workspaceId: ctx.workspaceId,
      sources,
    });
    expect(report).toMatch(/- P1: Cardiac MRI segmentation \(.*\) · saved · added just now/);
  });
});
