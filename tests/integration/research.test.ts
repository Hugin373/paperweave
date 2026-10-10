import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { textToDoc } from "@/lib/prosemirror";
import type { ProposedChange, ResearchSource, ResearchThreadDto } from "@/lib/types";
import { providerForWorkspace, saveAiConfig } from "@/server/ai/config";
import { db } from "@/server/db/client";
import {
  collections,
  concepts,
  libraryItems,
  noteLinks,
  notes,
  researchMessages,
  researchThreads,
} from "@/server/db/schema";
import { createConcept, getConceptDetail, linkPaper } from "@/server/knowledge/concepts";
import { createNote, getNoteDetail } from "@/server/knowledge/notes";
import { savePaper, setStatus } from "@/server/library/library";
import { addToCollection, createCollection, tagPapers } from "@/server/library/organize";
import { ingestPapers } from "@/server/papers/ingest";
import { applyChanges, changeActionSchema, proposeChange, undoChanges } from "@/server/research/changes";
import { roundPrompt, toolFor } from "@/server/research/agent";
import { SourceRegistry } from "@/server/research/tools";
import { extractPdfText, uploadPdf } from "@/server/files/service";
import { discover } from "@/server/papers/discovery";
import {
  askFollowUp,
  cancelRun,
  updateChanges,
  createThread,
  deleteThread,
  getThread,
  listThreads,
  rankAnswerSources,
  saveAnswerAsNote,
} from "@/server/research/service";
import { createUser, FakeProvider, installFakeScholarly, makePdf, paper } from "./helpers";

const corpus = [
  paper({ title: "Monocular depth estimation with transformers", ids: { s2: "rd-1" }, year: 2021, citationCount: 800 }),
  paper({ title: "Self-supervised monocular depth estimation", ids: { s2: "rd-2" }, year: 2019, citationCount: 1500 }),
  paper({ title: "Depth estimation benchmarks", ids: { s2: "rd-3" }, year: 2023, citationCount: 40 }),
];

