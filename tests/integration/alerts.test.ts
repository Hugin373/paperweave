import { beforeAll, describe, expect, it } from "vitest";
import {
  createSavedSearch,
  listSavedSearches,
  markSearchSeen,
  runSavedSearch,
  savedSearchResultsOf,
  unseenCount,
} from "@/server/alerts/service";
import { applyChanges, changeActionSchema, proposeChange, undoChanges } from "@/server/research/changes";
import { SourceRegistry } from "@/server/research/tools";
import { createUser, FakeProvider, installFakeScholarly, paper } from "./helpers";

describe("saved searches", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  const corpus = [paper({ title: "Diffusion MRI reconstruction baseline", ids: { arxiv: "2501.00001" }, year: 2025 })];

  beforeAll(async () => {
    ctx = await createUser("Alert follower");
    await installFakeScholarly(new FakeProvider("arxiv", corpus));
  });

  it("treats what already exists as seen, and later finds as new until looked at", async () => {
    const { id, created } = await createSavedSearch(ctx, { query: "diffusion  MRI", source: "arxiv" });
    expect(created).toBe(true);
    await runSavedSearch(id, true);
    expect(await listSavedSearches(ctx.workspaceId)).toMatchObject([
      { query: "diffusion MRI", source: "arxiv", newCount: 0, total: 1 },
    ]);

    corpus.push(paper({ title: "Diffusion MRI sampling, faster", ids: { arxiv: "2610.00002" }, year: 2026 }));
    expect(await runSavedSearch(id)).toEqual({ found: 2, new: 1 });
    expect(await unseenCount(ctx.workspaceId)).toBe(1);
    const { papers } = await savedSearchResultsOf(ctx.workspaceId, id);
    expect(papers.map((p) => [p.title, p.isNew])).toEqual([
      ["Diffusion MRI sampling, faster", true],
      ["Diffusion MRI reconstruction baseline", false],
    ]);

    await markSearchSeen(ctx.workspaceId, id);
    expect(await unseenCount(ctx.workspaceId)).toBe(0);
    expect((await createSavedSearch(ctx, { query: "Diffusion MRI", source: "arxiv" })).created).toBe(false);
  });

  it("can be proposed by the assistant, and undoing removes only a search it created", async () => {
    const sources = new SourceRegistry();
    const { change } = await proposeChange(
      ctx.workspaceId,
      changeActionSchema.parse({ tool: "save_search", query: "point cloud completion", source: "general" }),
      sources,
      [],
    );
    expect(change!.label).toBe("Follow “point cloud completion”: check daily and list new papers under New papers");
    const [applied] = await applyChanges(ctx, [change!]);
    expect(applied.status, applied.error).toBe("applied");
    expect((await listSavedSearches(ctx.workspaceId)).map((s) => s.query)).toContain("point cloud completion");
    await undoChanges(ctx, [applied]);
    expect((await listSavedSearches(ctx.workspaceId)).map((s) => s.query)).not.toContain("point cloud completion");
  });
});
