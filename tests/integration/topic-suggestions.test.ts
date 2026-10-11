import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { saveAiConfig } from "@/server/ai/config";
import { db } from "@/server/db/client";
import { citations, jobs } from "@/server/db/schema";
import { createConcept, linkPaper } from "@/server/knowledge/concepts";
import { savePaper } from "@/server/library/library";
import { addToCollection, createCollection } from "@/server/library/organize";
import { ingestPapers } from "@/server/papers/ingest";
import { runOneJob } from "@/server/jobs/worker";
import { collectionQuery, fieldName, parseIdeas, topicSuggestions } from "@/server/search/suggestions";
import { createUser, paper } from "./helpers";

describe("personal search suggestions", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    ctx = await createUser("Suggestion user");
    const ids = await ingestPapers(
      ["Brain age from MRI", "Harmonizing multi-site MRI", "Contrastive pretraining for scans", "Other thing"].map(
        (title, i) => paper({ title, ids: { s2: `sugg-${i}` }, fieldsOfStudy: ["Computer Science"] }),
      ),
    );
    for (const id of ids) await savePaper(ctx.workspaceId, ctx.userId, id);
    const mri = await createConcept(ctx, { name: "MRI" });
    for (const id of ids.slice(0, 3)) await linkPaper(ctx, mri.id, id);
    const col = await createCollection(ctx.workspaceId, { name: "Neuroimaging & brain MRI (brain age)" });
    await addToCollection(ctx.workspaceId, ctx.userId, col.id, ids.slice(0, 2));
    const misc = await createCollection(ctx.workspaceId, { name: "Other / miscellaneous" });
    await addToCollection(ctx.workspaceId, ctx.userId, misc.id, [ids[3]]);
    // Papers outside the library, connected by citations: a classic two of them cite, recent work citing one,
    // and biology papers (a field the library itself does not have).
    const [classic, recent, ...bio] = await ingestPapers([
      paper({ title: "A classic MRI method", ids: { s2: "sugg-x1" }, year: 2010, fieldsOfStudy: ["Computer Science"] }),
      paper({
        title: "Recent work on brain age",
        ids: { s2: "sugg-x2" },
        year: new Date().getFullYear(),
        fieldsOfStudy: ["Computer Science"],
      }),
      ...[1, 2, 3].map((i) =>
        paper({ title: `Cell biology study ${i}`, ids: { s2: `sugg-b${i}` }, fieldsOfStudy: ["Biology"] }),
      ),
    ]);
    await db
      .insert(citations)
      .values([
        { citingPaperId: ids[0], citedPaperId: classic, source: "semantic_scholar" as const },
        { citingPaperId: ids[1], citedPaperId: classic, source: "semantic_scholar" as const },
        { citingPaperId: recent, citedPaperId: ids[0], source: "semantic_scholar" as const },
        ...bio.map((b) => ({ citingPaperId: b, citedPaperId: ids[2], source: "semantic_scholar" as const })),
      ]);
  });

  it("turns names into searches, and names fields", () => {
    expect(collectionQuery("Spatial reasoning in VLMs / MLLMs")).toBe("Spatial reasoning in VLMs MLLMs");
    expect(collectionQuery("Neuroimaging & brain MRI (Alzheimer's, brain age)")).toBe("Neuroimaging brain MRI");
    expect(fieldName("Medicine")).toBe("Medicine");
    expect(fieldName("q-bio.NC")).toBe("Neuroscience");
    expect(fieldName("eess.IV")).toBe("Image and Video Processing");
    expect(fieldName("cs.CV")).toBe("Computer Science");
    expect(fieldName("xx.YY")).toBeNull();
  });

  it("works without AI: suggestions from the library and its citations", async () => {
    const r = await topicSuggestions(ctx.workspaceId);
    expect(r.ai.status).toBe("off");
    const of = (kind: string) => r.library.filter((s) => s.kind === kind);
    // "Other / miscellaneous" is not a topic.
    expect(of("library").map((s) => s.query)).toEqual(["MRI", "Neuroimaging brain MRI"]);
    expect(of("builds_on")).toEqual([
      { query: "A classic MRI method", why: "Cited by 2 of your papers", kind: "builds_on" },
    ]);
    expect(of("cited_by")).toEqual([
      { query: "Recent work on brain age", why: "Cites one of your papers", kind: "cited_by" },
    ]);
    // Biology papers cite the library's MRI paper: suggested together with that topic.
    expect(of("neighbouring")).toEqual([
      {
        query: "MRI biology",
        why: "3 papers in Biology cite yours or are cited by them",
        kind: "neighbouring",
        field: "Biology",
      },
    ]);
  });

  it("thinks up AI ideas in the background, once, and keeps them", async () => {
    await saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "mock", model: "mock-1" });
    await db.delete(jobs);
    const first = await topicSuggestions(ctx.workspaceId);
    expect(first.ai).toMatchObject({ status: "pending", items: [] });
    expect(first.library.length).toBeGreaterThan(0); // the library suggestions do not wait for the AI
    await topicSuggestions(ctx.workspaceId); // asking again does not queue a second job
    expect(await db.select().from(jobs).where(eq(jobs.type, "topic_suggestions"))).toHaveLength(1);

    expect(await runOneJob()).toBe(true);
    const ready = await topicSuggestions(ctx.workspaceId);
    expect(ready.ai.status).toBe("ready");
    expect(ready.ai.items).toEqual([
      { query: "mock next step search", why: "[mock] extends your library", kind: "related", ai: true },
      {
        query: "mock neighbouring field search",
        why: "[mock] borrowed idea",
        kind: "neighbouring",
        ai: true,
        field: "Mock field",
      },
    ]);
  });

  it("reads the AI's answer defensively", () => {
    expect(parseIdeas("not json")).toEqual([]);
    const ideas = parseIdeas(
      'Sure: {"related":[{"query":"\\"Diffusion priors\\"","why":"x"},{"query":"diffusion priors","why":"dup"}],"neighbouring":[{"query":"ab"}]}',
    );
    expect(ideas.map((i) => i.query)).toEqual(["Diffusion priors"]); // quotes trimmed, duplicates and junk dropped
  });
});