async function waitForRun(ctx: Awaited<ReturnType<typeof createUser>>, threadId: string): Promise<ResearchThreadDto> {
  for (let i = 0; i < 200; i++) {
    const t = await getThread(ctx, threadId);
    if (t.messages.at(-1)?.status !== "running") return t;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("research did not finish");
}

describe("AI research assistant", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    await installFakeScholarly(new FakeProvider("semantic_scholar", corpus));
    ctx = await createUser("Researcher");
    await saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "mock", model: "mock-1" });
    await createNote(ctx, {
      title: "My thoughts on depth",
      content: textToDoc("Monocular depth estimation is ill-posed."),
    });
  });

  it("requires a configured provider", async () => {
    const other = await createUser("NoAi");
    await expect(createThread(other, { question: "What is depth estimation?", mode: "deep" })).rejects.toMatchObject({
      kind: "not_configured",
    });
  });

  it("researches in rounds, cites sources, answers follow-ups and saves answers as linked notes", async () => {
    const { threadId } = await createThread(ctx, {
      question: "What are the main approaches to monocular depth estimation?",
      mode: "deep",
    });
    const thread = await waitForRun(ctx, threadId);
    const answer = thread.messages[1];
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(answer.status).toBe("done");
    expect(answer.steps.map((s) => s.kind)).toEqual(["plan", "search", "library", "plan", "write"]);
    expect(answer.steps.every((s) => s.status === "done")).toBe(true);
    expect(answer.steps.find((s) => s.kind === "search")?.count).toBeGreaterThan(0);
    expect(answer.content).toMatch(/\[P1\]/);
    const p1 = answer.sources.find((s) => s.key === "P1")!;
    expect(p1.type).toBe("paper");
    expect(thread.papers[p1.id]?.title).toBe(p1.title);
    // The user's note was found through the library search.
    expect(answer.sources.some((s) => s.type === "note" && s.title === "My thoughts on depth")).toBe(true);

    expect((await listThreads(ctx))[0]).toMatchObject({ id: threadId, status: "done" });

    // Follow-ups keep the same citation keys for the same sources.
    await askFollowUp(ctx, threadId, { question: "Which one is self-supervised?", mode: "search" });
    const after = await waitForRun(ctx, threadId);
    expect(after.messages).toHaveLength(4);
    expect(after.messages[3].status).toBe("done");
    expect(after.messages[3].sources.find((s) => s.key === "P1")?.id).toBe(p1.id);

    // Saving creates a note whose citations link to the papers.
    const { noteId } = await saveAnswerAsNote(ctx, threadId, answer.id);
    const links = await db.select().from(noteLinks).where(eq(noteLinks.noteId, noteId));
    expect(links.map((l) => l.targetPaperId)).toContain(p1.id);
  });

  it("ranks the cited sources after writing, and re-ranks on request", async () => {
    const { threadId } = await createThread(ctx, { question: "depth estimation", mode: "search" });
    const t = await waitForRun(ctx, threadId);
    const m = t.messages[1];
    expect(m.status).toBe("done");
    expect(m.steps.map((s) => s.kind)).toContain("rank");
    const cited = m.sources.filter((s) => m.content.includes(`[${s.key}]`)).map((s) => s.key);
    expect(cited.length).toBeGreaterThanOrEqual(3);
    // Every cited paper appears exactly once: first in the reading order, the rest with a priority.
    const ranking = m.ranking!;
    expect([...ranking.start.map((s) => s.key), ...ranking.priority.map((p) => p.key)].sort()).toEqual(
      [...cited].sort(),
    );
    expect(ranking.priority.map((p) => p.level)).toEqual(["high", "low"]);

    await db.update(researchMessages).set({ ranking: null }).where(eq(researchMessages.id, m.id));
    const provider = await providerForWorkspace(ctx.workspaceId);
    const again = await rankAnswerSources(ctx, threadId, m.id, provider);
    expect(again.start).toEqual(ranking.start);
    expect((await getThread(ctx, threadId)).messages[1].ranking).toEqual(again);

    // A follow-up that only discusses the findings (no literature search) is not ranked, even when
    // it cites the same papers, and cannot be ranked on request either.
    await askFollowUp(ctx, threadId, { question: "Which of these should I read first?", mode: "chat" });
    const followUp = (await waitForRun(ctx, threadId)).messages[3];
    expect(followUp.content).toMatch(/\[P\d+\].*\[P\d+\].*\[P\d+\]/);
    expect(followUp.steps.map((s) => s.kind)).not.toContain("rank");
    expect(followUp.ranking).toBeNull();
    await expect(rankAnswerSources(ctx, threadId, followUp.id, provider)).rejects.toMatchObject({ status: 400 });
  });

  it("starts from selected papers", async () => {
    const [target] = (
      await discover(ctx.workspaceId, { q: "benchmarks", mode: "all", filters: {}, offset: 0, limit: 5 })
    ).items;
    const { threadId } = await createThread(ctx, {
      question: "Compare these papers",
      mode: "search",
      scope: { paperIds: [target.id] },
    });
    const thread = await waitForRun(ctx, threadId);
    expect(thread.scopePapers.map((p) => p.id)).toEqual([target.id]);
    expect(thread.messages[1].sources[0]).toMatchObject({ key: "P1", id: target.id });
  });

  it("keeps threads private to the workspace and recovers interrupted runs", async () => {
    const { threadId } = await createThread(ctx, { question: "Depth estimation datasets?", mode: "search" });
    await waitForRun(ctx, threadId);
    const stranger = await createUser("Stranger");
    await expect(getThread(stranger, threadId)).rejects.toMatchObject({ status: 404 });
    await expect(deleteThread(stranger, threadId)).rejects.toMatchObject({ status: 404 });

    // A run that stopped reporting progress (server restart) is marked as interrupted.
    const [orphan] = await db
      .insert(researchMessages)
      .values({ threadId, role: "assistant", status: "running", updatedAt: new Date(Date.now() - 10 * 60_000) })
      .returning();
    const t = await getThread(ctx, threadId);
    expect(t.messages.find((m) => m.id === orphan.id)).toMatchObject({ status: "error" });

    await cancelRun(ctx, threadId);
    await deleteThread(ctx, threadId);
    await expect(getThread(ctx, threadId)).rejects.toMatchObject({ status: 404 });
  });

  it("chats over the workspace without literature search", async () => {
    const { threadId } = await createThread(ctx, {
      question: "What do my notes say about monocular depth?",
      mode: "chat",
    });
    const t = await waitForRun(ctx, threadId);
    expect(t.messages[1].status).toBe("done");
    expect(t.messages[1].steps.map((s) => s.kind)).toEqual(["plan", "library", "workspace", "plan", "write"]);
  });

  it("proposes workspace changes, applies them on approval (with renames) and undoes them", async () => {
    const libraryCount = async () =>
      (await db.select().from(libraryItems).where(eq(libraryItems.workspaceId, ctx.workspaceId))).length;
    const before = await libraryCount();
    const { threadId } = await createThread(ctx, {
      question: "Organize papers into a collection: monocular depth estimation",
      mode: "search",
    });
    const t = await waitForRun(ctx, threadId);
    const m = t.messages[1];
    expect(m.status).toBe("done");
    expect(m.changes?.status).toBe("proposed");
    expect(m.changes?.items.map((c) => c.kind)).toEqual(["create_collection", "create_concept"]);
    // Replies that propose changes are not research results, so their sources are not ranked.
    expect(m.steps.map((s) => s.kind)).not.toContain("rank");
    expect(m.ranking).toBeNull();
    expect(m.changes?.items[0].label).toMatch(/^Create collection “Mock collection” with \d papers$/);
    expect(m.content).toContain("2 workspace changes listed");
    expect(await libraryCount()).toBe(before); // nothing changes until applied

    const [collectionChange, conceptChange] = m.changes!.items;
    const applied = await updateChanges(ctx, threadId, m.id, {
      action: "apply",
      names: { [collectionChange.id]: "Depth papers" },
    });
    expect(applied.items.map((c) => c.status)).toEqual(["applied", "applied"]);
    const [col] = await db
      .select()
      .from(collections)
      .where(and(eq(collections.workspaceId, ctx.workspaceId), eq(collections.name, "Depth papers")));
    expect(col).toBeDefined();
    expect(applied.items[1].result?.conceptId).toBeTruthy();
    expect(await libraryCount()).toBe(before + collectionChange.paperIds.length);
    await expect(updateChanges(ctx, threadId, m.id, { action: "apply" })).rejects.toMatchObject({ status: 409 });

    const undone = await updateChanges(ctx, threadId, m.id, { action: "undo" });
    expect(undone.status).toBe("undone");
    expect(await db.select().from(collections).where(eq(collections.id, col.id))).toHaveLength(0);
    expect(await db.select().from(concepts).where(eq(concepts.id, applied.items[1].result!.conceptId!))).toHaveLength(
      0,
    );
    expect(await libraryCount()).toBe(before);
    expect(conceptChange.paperIds.length).toBeGreaterThan(0);
  });

  it("auto-applies changes when asked, and reuses existing collections", async () => {
    const { threadId } = await createThread(ctx, {
      question: "Save papers into a collection: monocular depth estimation",
      mode: "search",
      autoApply: true,
    });
    const t = await waitForRun(ctx, threadId);
    const m = t.messages[1];
    expect(m.changes).toMatchObject({ status: "applied", autoApplied: true });
    expect(m.changes!.items.every((c) => c.status === "applied")).toBe(true);
    expect(m.content).toContain("2 workspace changes listed");

    // The collection now exists, so the same request becomes "add to collection".
    await askFollowUp(ctx, threadId, {
      question: "Organize them into a collection: monocular depth estimation",
      mode: "search",
    });
    const again = await waitForRun(ctx, threadId);
    expect(again.messages[3].changes?.items.map((c) => c.kind)).toEqual(["add_to_collection", "link_concept"]);
    await updateChanges(ctx, threadId, again.messages[3].id, { action: "dismiss" });
    await updateChanges(ctx, threadId, m.id, { action: "undo" });
  });
});

