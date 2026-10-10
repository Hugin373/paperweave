import { beforeAll, describe, expect, it } from "vitest";
import { saveAiConfig } from "@/server/ai/config";
import { createCollection, addToCollection } from "@/server/library/organize";
import { savePaper } from "@/server/library/library";
import { ingestPapers } from "@/server/papers/ingest";
import { toolFor } from "@/server/research/agent";
import { applyChanges, changeActionSchema, proposeChange, undoChanges } from "@/server/research/changes";
import { SourceRegistry } from "@/server/research/tools";
import {
  createScreening,
  decide,
  listScreenings,
  saveIncluded,
  screenBatch,
  screeningCsv,
  screeningDetail,
  setScreeningRunning,
} from "@/server/screening/service";
import { createUser, paper } from "./helpers";

describe("systematic screening", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let ids: string[];

  beforeAll(async () => {
    ctx = await createUser("Screener");
    await saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "mock", model: "mock-1" });
    ids = await ingestPapers([
      ...Array.from({ length: 4 }, (_, i) =>
        paper({ title: `Cardiac MRI segmentation study ${i + 1}`, ids: { s2: `scr-c${i}` } }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        paper({ title: `Brain CT registration study ${i + 1}`, ids: { s2: `scr-b${i}` } }),
      ),
    ]);
    for (const id of ids) await savePaper(ctx.workspaceId, ctx.userId, id);
  });

  it("decides every paper in batches, with reasons, and lets the user override", async () => {
    const { id, papers } = await createScreening(ctx, {
      title: "Cardiac review",
      criteria: "Include: cardiac imaging studies. Exclude: everything else.",
      paperIds: ids,
    });
    expect(papers).toBe(7);
    expect(await screenBatch(id)).toEqual({ decided: 5, left: 2 });
    expect(await screenBatch(id)).toEqual({ decided: 2, left: 0 });
    const d = await screeningDetail(ctx.workspaceId, id);
    expect(d).toMatchObject({ status: "done", counts: { include: 4, exclude: 3, maybe: 0, pending: 0 } });
    expect(d.items[0]).toMatchObject({ decision: "include", decidedBy: "ai", reason: "[mock] Meets the criteria." });

    const brain = d.items.find((i) => i.paper.title.startsWith("Brain"))!;
    await decide(ctx.workspaceId, id, brain.paper.id, "maybe");
    expect((await screeningDetail(ctx.workspaceId, id)).counts).toMatchObject({ include: 4, maybe: 1, exclude: 2 });

    const { csv } = await screeningCsv(ctx.workspaceId, id);
    expect(csv.split("\n")[0]).toBe("decision,decided_by,title,year,authors,venue,doi,arxiv,reason,evidence");
    expect(csv).toContain('"maybe","user"');

    const saved = await saveIncluded(ctx, id, { name: "Cardiac — included" });
    expect(saved.papers).toBe(4);
  });

  it("pauses and resumes", async () => {
    const { id } = await createScreening(ctx, {
      title: "Paused one",
      criteria: "Include: cardiac studies only.",
      paperIds: ids,
    });
    expect(await setScreeningRunning(ctx.workspaceId, id, false)).toBe("paused");
    expect(await screenBatch(id)).toEqual({ skipped: "paused" });
    expect(await setScreeningRunning(ctx.workspaceId, id, true)).toBe("running");
    expect((await screenBatch(id)).decided).toBe(5);
  });

  it("is started by the assistant from a collection, and read back with paper keys", async () => {
    const col = await createCollection(ctx.workspaceId, { name: "To screen" });
    await addToCollection(ctx.workspaceId, ctx.userId, col.id, ids.slice(0, 3));
    const sources = new SourceRegistry();
    const { change } = await proposeChange(
      ctx.workspaceId,
      changeActionSchema.parse({
        tool: "start_screening",
        title: "From the assistant",
        criteria: "Include: cardiac imaging studies.",
        collection: "to screen",
      }),
      sources,
      [],
    );
    expect(change!.label).toBe("Screen 3 papers in “To screen” against your criteria (“From the assistant”)");
    const [applied] = await applyChanges(ctx, [change!]);
    expect(applied.status, applied.error).toBe("applied");
    await screenBatch(applied.result!.screeningId!);
    const read = await toolFor({ tool: "read_screening", title: "from the assistant" }, sources).run({
      workspaceId: ctx.workspaceId,
      sources,
    });
    expect(read.report).toContain("3/3 screened, 3 include");
    expect(read.report).toMatch(/- P\d+ \[include\] Cardiac MRI segmentation study/);
    await undoChanges(ctx, [applied]);
    expect((await listScreenings(ctx.workspaceId)).map((s) => s.title)).not.toContain("From the assistant");
  });
});
