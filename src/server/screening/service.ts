/**
 * Systematic screening: deciding, paper by paper, whether each of a set of papers meets the user's
 * inclusion / exclusion criteria. A background job works through the papers a few at a time (resumable,
 * pausable); every AI decision carries a reason and the passage it rests on, and the user can override
 * any decision.
 */
import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { PaperSummary, ScreeningDecision, ScreeningDetail, ScreeningItemDto, ScreeningSummary } from "@/lib/types";
import { providerForWorkspace } from "@/server/ai/config";
import { loadPaperText, relevantParts } from "@/server/ai/paper-text";
import { AIError, complete } from "@/server/ai/types";
import { db } from "@/server/db/client";
import { screeningItems, screenings } from "@/server/db/schema";
import { badRequest, notFound, type RequestContext } from "@/server/http";
import { enqueueJob } from "@/server/jobs/queue";
import { addToCollection, createCollection } from "@/server/library/organize";
import { getPaperSummaries, getVisiblePaper } from "@/server/papers/service";

export const MAX_SCREENED = 500;
const BATCH = 5;

type ScreeningRow = typeof screenings.$inferSelect;

async function ownedScreening(workspaceId: string, id: string): Promise<ScreeningRow> {
  const [row] = await db
    .select()
    .from(screenings)
    .where(and(eq(screenings.id, id), eq(screenings.workspaceId, workspaceId)));
  if (!row) throw notFound("Screening");
  return row;
}

async function queueNext(s: { id: string; workspaceId: string }, pending: number) {
  // The key changes as papers are decided, so a batch can queue the next one while it is still running.
  await enqueueJob({
    type: "screen_papers",
    payload: { screeningId: s.id },
    workspaceId: s.workspaceId,
    dedupeKey: `screen_papers:${s.id}:${pending}`,
  });
}

async function pendingCount(screeningId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(screeningItems)
    .where(and(eq(screeningItems.screeningId, screeningId), eq(screeningItems.decision, "pending")));
  return row?.n ?? 0;
}

export async function createScreening(
  ctx: RequestContext,
  input: { title: string; criteria: string; paperIds: string[]; useFullText?: boolean },
): Promise<{ id: string; papers: number }> {
  const paperIds = [...new Set(input.paperIds)];
  if (!paperIds.length) throw badRequest("Choose at least one paper to screen.");
  if (paperIds.length > MAX_SCREENED) throw badRequest(`A screening can include at most ${MAX_SCREENED} papers.`);
  for (const id of paperIds) await getVisiblePaper(ctx.workspaceId, id);
  // AI must be set up before work is queued for it.
  await providerForWorkspace(ctx.workspaceId);
  const [row] = await db
    .insert(screenings)
    .values({
      workspaceId: ctx.workspaceId,
      title: input.title.trim().slice(0, 200) || "Screening",
      criteria: input.criteria.trim(),
      useFullText: !!input.useFullText,
      createdBy: ctx.userId,
    })
    .returning();
  for (let i = 0; i < paperIds.length; i += 200) {
    await db
      .insert(screeningItems)
      .values(paperIds.slice(i, i + 200).map((paperId) => ({ screeningId: row.id, paperId })));
  }
  await queueNext(row, paperIds.length);
  return { id: row.id, papers: paperIds.length };
}

const SCREEN_SYSTEM = `You screen scientific papers for a systematic review. Decide strictly from the criteria and the paper text given. Reply with a single JSON object and nothing else.`;

/** Reads the model's decision; anything unusable becomes "maybe" so a person looks at it. */
export function parseDecision(text: string): {
  decision: Exclude<ScreeningDecision, "pending">;
  reason: string;
  evidence: string;
} {
  try {
    const raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
    const d = String(raw.decision ?? "")
      .toLowerCase()
      .trim();
    const decision = d === "include" || d === "exclude" || d === "maybe" ? d : "maybe";
    return {
      decision,
      reason:
        String(raw.reason ?? "")
          .trim()
          .slice(0, 600) || "No reason given.",
      evidence: String(raw.evidence ?? "")
        .trim()
        .slice(0, 400),
    };
  } catch {
    return { decision: "maybe", reason: "The AI's answer could not be read; please decide.", evidence: "" };
  }
}