describe("concepts at two levels", () => {
  it("relates specific concepts to broader ones in any order, and undoes the relations", async () => {
    const ctx = await createUser("ConceptLevels");
    const [a, b] = await ingestPapers([
      paper({ title: "Point cloud registration for anatomy", ids: { s2: "lvl-1" } }),
      paper({ title: "Point cloud completion for hearts", ids: { s2: "lvl-2" } }),
    ]);
    const sources = new SourceRegistry();
    sources.add({ type: "paper", id: a, title: "A" });
    sources.add({ type: "paper", id: b, title: "B" });
    const items: ProposedChange[] = [];
    const propose = async (action: Parameters<typeof proposeChange>[1]) => {
      const { change } = await proposeChange(ctx.workspaceId, action, sources, items);
      const i = items.findIndex((c) => c.id === change!.id);
      if (i >= 0) items[i] = change!;
      else items.push(change!);
    };
    // The specific concept comes first and names its broader concept, which is proposed afterwards.
    await propose(
      changeActionSchema.parse({
        tool: "create_concept",
        name: "Point cloud shape registration",
        papers: ["P1"],
        related: ["Point cloud", "point cloud shape registration"],
      }),
    );
    await propose(changeActionSchema.parse({ tool: "create_concept", name: "Point cloud", papers: ["P1", "P2"] }));
    expect(items[0].related).toEqual(["Point cloud"]);
    expect(items[0].label).toContain("related to “Point cloud”");

    const applied = await applyChanges(ctx, items);
    const specific = applied[0].result!.conceptId!;
    const broad = applied[1].result!.conceptId!;
    expect(applied[0].result?.relatedPairs).toEqual([[specific, broad]]);
    expect((await getConceptDetail(ctx, broad)).related.map((r) => r.id)).toEqual([specific]);

    await undoChanges(ctx, applied);
    expect(await db.select().from(concepts).where(eq(concepts.workspaceId, ctx.workspaceId))).toHaveLength(0);
  });

  it("keeps the AI's priority and reason for concepts, the highest when proposed twice", async () => {
    const ctx = await createUser("ConceptPriority");
    const [a, b] = await ingestPapers([
      paper({ title: "MRI segmentation", ids: { s2: "pri-1" } }),
      paper({ title: "MRI registration", ids: { s2: "pri-2" } }),
    ]);
    const sources = new SourceRegistry();
    sources.add({ type: "paper", id: a, title: "A" });
    sources.add({ type: "paper", id: b, title: "B" });
    const first = await proposeChange(
      ctx.workspaceId,
      changeActionSchema.parse({ tool: "create_concept", name: "MRI", papers: ["P1"], priority: "Medium" }),
      sources,
      [],
    );
    expect(first.change).toMatchObject({ priority: "medium" });
    const merged = await proposeChange(
      ctx.workspaceId,
      changeActionSchema.parse({
        tool: "create_concept",
        name: "mri",
        papers: ["P2"],
        priority: "high",
        why: "Links both papers across collections",
      }),
      sources,
      [first.change!],
    );
    expect(merged.change).toMatchObject({
      id: first.change!.id,
      priority: "high",
      why: "Links both papers across collections",
      paperIds: [a, b],
    });
    // An unknown priority is ignored rather than rejecting the proposal.
    expect(
      changeActionSchema.parse({ tool: "create_concept", name: "CT", papers: ["P1"], priority: "essential" }),
    ).toMatchObject({ priority: undefined });
  });

  it("links an existing concept instead of creating a near-duplicate", async () => {
    const ctx = await createUser("ConceptDupes");
    const [a] = await ingestPapers([paper({ title: "Cardiac MRI", ids: { s2: "dup-1" } })]);
    await createConcept(ctx, { name: "MRI" });
    await createConcept(ctx, { name: "Point cloud" });
    const sources = new SourceRegistry();
    sources.add({ type: "paper", id: a, title: "A" });
    const propose = async (name: string) =>
      (
        await proposeChange(
          ctx.workspaceId,
          changeActionSchema.parse({ tool: "create_concept", name, papers: ["P1"] }),
          sources,
          [],
        )
      ).change!;
    expect(await propose("Magnetic resonance imaging")).toMatchObject({
      kind: "link_concept",
      name: "MRI",
      label: "Link your concept “MRI” to 1 paper (suggested as “Magnetic resonance imaging”)",
    });
    expect(await propose("point clouds")).toMatchObject({ kind: "link_concept", name: "Point cloud" });
    expect(await propose("Segmentation")).toMatchObject({ kind: "create_concept", name: "Segmentation" });
  });

  it("removes only the relation when the concepts already existed", async () => {
    const ctx = await createUser("ConceptLevels2");
    const [a] = await ingestPapers([paper({ title: "Mesh reconstruction", ids: { s2: "lvl-3" } })]);
    const broad = await createConcept(ctx, { name: "3D reconstruction" });
    const sources = new SourceRegistry();
    sources.add({ type: "paper", id: a, title: "A" });
    const { change } = await proposeChange(
      ctx.workspaceId,
      changeActionSchema.parse({
        tool: "create_concept",
        name: "Slice-to-mesh",
        papers: ["P1"],
        related: ["3D reconstruction"],
      }),
      sources,
      [],
    );
    const applied = await applyChanges(ctx, [change!]);
    expect((await getConceptDetail(ctx, broad.id)).related).toHaveLength(1);
    await undoChanges(ctx, applied);
    expect((await getConceptDetail(ctx, broad.id)).related).toHaveLength(0);
  });
});

