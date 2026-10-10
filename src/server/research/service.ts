/**
 * Research threads: a conversation with the research agent. Runs happen in the background of the
 * web process and persist their progress (steps, sources, streamed answer) to the database, so the
 * page can be closed and reopened while research continues.
 */
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { markdownToDoc } from "@/lib/markdown-doc";
import type {
  AiChoice,
  ChangeSet,
  PaperSummary,
  ProposedChange,
  ResearchMessageDto,
  ResearchMode,
  ResearchScope,
  ResearchSource,
  ResearchStatus,
  ResearchStep,
  ResearchStepKind,
  ResearchThreadDto,
  ResearchThreadSummary,
  ReaderContext,
  ResearchOrigin,
  SourceRanking,
} from "@/lib/types";
import { providerForWorkspace } from "@/server/ai/config";
import { loadPaperText } from "@/server/ai/paper-text";
import { AIError, type AIProvider } from "@/server/ai/types";
import { db } from "@/server/db/client";
import { collections, researchMessages, researchThreads } from "@/server/db/schema";
import { badRequest, conflict, notFound, type RequestContext } from "@/server/http";
import { createNote } from "@/server/knowledge/notes";
import { collectionPaperIds, getOwnedCollection } from "@/server/library/organize";
import { getPaperSummaries, getVisiblePaper } from "@/server/papers/service";
import { citedKeys, runResearchLoop, type ResearchSink, type Turn } from "./agent";
import { applyChanges, undoChanges } from "./changes";
import { citedPapers, LITERATURE_STEP_KINDS, MIN_RANKED_PAPERS, rankCitedSources } from "./ranking";
import { SourceRegistry } from "./tools";

type ThreadRow = typeof researchThreads.$inferSelect;
type MessageRow = typeof researchMessages.$inferSelect;

const MAX_SCOPE_PAPERS = 30;
/** Characters of the page on screen given to the model with a question from the reader. */
const READER_PAGE_CHARS = 8000;
/** A run that has not written anything for this long (e.g. the server restarted) is stale. */
const STALE_AFTER_MS = 120_000;
const HEARTBEAT_MS = 20_000;
const FLUSH_MS = 600;
const MAX_RUN_MS = 30 * 60_000;
const MAX_CONCURRENT_RUNS_PER_USER = 2;