async function screenOne(
  screening: ScreeningRow,
  paperId: string,
  provider: Awaited<ReturnType<typeof providerForWorkspace>>,
) {
  const paper = await getVisiblePaper(screening.workspaceId, paperId);
  let body = `Title: ${paper.title}\nYear: ${paper.year ?? "unknown"}\nVenue: ${paper.venue ?? "unknown"}\nAbstract: ${paper.abstract ?? "(no abstract available)"}`;
  if (screening.useFullText) {
    const text = await loadPaperText(screening.workspaceId, paperId).catch(() => null);
    if (text) body += `\n\nRelevant parts of the full text:\n${relevantParts(text, screening.criteria, 12_000).body}`;
  }
  const reply = await complete(provider, {
    system: SCREEN_SYSTEM,
    messages: [
      {
        role: "user",
        content: `<criteria>\n${screening.criteria}\n</criteria>\n\n<paper>\n${body}\n</paper>\n\nReply with {"decision": "include" | "exclude" | "maybe", "reason": "<one or two sentences naming the criteria that decide it>", "evidence": "<the sentence from the paper the decision rests on, verbatim, at most 200 characters>"}. Use "maybe" when the text given is not enough to decide.`,
      },
    ],
  });
  return parseDecision(reply);
}

/** One batch of AI decisions; queues the next batch until every paper is decided (or the screening is paused). */
export async function screenBatch(screeningId: string) {
  const [screening] = await db.select().from(screenings).where(eq(screenings.id, screeningId));
  if (!screening || screening.status !== "running") return { skipped: screening ? screening.status : "deleted" };
  const items = await db
    .select({ paperId: screeningItems.paperId })
    .from(screeningItems)
    .where(and(eq(screeningItems.screeningId, screeningId), eq(screeningItems.decision, "pending")))
    .limit(BATCH);
  if (!items.length) {
    await db.update(screenings).set({ status: "done" }).where(eq(screenings.id, screeningId));
    return { decided: 0, done: true };
  }
  let provider;
  try {
    provider = await providerForWorkspace(screening.workspaceId);
  } catch (err) {
    // No AI (any more): pause rather than fail every paper.
    await db.update(screenings).set({ status: "paused" }).where(eq(screenings.id, screeningId));
    return { paused: err instanceof AIError ? err.message : "AI unavailable" };
  }
  let decided = 0;
  for (const { paperId } of items) {
    try {
      const d = await screenOne(screening, paperId, provider);
      await db
        .update(screeningItems)
        .set({ ...d, decidedBy: "ai", error: null, updatedAt: new Date() })
        .where(and(eq(screeningItems.screeningId, screeningId), eq(screeningItems.paperId, paperId)));
      decided++;
    } catch (err) {
      if (
        err instanceof AIError &&
        (err.kind === "rate_limited" || err.kind === "auth" || err.kind === "not_configured")
      ) {
        // A plan limit or sign-in problem affects every paper: pause and let the user resume later.
        await db.update(screenings).set({ status: "paused" }).where(eq(screenings.id, screeningId));
        return { decided, paused: err.message };
      }
      await db
        .update(screeningItems)
        .set({
          decision: "maybe",
          reason: "The AI could not screen this paper; please decide.",
          error: err instanceof Error ? err.message.slice(0, 300) : String(err),
          decidedBy: "ai",
          updatedAt: new Date(),
        })
        .where(and(eq(screeningItems.screeningId, screeningId), eq(screeningItems.paperId, paperId)));
    }
  }
  await db.update(screenings).set({ updatedAt: new Date() }).where(eq(screenings.id, screeningId));
  const left = await pendingCount(screeningId);
  if (left) await queueNext(screening, left);
  else await db.update(screenings).set({ status: "done" }).where(eq(screenings.id, screeningId));
  return { decided, left };
}

async function countsOf(ids: string[]) {
  if (!ids.length) return new Map<string, ScreeningSummary["counts"]>();
  const rows = await db
    .select({ id: screeningItems.screeningId, decision: screeningItems.decision, n: count() })
    .from(screeningItems)
    .where(inArray(screeningItems.screeningId, ids))
    .groupBy(screeningItems.screeningId, screeningItems.decision);
  const out = new Map<string, ScreeningSummary["counts"]>();
  for (const id of ids) out.set(id, { pending: 0, include: 0, exclude: 0, maybe: 0 });
  for (const r of rows) out.get(r.id)![r.decision] = r.n;
  return out;
}