describe("assistant in the reader", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let paperId: string;

  beforeAll(async () => {
    await installFakeScholarly(new FakeProvider("semantic_scholar", corpus));
    ctx = await createUser("ReaderUser");
    await saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "mock", model: "mock-1" });
    [paperId] = await ingestPapers([paper({ title: "Ordinal depth", ids: { s2: "reader-1" } })]);
    const file = await uploadPdf(
      ctx.workspaceId,
      ctx.userId,
      paperId,
      new File([makePdf("Ordinal depth ranking loss improves relative estimates")], "p.pdf", {
        type: "application/pdf",
      }),
    );
    await extractPdfText(file.id);
  });

  it("keeps the page and selection with the question, and lists the paper's reader conversations", async () => {
    const { threadId } = await createThread(ctx, {
      question: "What does this passage mean?",
      mode: "chat",
      origin: "reader",
      context: { paperId, page: 1, selection: "ranking loss" },
    });
    const t = await waitForRun(ctx, threadId);
    expect(t.origin).toBe("reader");
    expect(t.scope.paperIds).toEqual([paperId]);
    expect(t.messages[0].context).toEqual({ paperId, page: 1, selection: "ranking loss" });
    expect(t.messages[1].status).toBe("done");

    const listed = await listThreads(ctx, { origin: "reader", paperId });
    expect(listed.map((x) => x.id)).toEqual([threadId]);
    expect(await listThreads(ctx, { origin: "reader", paperId: corpusPaperId() })).toEqual([]);
  });

  it("tells the planner what is on screen", () => {
    const sources = new SourceRegistry();
    const prompt = roundPrompt(
      {
        question: "Explain this section",
        mode: "chat",
        history: [],
        scopeKeys: ["P1"],
        reader: { key: "P1", page: 4, totalPages: 12, pageText: "4.2 Ablation study…", selection: "the loss term" },
        findings: [],
        done: [],
        changes: [],
      },
      sources,
      1,
    );
    expect(prompt).toContain("The user is reading P1 in the PDF reader, on page 4 of 12");
    expect(prompt).toContain('<current_page number="4">\n4.2 Ablation study…');
    expect(prompt).toContain("<selection>\nthe loss term");
  });

  it("reads page ranges and opens playbooks", async () => {
    const sources = new SourceRegistry();
    sources.add({ type: "paper", id: paperId, title: "Ordinal depth" });
    const tool = { workspaceId: ctx.workspaceId, sources };
    const read = await toolFor({ tool: "read_paper", paper: "P1", pages: "1-3" }, sources).run(tool);
    expect(read.report).toContain("pages 1 of 1");
    expect(read.report).toContain("Ordinal depth ranking loss");
    await expect(toolFor({ tool: "read_paper", paper: "P1", pages: "5-6" }, sources).run(tool)).rejects.toThrow(
      /has 1 pages/,
    );

    const playbook = toolFor({ tool: "open_playbook", name: "Concepts" }, sources);
    expect(playbook.label).toBe("Opened the “Creating, linking and cleaning up concepts” playbook");
    expect((await playbook.run(tool)).report).toContain("list_concepts");
    await expect(toolFor({ tool: "open_playbook", name: "nope" }, sources).run(tool)).rejects.toThrow(/no playbook/);
  });
});

