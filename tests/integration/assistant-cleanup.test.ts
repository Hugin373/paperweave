import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProposedChange } from "@/lib/types";
import { db } from "@/server/db/client";
import {
  collectionPapers,
  collections,
  concepts,
  libraryItems,
  noteLinks,
  paperTags,
  savedSearches,
  savedSearchResults,
  tags,
} from "@/server/db/schema";
import { createConcept, getConceptDetail, linkPaper, relateConcepts } from "@/server/knowledge/concepts";
import { createNote } from "@/server/knowledge/notes";
import { savePaper, setStatus } from "@/server/library/library";
import { addToCollection, createCollection, tagPapers } from "@/server/library/organize";
import { ingestPapers } from "@/server/papers/ingest";
import { toolFor } from "@/server/research/agent";
import { applyChanges, changeActionSchema, proposeChange, undoChanges } from "@/server/research/changes";
import { SourceRegistry } from "@/server/research/tools";
import { createUser, paper } from "./helpers";

type Ctx = Awaited<ReturnType<typeof createUser>>;

describe("assistant clean-up changes", () => {
  let ctx: Ctx;
  let a: string, b: string, c: string;
  const sources = new SourceRegistry();

  async function propose(action: unknown, existing: ProposedChange[] = []) {
    const { change, message } = await proposeChange(
      ctx.workspaceId,
      changeActionSchema.parse(action),
      sources,
      existing,
    );
    return { change, message };
  }
  async function applyAndUndo(
    change: ProposedChange,
    checkApplied: () => Promise<void>,
    checkUndone: () => Promise<void>,
  ) {
    const [applied] = await applyChanges(ctx, [change]);
    expect(applied.status, applied.error).toBe("applied");
    await checkApplied();
    const [undone] = await undoChanges(ctx, [applied]);
    expect(undone.status, undone.error).toBe("undone");
    await checkUndone();
  }

  beforeAll(async () => {
    ctx = await createUser("Tidy user");
    [a, b, c] = await ingestPapers([
      paper({ title: "Cardiac MRI segmentation", ids: { s2: "tidy-1" } }),
      paper({ title: "Brain MRI registration", ids: { s2: "tidy-2" } }),
      paper({ title: "Point cloud completion", ids: { s2: "tidy-3" } }),
    ]);
    for (const id of [a, b, c]) await savePaper(ctx.workspaceId, ctx.userId, id);
    for (const [id, title] of [
      [a, "Cardiac MRI segmentation"],
      [b, "Brain MRI registration"],
      [c, "Point cloud completion"],
    ]) {
      sources.add({ type: "paper", id, title });
    }
  });

  it("renames and describes a collection, and undoes it", async () => {
    const col = await createCollection(ctx.workspaceId, { name: "Thesis", description: "old" });
    const { change } = await propose({
      tool: "edit_collection",
      collection: "thesis",
      name: "Thesis ch. 2",
      description: "MRI work",
    });
    expect(change?.label).toMatch(/rename it to “Thesis ch. 2” and update its description/);
    const row = async () => (await db.select().from(collections).where(eq(collections.id, col.id)))[0];
    await applyAndUndo(
      change!,
      async () => expect(await row()).toMatchObject({ name: "Thesis ch. 2", description: "MRI work" }),
      async () => expect(await row()).toMatchObject({ name: "Thesis", description: "old" }),
    );
    expect((await propose({ tool: "edit_collection", collection: "Thesis" })).message).toMatch(/nothing would change/);
  });

  it("deletes a collection but keeps its papers, and brings it back with the same id", async () => {
    const col = await createCollection(ctx.workspaceId, { name: "Old reading list" });
    await addToCollection(ctx.workspaceId, ctx.userId, col.id, [a, b]);
    const { change } = await propose({ tool: "delete_collection", collection: "Old reading list" });
    expect(change?.label).toMatch(/its 2 papers stay in your library/);
    const members = async () =>
      (await db.select().from(collectionPapers).where(eq(collectionPapers.collectionId, col.id))).length;
    await applyAndUndo(
      change!,
      async () => {
        expect(await db.select().from(collections).where(eq(collections.id, col.id))).toHaveLength(0);
        expect(await db.select().from(libraryItems).where(eq(libraryItems.paperId, a))).toHaveLength(1);
      },
      async () => expect(await members()).toBe(2),
    );
  });

  it("untags papers, renames and deletes tags, each undoable", async () => {
    await tagPapers(ctx.workspaceId, ctx.userId, [a, b], { names: ["surveys"] });
    const [tag] = await db
      .select()
      .from(tags)
      .where(and(eq(tags.workspaceId, ctx.workspaceId), eq(tags.name, "surveys")));
    const tagged = async () => (await db.select().from(paperTags).where(eq(paperTags.tagId, tag.id))).length;

    const untag = (await propose({ tool: "untag_papers", tags: ["#surveys"], papers: ["P1", "P3"] })).change!;
    expect(untag.paperIds).toEqual([a]); // P3 never had the tag
    await applyAndUndo(
      untag,
      async () => expect(await tagged()).toBe(1),
      async () => expect(await tagged()).toBe(2),
    );

    const rename = (await propose({ tool: "rename_tag", tag: "surveys", name: "survey" })).change!;
    const name = async () => (await db.select().from(tags).where(eq(tags.id, tag.id)))[0]?.name;
    await applyAndUndo(
      rename,
      async () => expect(await name()).toBe("survey"),
      async () => expect(await name()).toBe("surveys"),
    );

    const del = (await propose({ tool: "delete_tag", tag: "surveys" })).change!;
    expect(del.label).toMatch(/removes it from 2 papers/);
    await applyAndUndo(
      del,
      async () => expect(await name()).toBeUndefined(),
      async () => expect(await tagged()).toBe(2),
    );
  });

  it("rewrites a concept's description, and deletes a concept restoring links, relations and note links on undo", async () => {
    const mri = await createConcept(ctx, { name: "MRI", description: "old" });
    const imaging = await createConcept(ctx, { name: "Medical imaging" });
    await linkPaper(ctx, mri.id, a);
    await linkPaper(ctx, mri.id, b);
    await relateConcepts(ctx, mri.id, imaging.id, true);
    await createNote(ctx, {
      title: "MRI thoughts",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "mention", attrs: { id: `concept:${mri.id}`, label: "MRI" } }] },
        ],
      },
    });
    const links = async () => (await db.select().from(noteLinks).where(eq(noteLinks.targetConceptId, mri.id))).length;
    expect(await links()).toBe(1);

    const edit = (await propose({ tool: "edit_concept", concept: "MRI", description: "Magnetic resonance imaging" }))
      .change!;
    const desc = async () => (await db.select().from(concepts).where(eq(concepts.id, mri.id)))[0]?.description;
    await applyAndUndo(
      edit,
      async () => expect(await desc()).toBe("Magnetic resonance imaging"),
      async () => expect(await desc()).toBe("old"),
    );

    const del = (await propose({ tool: "delete_concept", concept: "mri" })).change!;
    expect(del.label).toMatch(/unlinks 2 papers/);
    await applyAndUndo(
      del,
      async () => expect(await desc()).toBeUndefined(),
      async () => {
        const detail = await getConceptDetail(ctx, mri.id);
        expect(detail.papers).toHaveLength(2);
        expect(detail.related.map((r) => r.name)).toEqual(["Medical imaging"]);
        expect(await links()).toBe(1);
      },
    );
  });

  it("removes papers from the library and restores their status, collections and tags", async () => {
    const col = await createCollection(ctx.workspaceId, { name: "Keep" });
    await addToCollection(ctx.workspaceId, ctx.userId, col.id, [c]);
    await tagPapers(ctx.workspaceId, ctx.userId, [c], { names: ["to-read"] });
    await setStatus(ctx.workspaceId, [c], "reading");
    const { change } = await propose({ tool: "remove_from_library", papers: ["P3"] });
    expect(change?.label).toMatch(/notes, highlights and PDFs are kept/);
    const item = async () =>
      (
        await db
          .select()
          .from(libraryItems)
          .where(and(eq(libraryItems.workspaceId, ctx.workspaceId), eq(libraryItems.paperId, c)))
      )[0];
    await applyAndUndo(
      change!,
      async () => expect(await item()).toBeUndefined(),
      async () => {
        expect((await item())?.status).toBe("reading");
        expect(await db.select().from(collectionPapers).where(eq(collectionPapers.paperId, c))).toHaveLength(1);
        expect(await db.select().from(paperTags).where(eq(paperTags.paperId, c))).toHaveLength(1);
      },
    );
  });

  it("stops following a topic and restores it with its papers on undo; reads what is followed", async () => {
    const [search] = await db
      .insert(savedSearches)
      .values({ workspaceId: ctx.workspaceId, query: "brain age MRI", source: "biomedical", createdBy: ctx.userId })
      .returning();
    await db.insert(savedSearchResults).values({ searchId: search.id, paperId: b, seen: false });

    const listed = await toolFor({ tool: "read_new_papers" }, sources).run({ workspaceId: ctx.workspaceId, sources });
    expect(listed.report).toMatch(/“brain age MRI” \(biomedical\) — 1 new of 1/);
    const one = await toolFor({ tool: "read_new_papers", search: "brain age" }, sources).run({
      workspaceId: ctx.workspaceId,
      sources,
    });
    expect(one.report).toMatch(/P2 \[new\]: Brain MRI registration/);

    const { change } = await propose({ tool: "stop_following", query: "Brain Age MRI" });
    expect(change?.label).toBe("Stop following “brain age MRI” (New papers stops checking it)");
    await applyAndUndo(
      change!,
      async () => expect(await db.select().from(savedSearches).where(eq(savedSearches.id, search.id))).toHaveLength(0),
      async () =>
        expect(
          await db.select().from(savedSearchResults).where(eq(savedSearchResults.searchId, search.id)),
        ).toHaveLength(1),
    );
    expect((await propose({ tool: "stop_following", query: "nothing like this" })).message).toMatch(/not following/);
  });
});
