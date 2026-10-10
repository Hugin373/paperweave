/**
 * Saved searches ("alerts"): a query run again every day. The first run only records what already
 * exists; papers found by later runs are new until the user looks at them.
 */
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { AlertSource, SavedSearchDto, SavedSearchResults } from "@/lib/types";
import { db } from "@/server/db/client";
import { savedSearchResults, savedSearches } from "@/server/db/schema";
import { conflict, notFound, type RequestContext } from "@/server/http";
import { enqueueJob } from "@/server/jobs/queue";
import { discover } from "@/server/papers/discovery";
import { ingestPapers } from "@/server/papers/ingest";
import { getPaperSummaries } from "@/server/papers/service";
import { scholarly } from "@/server/scholarly/service";

export const ALERT_SOURCES = ["general", "biomedical", "openreview", "arxiv"] as const;

const RESULTS_PER_RUN = 25;

async function ownedSearch(workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(savedSearches)
    .where(and(eq(savedSearches.id, id), eq(savedSearches.workspaceId, workspaceId)));
  if (!row) throw notFound("Saved search");
  return row;
}

function queueRun(searchId: string, workspaceId: string, baseline = false) {
  return enqueueJob({
    type: "run_saved_search",
    payload: { searchId, baseline },
    workspaceId,
    dedupeKey: `run_saved_search:${searchId}`,
  });
}

export async function createSavedSearch(
  ctx: RequestContext,
  input: { query: string; source: AlertSource },
): Promise<{ id: string; created: boolean }> {
  const query = input.query.trim().replace(/\s+/g, " ");
  const [row] = await db
    .insert(savedSearches)
    .values({ workspaceId: ctx.workspaceId, query, source: input.source, createdBy: ctx.userId })
    .onConflictDoNothing()
    .returning({ id: savedSearches.id });
  if (row) {
    await queueRun(row.id, ctx.workspaceId, true);
    return { id: row.id, created: true };
  }
  const [existing] = await db
    .select({ id: savedSearches.id })
    .from(savedSearches)
    .where(
      and(
        eq(savedSearches.workspaceId, ctx.workspaceId),
        sql`lower(${savedSearches.query}) = ${query.toLowerCase()}`,
        eq(savedSearches.source, input.source),
      ),
    );
  if (!existing) throw conflict("That search could not be saved.");
  return { id: existing.id, created: false };
}

/**
 * Runs a saved search once: the newest matching papers are recorded, and those not seen before are new
 * (on the first run, everything found counts as seen: it existed before the alert).
 */
export async function runSavedSearch(searchId: string, baseline = false) {
  const [search] = await db.select().from(savedSearches).where(eq(savedSearches.id, searchId));
  if (!search) return { skipped: "deleted" };
  try {
    let ids: string[];
    if (search.source === "arxiv") {
      const records = await scholarly().latestPreprints(search.query, RESULTS_PER_RUN, true);
      ids = records.length ? await ingestPapers(records) : [];
    } else {
      const res = await discover(search.workspaceId, {
        q: search.query,
        mode: "all",
        exact: true,
        offset: 0,
        limit: RESULTS_PER_RUN,
        sort: "newest",
        source: search.source,
        filters: {},
        fresh: true,
      });
      ids = res.items.map((p) => p.id);
    }
    const unique = [...new Set(ids)];
    const added = unique.length
      ? await db
          .insert(savedSearchResults)
          .values(unique.map((paperId) => ({ searchId, paperId, seen: baseline })))
          .onConflictDoNothing()
          .returning({ paperId: savedSearchResults.paperId })
      : [];
    await db
      .update(savedSearches)
      .set({ lastRunAt: new Date(), lastError: null })
      .where(eq(savedSearches.id, searchId));
    return { found: unique.length, new: baseline ? 0 : added.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(savedSearches)
      .set({ lastRunAt: new Date(), lastError: message.slice(0, 300) })
      .where(eq(savedSearches.id, searchId));
    throw err;
  }
}

/** Queues a run of every saved search (daily). */
export async function queueAllSavedSearches() {
  const rows = await db.select({ id: savedSearches.id, ws: savedSearches.workspaceId }).from(savedSearches);
  for (const r of rows) await queueRun(r.id, r.ws);
  return rows.length;
}

export async function listSavedSearches(workspaceId: string): Promise<SavedSearchDto[]> {
  const rows = await db
    .select()
    .from(savedSearches)
    .where(eq(savedSearches.workspaceId, workspaceId))
    .orderBy(desc(savedSearches.createdAt));
  if (!rows.length) return [];
  const counts = await db
    .select({
      searchId: savedSearchResults.searchId,
      total: count(),
      unseen: sql<number>`count(*) filter (where not ${savedSearchResults.seen})`.mapWith(Number),
    })
    .from(savedSearchResults)
    .where(
      inArray(
        savedSearchResults.searchId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(savedSearchResults.searchId);
  const byId = new Map(counts.map((c) => [c.searchId, c]));
  return rows.map((r) => ({
    id: r.id,
    query: r.query,
    source: r.source,
    newCount: byId.get(r.id)?.unseen ?? 0,
    total: byId.get(r.id)?.total ?? 0,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** New papers across all saved searches (for the navigation badge). */
export async function unseenCount(workspaceId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${savedSearchResults.paperId})`.mapWith(Number) })
    .from(savedSearchResults)
    .innerJoin(savedSearches, eq(savedSearches.id, savedSearchResults.searchId))
    .where(and(eq(savedSearches.workspaceId, workspaceId), eq(savedSearchResults.seen, false)));
  return row?.n ?? 0;
}

/** A saved search's papers, newest finds first, marking which are new. */
export async function savedSearchResultsOf(workspaceId: string, id: string): Promise<SavedSearchResults> {
  const search = await ownedSearch(workspaceId, id);
  const rows = await db
    .select()
    .from(savedSearchResults)
    .where(eq(savedSearchResults.searchId, id))
    .orderBy(desc(savedSearchResults.foundAt))
    .limit(200);
  const summaries = new Map(
    (
      await getPaperSummaries(
        workspaceId,
        rows.map((r) => r.paperId),
      )
    ).map((p) => [p.id, p]),
  );
  const [dto] = (await listSavedSearches(workspaceId)).filter((s) => s.id === search.id);
  return {
    search: dto,
    papers: rows.flatMap((r) => {
      const p = summaries.get(r.paperId);
      return p ? [{ ...p, isNew: !r.seen, foundAt: r.foundAt.toISOString() }] : [];
    }),
  };
}

export async function markSearchSeen(workspaceId: string, id: string) {
  await ownedSearch(workspaceId, id);
  await db.update(savedSearchResults).set({ seen: true }).where(eq(savedSearchResults.searchId, id));
}

export async function deleteSavedSearch(workspaceId: string, id: string) {
  await ownedSearch(workspaceId, id);
  await db.delete(savedSearches).where(eq(savedSearches.id, id));
}

/** Runs a saved search now (the "Check now" button). */
export async function checkSavedSearchNow(workspaceId: string, id: string) {
  await ownedSearch(workspaceId, id);
  return runSavedSearch(id);
}