/** Any paper id that is not the reader paper (for the negative filter check). */
function corpusPaperId() {
  return "00000000-0000-4000-8000-000000000000";
}

describe("assistant workspace tools", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let a: string, b: string, c: string;
  let sources: SourceRegistry;
  const run = (action: Parameters<typeof toolFor>[0]) =>
    toolFor(action, sources).run({ workspaceId: ctx.workspaceId, sources });

  beforeAll(async () => {
    ctx = await createUser("ToolsUser");
    [a, b, c] = await ingestPapers([
      paper({ title: "Cardiac MRI segmentation", ids: { s2: "wt-1" }, year: 2023 }),
      paper({ title: "Brain MRI registration", ids: { s2: "wt-2" }, year: 2021 }),
      paper({ title: "Point cloud completion", ids: { s2: "wt-3" }, year: 2024 }),
    ]);
    for (const id of [a, b, c]) await savePaper(ctx.workspaceId, ctx.userId, id);
    const mri = await createConcept(ctx, { name: "MRI", description: "Magnetic resonance imaging" });
    await linkPaper(ctx, mri.id, a);
    await linkPaper(ctx, mri.id, b);
    const col = await createCollection(ctx.workspaceId, { name: "Thesis" });
    await addToCollection(ctx.workspaceId, ctx.userId, col.id, [a, c]);
    await tagPapers(ctx.workspaceId, ctx.userId, [a], { names: ["survey"] });
    await setStatus(ctx.workspaceId, [b], "read");
    await createNote(ctx, {
      title: "Reading log",
      paperId: a,
      content: textToDoc("Compare with the brain paper."),
    });
    sources = new SourceRegistry();
    for (const [id, title] of [
      [a, "Cardiac MRI segmentation"],
      [b, "Brain MRI registration"],
      [c, "Point cloud completion"],
    ]) {
      sources.add({ type: "paper", id, title });
    }
  });

  it("reads a concept with its papers, matching other names", async () => {
    const r = await run({ tool: "read_concept", concept: "magnetic resonance imaging" });
    expect(r.count).toBe(2);
    expect(r.report).toContain("Concept “MRI”");
    expect(r.report).toContain('P1: "Cardiac MRI segmentation"');
    expect(r.report).not.toContain("Abstract");
    expect((await run({ tool: "read_concept", concept: "Diffusion" })).report).toContain("There is no concept");
  });

  it("shows a paper's place in the workspace", async () => {
    const r = await run({ tool: "paper_info", paper: "P1" });
    expect(r.report).toContain("In the library: saved");
    expect(r.report).toContain('Collections: "Thesis"');
    expect(r.report).toContain("Tags: #survey");
    expect(r.report).toContain('Concepts: "MRI"');
    expect(r.report).toMatch(/Notes on it: N\d+ "Reading log"/);
  });

  it("finds saved papers by collection, concept and status", async () => {
    expect((await run({ tool: "find_saved_papers", collection: "thesis" })).count).toBe(2);
    expect((await run({ tool: "find_saved_papers", concept: "MRI", status: "read" })).report).toMatch(
      /: 1 in total.*\n- P2: Brain MRI registration/,
    );
    await expect(run({ tool: "find_saved_papers", tag: "missing" })).rejects.toThrow(/no tag/);
  });

  it("finds connected papers in the library", async () => {
    const r = await run({ tool: "related_in_library", paper: "P1" });
    expect(r.report).toMatch(/P2: Brain MRI registration \(2021\) — via concept “MRI”/);
    expect(r.report).toMatch(/P3: Point cloud completion \(2024\) — via collection “Thesis”/);
  });

  it("proposes, applies and undoes the new kinds of changes", async () => {
    const note = sources.add({ type: "note", id: (await listNotesFor(ctx, a))[0], title: "Reading log" });
    const items: ProposedChange[] = [];
    for (const action of [
      { tool: "set_reading_status", papers: ["P1", "P3"], status: "reading" },
      { tool: "remove_from_collection", collection: "Thesis", papers: ["P3", "P2"] },
      { tool: "unlink_concept", concept: "MRI", papers: ["P2"] },
      { tool: "relate_concepts", concept: "MRI", related: ["Imaging"] },
      { tool: "append_to_note", note: note.key, content: "Both use **MRI** [P2]." },
    ]) {
      const { change, message } = await proposeChange(
        ctx.workspaceId,
        changeActionSchema.parse(action),
        sources,
        items,
      );
      expect(change, message).toBeTruthy();
      items.push(change!);
    }
    await createConcept(ctx, { name: "Imaging" });
    expect(items.map((i) => i.label)).toEqual([
      "Mark 2 papers as reading",
      "Remove 1 paper from your collection “Thesis”",
      "Unlink 1 paper from your concept “MRI”",
      "Connect your concept “MRI” · related to “Imaging”",
      "Add to your note “Reading log”",
    ]);
    const applied = await applyChanges(ctx, items);
    expect(applied.map((i) => i.status)).toEqual(["applied", "applied", "applied", "applied", "applied"]);
    expect((await run({ tool: "find_saved_papers", status: "reading" })).count).toBe(2);
    expect((await run({ tool: "find_saved_papers", collection: "Thesis" })).count).toBe(1);
    expect((await run({ tool: "read_concept", concept: "MRI" })).report).toContain('Related concepts: "Imaging"');
    const text = JSON.stringify((await getNoteDetail(ctx, note.id)).content);
    expect(text).toContain("Compare with the brain paper.");
    expect(text).toContain("Both use ");

    const undone = await undoChanges(ctx, applied);
    expect(undone.every((i) => i.status === "undone")).toBe(true);
    expect((await run({ tool: "find_saved_papers", status: "saved" })).count).toBe(2);
    expect((await run({ tool: "find_saved_papers", collection: "Thesis" })).count).toBe(2);
    expect((await run({ tool: "read_concept", concept: "MRI" })).count).toBe(2);
    expect(JSON.stringify((await getNoteDetail(ctx, note.id)).content)).not.toContain("Both use ");
  });

  it("attaches an existing note to a paper and links it to others, then undoes it", async () => {
    const standalone = await createNote(ctx, { title: "Comparison of the three papers" });
    const note = sources.add({ type: "note", id: standalone.id, title: standalone.title });
    const p2 = sources.get("P2")!.id;
    const action = changeActionSchema.parse({
      tool: "link_note",
      note: note.key,
      paper: "P2",
      links: ["P1", "P3", "P2"],
    });
    const { change, message } = await proposeChange(ctx.workspaceId, action, sources, []);
    expect(change, message).toBeTruthy();
    expect(change!.label).toMatch(
      /^Attach your note “Comparison of the three papers” to “.+” and link it to 2 papers$/,
    );

    const [applied] = await applyChanges(ctx, [change!]);
    expect(applied.status).toBe("applied");
    const detail = await getNoteDetail(ctx, standalone.id);
    expect(detail.paper?.id).toBe(p2);
    const links = await db.select().from(noteLinks).where(eq(noteLinks.noteId, standalone.id));
    expect(links.map((l) => l.targetPaperId).sort()).toEqual([sources.get("P1")!.id, sources.get("P3")!.id].sort());

    // Asking again changes nothing, so nothing is proposed.
    expect((await proposeChange(ctx.workspaceId, action, sources, [])).change).toBeUndefined();

    const [undone] = await undoChanges(ctx, [applied]);
    expect(undone.status).toBe("undone");
    const after = await getNoteDetail(ctx, standalone.id);
    expect(after.paper).toBeNull();
    expect(await db.select().from(noteLinks).where(eq(noteLinks.noteId, standalone.id))).toEqual([]);
  });
});