function summary(row: ScreeningRow, counts: ScreeningSummary["counts"]): ScreeningSummary {
  return {
    id: row.id,
    title: row.title,
    criteria: row.criteria,
    useFullText: row.useFullText,
    status: row.status,
    counts,
    total: counts.pending + counts.include + counts.exclude + counts.maybe,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listScreenings(workspaceId: string): Promise<ScreeningSummary[]> {
  const rows = await db
    .select()
    .from(screenings)
    .where(eq(screenings.workspaceId, workspaceId))
    .orderBy(desc(screenings.createdAt));
  const counts = await countsOf(rows.map((r) => r.id));
  return rows.map((r) => summary(r, counts.get(r.id)!));
}

export async function screeningDetail(workspaceId: string, id: string): Promise<ScreeningDetail> {
  const row = await ownedScreening(workspaceId, id);
  const items = await db.select().from(screeningItems).where(eq(screeningItems.screeningId, id));
  const papers = new Map(
    (
      await getPaperSummaries(
        workspaceId,
        items.map((i) => i.paperId),
      )
    ).map((p) => [p.id, p]),
  );
  const order: Record<ScreeningDecision, number> = { include: 0, maybe: 1, pending: 2, exclude: 3 };
  const list: ScreeningItemDto[] = items
    .flatMap((i) => {
      const paper = papers.get(i.paperId);
      return paper
        ? [
            {
              paper,
              decision: i.decision,
              reason: i.reason,
              evidence: i.evidence,
              decidedBy: i.decidedBy,
              error: i.error,
              updatedAt: i.updatedAt.toISOString(),
            },
          ]
        : [];
    })
    .sort((a, b) => order[a.decision] - order[b.decision] || a.paper.title.localeCompare(b.paper.title));
  const counts = (await countsOf([id])).get(id)!;
  return { ...summary(row, counts), items: list };
}

/** The user's own decision for a paper (it replaces the AI's). */
export async function decide(
  workspaceId: string,
  id: string,
  paperId: string,
  decision: Exclude<ScreeningDecision, "pending">,
) {
  await ownedScreening(workspaceId, id);
  const rows = await db
    .update(screeningItems)
    .set({ decision, decidedBy: "user", error: null, updatedAt: new Date() })
    .where(and(eq(screeningItems.screeningId, id), eq(screeningItems.paperId, paperId)))
    .returning();
  if (!rows.length) throw notFound("Paper in this screening");
}

export async function setScreeningRunning(workspaceId: string, id: string, running: boolean) {
  const row = await ownedScreening(workspaceId, id);
  const left = await pendingCount(id);
  const status = running ? (left ? "running" : "done") : "paused";
  await db.update(screenings).set({ status }).where(eq(screenings.id, id));
  if (status === "running") await queueNext(row, left);
  return status;
}

export async function deleteScreening(workspaceId: string, id: string) {
  await ownedScreening(workspaceId, id);
  await db.delete(screenings).where(eq(screenings.id, id));
}

/** Saves the included papers (and optionally "maybe") as a new collection. */
export async function saveIncluded(ctx: RequestContext, id: string, opts: { name: string; withMaybe?: boolean }) {
  await ownedScreening(ctx.workspaceId, id);
  const decisions: ScreeningDecision[] = opts.withMaybe ? ["include", "maybe"] : ["include"];
  const ids = (
    await db
      .select({ id: screeningItems.paperId })
      .from(screeningItems)
      .where(and(eq(screeningItems.screeningId, id), inArray(screeningItems.decision, decisions)))
  ).map((r) => r.id);
  if (!ids.length) throw badRequest("No papers are included yet.");
  const collection = await createCollection(ctx.workspaceId, { name: opts.name });
  await addToCollection(ctx.workspaceId, ctx.userId, collection.id, ids);
  return { collectionId: collection.id, papers: ids.length };
}

const csvCell = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** The screening as CSV (one row per paper: decision, who decided, reason, evidence, identifiers). */
export async function screeningCsv(workspaceId: string, id: string) {
  const d = await screeningDetail(workspaceId, id);
  const head = ["decision", "decided_by", "title", "year", "authors", "venue", "doi", "arxiv", "reason", "evidence"];
  const rows = d.items.map((i: ScreeningItemDto) => {
    const p: PaperSummary = i.paper;
    return [
      i.decision,
      i.decidedBy ?? "",
      p.title,
      p.year ?? "",
      p.authors.join("; "),
      p.venue ?? "",
      p.ids.doi ?? "",
      p.ids.arxiv ?? "",
      i.reason,
      i.evidence,
    ]
      .map(csvCell)
      .join(",");
  });
  return {
    filename: `${d.title.replace(/[^\w-]+/g, "_").slice(0, 60) || "screening"}.csv`,
    csv: [head.join(","), ...rows].join("\n"),
  };
}