/** Runs in this process, by assistant message id (kept on globalThis to survive dev reloads). */
const g = globalThis as unknown as { __pwResearchRuns?: Map<string, { controller: AbortController; userId: string }> };
const runs = (g.__pwResearchRuns ??= new Map());

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function toMessageDto(m: MessageRow): ResearchMessageDto {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    mode: m.mode,
    status: m.status,
    error: m.error,
    steps: m.steps,
    sources: m.sources,
    changes: m.changes,
    ranking: m.ranking,
    context: m.context,
    provider: m.provider,
    model: m.model,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

async function ownedThread(workspaceId: string, threadId: string): Promise<ThreadRow> {
  const [row] = await db
    .select()
    .from(researchThreads)
    .where(and(eq(researchThreads.id, threadId), eq(researchThreads.workspaceId, workspaceId)));
  if (!row) throw notFound("Research");
  return row;
}

/** Marks runs that stopped without finishing (e.g. the server restarted) as interrupted. */
async function expireStaleRuns(threadIds: string[]) {
  if (!threadIds.length) return;
  const stale = await db
    .select({ id: researchMessages.id })
    .from(researchMessages)
    .where(
      and(
        inArray(researchMessages.threadId, threadIds),
        eq(researchMessages.status, "running"),
        lt(researchMessages.updatedAt, new Date(Date.now() - STALE_AFTER_MS)),
      ),
    );
  const ids = stale.map((s) => s.id).filter((id) => !runs.has(id));
  if (!ids.length) return;
  await db
    .update(researchMessages)
    .set({ status: "error", error: "This research was interrupted (the server restarted). Ask again to retry." })
    .where(and(inArray(researchMessages.id, ids), eq(researchMessages.status, "running")));
}

/** Conversations, newest first; `filter` narrows them, e.g. to the reader conversations about a paper. */
export async function listThreads(
  ctx: RequestContext,
  filter: { origin?: ResearchOrigin; paperId?: string } = {},
): Promise<ResearchThreadSummary[]> {
  const query = () =>
    db
      .select({
        id: researchThreads.id,
        title: researchThreads.title,
        origin: researchThreads.origin,
        updatedAt: researchThreads.updatedAt,
        status: sql<ResearchStatus | null>`(
        select m.status from research_messages m
        where m.thread_id = ${researchThreads.id} and m.role = 'assistant'
        order by m.created_at desc limit 1)`,
      })
      .from(researchThreads)
      .where(
        and(
          eq(researchThreads.workspaceId, ctx.workspaceId),
          filter.origin ? eq(researchThreads.origin, filter.origin) : undefined,
          filter.paperId ? sql`jsonb_exists(${researchThreads.scope}->'paperIds', ${filter.paperId})` : undefined,
        ),
      )
      .orderBy(desc(researchThreads.updatedAt))
      .limit(200);
  let rows = await query();
  const running = rows.filter((r) => r.status === "running").map((r) => r.id);
  if (running.length) {
    await expireStaleRuns(running);
    rows = await query();
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    origin: r.origin,
    status: r.status ?? "done",
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function getThread(ctx: RequestContext, threadId: string): Promise<ResearchThreadDto> {
  const thread = await ownedThread(ctx.workspaceId, threadId);
  await expireStaleRuns([thread.id]);
  const messages = await db
    .select()
    .from(researchMessages)
    .where(eq(researchMessages.threadId, thread.id))
    .orderBy(asc(researchMessages.createdAt));
  const paperIds = new Set(thread.scope.paperIds);
  for (const m of messages) for (const s of m.sources) if (s.type === "paper") paperIds.add(s.id);
  const summaries = await getPaperSummaries(ctx.workspaceId, [...paperIds]);
  const papers: Record<string, PaperSummary> = {};
  for (const p of summaries) papers[p.id] = p;
  let scopeCollection: ResearchThreadDto["scopeCollection"] = null;
  if (thread.scope.collectionId) {
    const [c] = await db
      .select({ id: collections.id, name: collections.name })
      .from(collections)
      .where(and(eq(collections.id, thread.scope.collectionId), eq(collections.workspaceId, ctx.workspaceId)));
    scopeCollection = c ?? null;
  }
  return {
    id: thread.id,
    title: thread.title,
    origin: thread.origin,
    scope: thread.scope,
    scopePapers: thread.scope.paperIds.map((id) => papers[id]).filter(Boolean),
    scopeCollection,
    messages: messages.map(toMessageDto),
    papers,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Starting research
// ---------------------------------------------------------------------------

async function validateScope(ctx: RequestContext, scope: Partial<ResearchScope> | undefined): Promise<ResearchScope> {
  const paperIds = [...new Set(scope?.paperIds ?? [])].slice(0, MAX_SCOPE_PAPERS);
  if (paperIds.length) {
    const visible = await getPaperSummaries(ctx.workspaceId, paperIds);
    if (visible.length !== paperIds.length) throw badRequest("Some of the selected papers could not be found.");
  }
  const collectionId = scope?.collectionId ?? null;
  if (collectionId) await getOwnedCollection(ctx.workspaceId, collectionId);
  return { paperIds, collectionId };
}

function titleFrom(question: string) {
  const t = question.replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 87).trimEnd()}…` : t;
}

export async function createThread(
  ctx: RequestContext,
  input: {
    question: string;
    mode: ResearchMode;
    scope?: Partial<ResearchScope>;
    choice?: AiChoice | null;
    autoApply?: boolean;
    /** "reader": started from the PDF reader about the paper in `context`. */
    origin?: ResearchOrigin;
    context?: ReaderContext | null;
  },
): Promise<{ threadId: string; messageId: string }> {
  const provider = await providerForWorkspace(ctx.workspaceId, input.choice);
  assertCanStart(ctx);
  const origin = input.origin ?? "assistant";
  const scope = await validateScope(ctx, {
    ...input.scope,
    // A reader conversation is about the paper being read.
    paperIds: input.context ? [input.context.paperId, ...(input.scope?.paperIds ?? [])] : input.scope?.paperIds,
  });
  const [thread] = await db
    .insert(researchThreads)
    .values({ workspaceId: ctx.workspaceId, createdBy: ctx.userId, title: titleFrom(input.question), scope, origin })
    .returning();
  const messageId = await startRun(ctx, thread, provider, {
    question: input.question,
    mode: input.mode,
    autoApply: !!input.autoApply,
    context: input.context ?? null,
  });
  return { threadId: thread.id, messageId };
}

export async function askFollowUp(
  ctx: RequestContext,
  threadId: string,
  input: {
    question: string;
    mode: ResearchMode;
    choice?: AiChoice | null;
    autoApply?: boolean;
    context?: ReaderContext | null;
  },
): Promise<{ messageId: string }> {
  const thread = await ownedThread(ctx.workspaceId, threadId);
  await expireStaleRuns([thread.id]);
  const [busy] = await db
    .select({ id: researchMessages.id })
    .from(researchMessages)
    .where(and(eq(researchMessages.threadId, thread.id), eq(researchMessages.status, "running")))
    .limit(1);
  if (busy) throw conflict("This research is still running. Wait for it to finish or stop it first.");
  const provider = await providerForWorkspace(ctx.workspaceId, input.choice);
  assertCanStart(ctx);
  if (input.context) await getPaperSummaries(ctx.workspaceId, [input.context.paperId]).then(assertVisible);
  return {
    messageId: await startRun(ctx, thread, provider, {
      question: input.question,
      mode: input.mode,
      autoApply: !!input.autoApply,
      context: input.context ?? null,
    }),
  };
}

function assertCanStart(ctx: RequestContext) {
  const mine = [...runs.values()].filter((r) => r.userId === ctx.userId).length;
  if (mine >= MAX_CONCURRENT_RUNS_PER_USER) {
    throw conflict(`You already have ${mine} research runs in progress. Wait for one to finish or stop it.`);
  }
}

function assertVisible(papers: PaperSummary[]) {
  if (!papers.length) throw badRequest("The paper being read could not be found.");
}

interface RunInput {
  question: string;
  mode: ResearchMode;
  autoApply: boolean;
  context: ReaderContext | null;
}

async function startRun(
  ctx: RequestContext,
  thread: ThreadRow,
  provider: AIProvider,
  input: RunInput,
): Promise<string> {
  const { question, mode } = input;
  const now = Date.now();
  await db.insert(researchMessages).values({
    threadId: thread.id,
    role: "user",
    content: question,
    mode,
    context: input.context,
    status: "done",
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  const [assistant] = await db
    .insert(researchMessages)
    .values({
      threadId: thread.id,
      role: "assistant",
      mode,
      status: "running",
      provider: provider.kind,
      model: provider.model || null,
      createdAt: new Date(now + 1),
      updatedAt: new Date(now + 1),
    })
    .returning();
  await db.update(researchThreads).set({ updatedAt: new Date() }).where(eq(researchThreads.id, thread.id));

  const controller = new AbortController();
  runs.set(assistant.id, { controller, userId: ctx.userId });
  void execute(ctx, thread, assistant.id, provider, input, controller).finally(() => runs.delete(assistant.id));
  return assistant.id;
}

/** Collects progress in memory and writes it to the message row at most every FLUSH_MS. */
class PersistingSink implements ResearchSink {
  steps: ResearchStep[] = [];
  content = "";
  ranking: SourceRanking | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private seq = 0;

  private changeItems: ProposedChange[] = [];

  constructor(
    private readonly messageId: string,
    private readonly sources: SourceRegistry,
    private readonly autoApply: boolean,
  ) {}

  get hasChanges() {
    return this.changeItems.length > 0;
  }

  changes(items: ProposedChange[]) {
    this.changeItems = items.map((c) => ({ ...c }));
    this.schedule();
  }

  private changeSet(): ChangeSet | null {
    if (!this.changeItems.length) return null;
    const applied = this.changeItems.some((c) => c.status !== "proposed");
    return {
      status: applied ? "applied" : "proposed",
      autoApplied: applied && this.autoApply,
      items: this.changeItems,
    };
  }

  step(kind: ResearchStepKind, label: string, detail?: string) {
    const id = `s${++this.seq}`;
    this.steps.push({ id, kind, label, detail, status: "running", at: new Date().toISOString() });
    this.schedule();
    return id;
  }

  finish(id: string, patch: { status: "done" | "error"; count?: number; detail?: string }) {
    const s = this.steps.find((x) => x.id === id);
    if (s) Object.assign(s, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    this.schedule();
  }

  text(full: string) {
    this.content = full;
    this.schedule();
  }

  private schedule() {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
  }

  /** Writes the current progress (only while the message is still running). */
  flush(final?: { status: ResearchStatus; error?: string | null }): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const values = {
      steps: this.steps.map((s) => ({ ...s })),
      sources: this.sources.all(),
      content: this.content,
      changes: this.changeSet(),
      ...(this.ranking ? { ranking: this.ranking } : {}),
      updatedAt: new Date(),
      ...(final ? { status: final.status, error: final.error ?? null } : {}),
    };
    this.writing = this.writing
      .then(() =>
        db
          .update(researchMessages)
          .set(values)
          .where(and(eq(researchMessages.id, this.messageId), eq(researchMessages.status, "running"))),
      )
      .then(
        () => undefined,
        (err) => console.error("[research] could not save progress", err),
      );
    return this.writing;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof AIError) return err.message;
  if (err instanceof Error && err.name === "TimeoutError") return "The research took too long and was stopped.";
  console.error("[research] run failed", err);
  return "The research failed unexpectedly.";
}

const LITERATURE_STEPS = new Set<ResearchStepKind>(LITERATURE_STEP_KINDS);

/**
 * Ranks the reply's cited papers (reading order and priority) as a visible step. A failure only loses
 * the ranking: the reply is kept and its sources fall back to citation counts.
 */
async function rankForSink(
  provider: AIProvider,
  sink: PersistingSink,
  input: { question: string; content: string; sources: ResearchSource[]; signal: AbortSignal },
) {
  // Only research results are ranked: replies that searched the literature this turn. Follow-ups that
  // only discuss earlier findings, and replies proposing changes (collections, concepts…), are not.
  if (!sink.steps.some((s) => LITERATURE_STEPS.has(s.kind)) || sink.hasChanges) return;
  if (citedPapers(input.content, input.sources).length < MIN_RANKED_PAPERS) return;
  const id = sink.step("rank", "Ranking the sources");
  try {
    sink.ranking = await rankCitedSources(provider, input);
    sink.finish(id, {
      status: sink.ranking ? "done" : "error",
      detail: sink.ranking ? undefined : "No usable ranking",
    });
  } catch (err) {
    if (input.signal.aborted) throw err;
    console.error("[research] ranking failed", err);
    sink.finish(id, { status: "error", detail: "Ranking failed; sources are ordered by citations instead" });
  }
}

/** What the model is told about the reader: the paper's key, the page on screen with its text, the selection. */
async function readerState(ctx: RequestContext, sources: SourceRegistry, context: ReaderContext) {
  const [paper] = await getPaperSummaries(ctx.workspaceId, [context.paperId]);
  if (!paper) return undefined;
  const text = context.page ? await loadPaperText(ctx.workspaceId, paper.id).catch(() => null) : null;
  const pageText = text?.parts.find((p) => p.n === context.page)?.text.trim() ?? null;
  return {
    key: sources.addPaper(paper).key,
    page: context.page ?? null,
    totalPages: text?.parts.at(-1)?.n ?? null,
    pageText: pageText && pageText.length > READER_PAGE_CHARS ? `${pageText.slice(0, READER_PAGE_CHARS)}…` : pageText,
    selection: context.selection?.trim().slice(0, 4000) || null,
  };
}

async function execute(
  ctx: RequestContext,
  thread: ThreadRow,
  messageId: string,
  provider: AIProvider,
  input: RunInput,
  controller: AbortController,
) {
  const { question, mode, autoApply } = input;
  // Earlier turns: their answers become conversation context and their sources keep their keys.
  const previous = await db
    .select()
    .from(researchMessages)
    .where(eq(researchMessages.threadId, thread.id))
    .orderBy(asc(researchMessages.createdAt));
  const history: Turn[] = [];
  let priorSources: ResearchSource[] = [];
  for (let i = 0; i < previous.length; i++) {
    const m = previous[i];
    if (m.id === messageId) break;
    if (m.role === "assistant") {
      if (m.sources.length >= priorSources.length) priorSources = m.sources;
      const q = previous[i - 1]?.role === "user" ? previous[i - 1].content : "";
      if (m.status === "done" && m.content) history.push({ question: q, answer: m.content });
    }
  }
  const sources = new SourceRegistry(priorSources);
  const scopeIds = [...thread.scope.paperIds];
  if (thread.scope.collectionId) scopeIds.push(...(await collectionPaperIds(thread.scope.collectionId)));
  const scopePapers = await getPaperSummaries(ctx.workspaceId, [...new Set(scopeIds)].slice(0, MAX_SCOPE_PAPERS));
  const scopeKeys = scopePapers.map((p) => sources.addPaper(p).key);
  const reader = input.context ? await readerState(ctx, sources, input.context) : undefined;

  const sink = new PersistingSink(messageId, sources, autoApply);
  const heartbeat = setInterval(() => void sink.flush(), HEARTBEAT_MS);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(MAX_RUN_MS)]);
  try {
    const answer = await runResearchLoop({
      provider,
      ctx: { workspaceId: ctx.workspaceId, sources },
      state: { question, mode, history, scopeKeys, reader, findings: [], done: [], changes: [] },
      sink,
      signal,
      // With auto-apply, changes are made before the reply is written, so it can report what happened.
      // Concepts the AI ranked low are optional: auto-apply skips them, as the card leaves them unticked.
      beforeWrite: autoApply
        ? (items) =>
            applyChanges(
              ctx,
              items.map((c) => (c.priority === "low" ? { ...c, status: "skipped" as const } : c)),
            )
        : undefined,
    });
    sink.content = answer;
    await rankForSink(provider, sink, { question, content: answer, sources: sources.all(), signal });
    await sink.flush({ status: "done" });
  } catch (err) {
    if (controller.signal.aborted) {
      await sink.flush({ status: "cancelled", error: null });
    } else {
      await sink.flush({ status: "error", error: errorMessage(err) });
    }
  } finally {
    clearInterval(heartbeat);
    await db.update(researchThreads).set({ updatedAt: new Date() }).where(eq(researchThreads.id, thread.id));
  }
}

// ---------------------------------------------------------------------------
// Managing threads
// ---------------------------------------------------------------------------

export async function cancelRun(ctx: RequestContext, threadId: string) {
  const thread = await ownedThread(ctx.workspaceId, threadId);
  const running = await db
    .select({ id: researchMessages.id })
    .from(researchMessages)
    .where(and(eq(researchMessages.threadId, thread.id), eq(researchMessages.status, "running")));
  for (const { id } of running) runs.get(id)?.controller.abort();
  if (running.length) {
    await db
      .update(researchMessages)
      .set({ status: "cancelled" })
      .where(
        and(
          inArray(
            researchMessages.id,
            running.map((r) => r.id),
          ),
          eq(researchMessages.status, "running"),
        ),
      );
  }
}

export async function renameThread(ctx: RequestContext, threadId: string, title: string) {
  const thread = await ownedThread(ctx.workspaceId, threadId);
  await db
    .update(researchThreads)
    .set({ title: title.trim().slice(0, 200) || thread.title })
    .where(eq(researchThreads.id, thread.id));
}

export async function deleteThread(ctx: RequestContext, threadId: string) {
  const thread = await ownedThread(ctx.workspaceId, threadId);
  await cancelRun(ctx, thread.id);
  await db.delete(researchThreads).where(eq(researchThreads.id, thread.id));
}

/** Saves an answer as a note; its citations become links to the cited papers and notes. */
export async function saveAnswerAsNote(ctx: RequestContext, threadId: string, messageId: string) {
  const thread = await ownedThread(ctx.workspaceId, threadId);
  const [message] = await db
    .select()
    .from(researchMessages)
    .where(and(eq(researchMessages.id, messageId), eq(researchMessages.threadId, thread.id)));
  if (!message || message.role !== "assistant") throw notFound("Answer");
  if (message.status !== "done" || !message.content.trim()) throw badRequest("Only finished answers can be saved.");
  const byKey = new Map(message.sources.map((s) => [s.key, s]));
  const label = (s: ResearchSource) => (s.title.length > 80 ? `${s.title.slice(0, 77)}…` : s.title);
  const doc = markdownToDoc(message.content, (k) => {
    const s = byKey.get(k);
    return s ? { type: s.type, id: s.id, label: label(s) } : undefined;
  });
  // A "Sources" section lists every cited source as a link.
  const cited = citedKeys(message.content)
    .map((k) => byKey.get(k))
    .filter((s): s is ResearchSource => !!s);
  if (cited.length) {
    doc.content!.push(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Sources" }] },
      {
        type: "bulletList",
        content: cited.map((s) => ({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "mention", attrs: { id: `${s.type}:${s.id}`, label: label(s) } },
                ...(s.type === "paper" && (s.authors || s.year)
                  ? [{ type: "text", text: ` — ${[s.authors, s.year].filter(Boolean).join(", ")}` }]
                  : []),
              ],
            },
          ],
        })),
      },
    );
  }
  const userTurn = await db
    .select({ content: researchMessages.content, context: researchMessages.context })
    .from(researchMessages)
    .where(
      and(
        eq(researchMessages.threadId, thread.id),
        eq(researchMessages.role, "user"),
        lt(researchMessages.createdAt, message.createdAt),
      ),
    )
    .orderBy(desc(researchMessages.createdAt))
    .limit(1);
  const title = titleFrom(userTurn[0]?.content || thread.title);
  // An answer about one paper (the reader's chat, or a single cited paper) becomes a note on that paper,
  // listed with its own notes; otherwise the note stands alone and links to every source.
  const citedPapers = [...new Set(cited.filter((s) => s.type === "paper").map((s) => s.id))];
  const readerPaper = thread.origin === "reader" ? userTurn[0]?.context?.paperId : null;
  const about = readerPaper ?? (citedPapers.length === 1 ? citedPapers[0] : null);
  const paper = about ? await getVisiblePaper(ctx.workspaceId, about).catch(() => null) : null;
  const note = await createNote(ctx, {
    title: `Research: ${title}`.slice(0, 300),
    content: doc,
    paperId: paper?.id ?? null,
  });
  return { noteId: note.id, paperId: paper?.id ?? null, paperTitle: paper?.title ?? null };
}

/** Ranks (or re-ranks) the cited sources of a finished answer with the AI, and stores the ranking. */
export async function rankAnswerSources(
  ctx: RequestContext,
  threadId: string,
  messageId: string,
  provider: AIProvider,
): Promise<SourceRanking> {
  const thread = await ownedThread(ctx.workspaceId, threadId);
  const [message] = await db
    .select()
    .from(researchMessages)
    .where(and(eq(researchMessages.id, messageId), eq(researchMessages.threadId, thread.id)));
  if (!message || message.role !== "assistant") throw notFound("Answer");
  if (message.status !== "done" || !message.content.trim()) throw badRequest("Only finished answers can be ranked.");
  if (!message.steps.some((s) => LITERATURE_STEPS.has(s.kind)) || message.changes) {
    throw badRequest("Only research results (answers that searched the literature) are ranked.");
  }
  if (citedPapers(message.content, message.sources).length < MIN_RANKED_PAPERS) {
    throw badRequest(`Ranking needs an answer that cites at least ${MIN_RANKED_PAPERS} papers.`);
  }
  const [userTurn] = await db
    .select({ content: researchMessages.content, context: researchMessages.context })
    .from(researchMessages)
    .where(
      and(
        eq(researchMessages.threadId, thread.id),
        eq(researchMessages.role, "user"),
        lt(researchMessages.createdAt, message.createdAt),
      ),
    )
    .orderBy(desc(researchMessages.createdAt))
    .limit(1);
  const ranking = await rankCitedSources(provider, {
    question: userTurn?.content ?? thread.title,
    content: message.content,
    sources: message.sources,
  });
  if (!ranking) throw new AIError("unavailable", "The AI did not return a usable ranking. Try again.");
  await db.update(researchMessages).set({ ranking }).where(eq(researchMessages.id, message.id));
  return ranking;
}

/**
 * Applies, undoes or dismisses the workspace changes an answer proposed. When applying, `itemIds`
 * selects which proposals to apply (the rest are skipped) and `names` can rename collections,
 * concepts or notes first.
 */
export async function updateChanges(
  ctx: RequestContext,
  threadId: string,
  messageId: string,
  input: { action: "apply" | "undo" | "dismiss"; itemIds?: string[]; names?: Record<string, string> },
): Promise<ChangeSet> {
  const thread = await ownedThread(ctx.workspaceId, threadId);
  // One request at a time per message: two simultaneous approvals would otherwise both see
  // "proposed" and apply everything twice. The status is read again after taking the lock.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"paperweave:changes:" + messageId}))`);
    const [message] = await tx
      .select()
      .from(researchMessages)
      .where(and(eq(researchMessages.id, messageId), eq(researchMessages.threadId, thread.id)));
    if (!message?.changes) throw notFound("Changes");
    if (message.status === "running") throw conflict("Wait for the answer to finish first.");
    const set = message.changes;
    let next: ChangeSet;
    if (input.action === "apply") {
      if (set.status !== "proposed") throw conflict("These changes were already handled.");
      const selected = new Set(input.itemIds ?? set.items.map((c) => c.id));
      // Concepts renamed before applying: "related" lists that mention the old name follow the rename.
      const renames = new Map<string, string>();
      for (const c of set.items) {
        const renamed = input.names?.[c.id]?.trim();
        if (renamed && c.name && (c.kind === "create_concept" || c.kind === "link_concept")) {
          renames.set(c.name.toLowerCase(), renamed.slice(0, 300));
        }
      }
      const prepared = set.items.map((c): ProposedChange => {
        if (!selected.has(c.id)) return { ...c, status: "skipped" };
        const renamed = input.names?.[c.id]?.trim();
        const related = c.related?.map((r) => renames.get(r.toLowerCase()) ?? r);
        const next = related ? { ...c, related } : c;
        return renamed && c.kind !== "save_papers" && c.kind !== "tag_papers"
          ? { ...next, name: renamed.slice(0, 300) }
          : next;
      });
      next = { status: "applied", autoApplied: false, items: await applyChanges(ctx, prepared) };
    } else if (input.action === "undo") {
      if (set.status !== "applied") throw conflict("There is nothing to undo.");
      next = { ...set, status: "undone", items: await undoChanges(ctx, set.items) };
    } else {
      if (set.status !== "proposed") throw conflict("These changes were already handled.");
      next = { ...set, status: "dismissed", items: set.items.map((c) => ({ ...c, status: "skipped" as const })) };
    }
    await tx.update(researchMessages).set({ changes: next }).where(eq(researchMessages.id, message.id));
    return next;
  });
}