async function listNotesFor(ctx: { workspaceId: string }, paperId: string) {
  const rows = await db.select({ id: notes.id }).from(notes).where(eq(notes.paperId, paperId));
  return rows.map((r) => r.id).filter(Boolean) as string[];
}

describe("applying proposed changes concurrently", () => {
  it("applies a proposal once when two approvals arrive together", async () => {
    const ctx = await createUser("Proposal owner");
    const [thread] = await db
      .insert(researchThreads)
      .values({ workspaceId: ctx.workspaceId, createdBy: ctx.userId, title: "Concurrent approval" })
      .returning();
    const proposal: ProposedChange = {
      id: "p-1",
      kind: "create_note",
      label: "Create note",
      name: "Approved once",
      paperIds: [],
      status: "proposed",
    };
    const [message] = await db
      .insert(researchMessages)
      .values({
        threadId: thread.id,
        role: "assistant",
        status: "done",
        changes: { status: "proposed", autoApplied: false, items: [proposal] },
      })
      .returning();
    const outcomes = await Promise.allSettled([
      updateChanges(ctx, thread.id, message.id, { action: "apply" }),
      updateChanges(ctx, thread.id, message.id, { action: "apply" }),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const created = await db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.workspaceId, ctx.workspaceId), eq(notes.title, "Approved once")));
    expect(created).toHaveLength(1);
  });
});

describe("saving an answer as a note", () => {
  async function answer(ctx: Awaited<ReturnType<typeof createUser>>, content: string, sources: ResearchSource[]) {
    const [thread] = await db
      .insert(researchThreads)
      .values({ workspaceId: ctx.workspaceId, createdBy: ctx.userId, title: "Summarize" })
      .returning();
    await db
      .insert(researchMessages)
      .values({ threadId: thread.id, role: "user", status: "done", content: "Summarize it" });
    const [message] = await db
      .insert(researchMessages)
      .values({ threadId: thread.id, role: "assistant", status: "done", content, sources })
      .returning();
    return { threadId: thread.id, messageId: message.id };
  }

  it("files an answer about one paper under that paper, and a broader answer on its own", async () => {
    const ctx = await createUser("Note saver");
    const [a, b] = await ingestPapers([
      paper({ title: "Hierarchical world models for planning", ids: { s2: "note-save-a" } }),
      paper({ title: "Latent predictive architectures", ids: { s2: "note-save-b" } }),
    ]);
    const src = (key: string, id: string): ResearchSource => ({ key, type: "paper", id, title: key });

    const one = await answer(ctx, "It learns a hierarchy of world models [P1].", [src("P1", a)]);
    const saved = await saveAnswerAsNote(ctx, one.threadId, one.messageId);
    expect(saved).toMatchObject({ paperId: a, paperTitle: "Hierarchical world models for planning" });
    expect((await getNoteDetail(ctx, saved.noteId)).paper?.id).toBe(a);

    const two = await answer(ctx, "Both predict in latent space [P1][P2].", [src("P1", a), src("P2", b)]);
    const broad = await saveAnswerAsNote(ctx, two.threadId, two.messageId);
    expect(broad.paperId).toBeNull();
    const links = await db.select().from(noteLinks).where(eq(noteLinks.noteId, broad.noteId));
    expect(links.map((l) => l.targetPaperId).sort()).toEqual([a, b].sort());
  });
});
