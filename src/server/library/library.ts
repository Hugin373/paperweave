import { and, asc, count, desc, eq, exists, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import type { LibraryItem, LibraryResponse, ReadingStatus } from "@/lib/types";
import { db } from "@/server/db/client";
import {
  collectionPapers,
  collections,
  libraryItems,
  notes,
  paperFiles,
  papers,
  paperTags,
  tags,
} from "@/server/db/schema";
import { queueWorkspaceEmbedding } from "@/server/embeddings/queue";
import { queueArxivTwinCheck } from "@/server/papers/arxiv-twin";
import { enqueueJob } from "@/server/jobs/queue";
import { queueOpenAccessCheck } from "@/server/papers/open-access";
import { getVisiblePaper, identifiersFor, toSummary } from "@/server/papers/service";

export const LIBRARY_SORTS = [
  "added_desc",
  "updated_desc",
  "year_desc",
  "year_asc",
  "title_asc",
  "citations_desc",
] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export interface LibraryQuery {
  status: ReadingStatus | "all";
  q?: string;
  tagId?: string;
  collectionId?: string;
  yearFrom?: number;
  yearTo?: number;
  hasPdf?: boolean;
  sort: LibrarySort;
  offset: number;
  limit: number;
}

export async function listLibrary(workspaceId: string, query: LibraryQuery): Promise<LibraryResponse> {
  const conditions: SQL[] = [eq(libraryItems.workspaceId, workspaceId)];
  if (query.status === "all") conditions.push(ne(libraryItems.status, "archived"));
  else conditions.push(eq(libraryItems.status, query.status));
  if (query.q?.trim()) {
    const like = `%${query.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conditions.push(
      sql`(${papers.title} ilike ${like} or ${papers.authorsText} ilike ${like} or ${papers.venue} ilike ${like} or ${papers.abstract} ilike ${like})`,
    );
  }
  if (query.yearFrom) conditions.push(gte(papers.year, query.yearFrom));
  if (query.yearTo) conditions.push(lte(papers.year, query.yearTo));
  if (query.tagId) {
    conditions.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(paperTags)
          .innerJoin(tags, eq(tags.id, paperTags.tagId))
          .where(
            and(eq(paperTags.paperId, papers.id), eq(paperTags.tagId, query.tagId), eq(tags.workspaceId, workspaceId)),
          ),
      ),
    );
  }
  if (query.collectionId) {
    conditions.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(collectionPapers)
          .innerJoin(collections, eq(collections.id, collectionPapers.collectionId))
          .where(
            and(
              eq(collectionPapers.paperId, papers.id),
              eq(collectionPapers.collectionId, query.collectionId),
              eq(collections.workspaceId, workspaceId),
            ),
          ),
      ),
    );
  }
  const hasPdfSql = exists(
    db
      .select({ x: sql`1` })
      .from(paperFiles)
      .where(and(eq(paperFiles.paperId, papers.id), eq(paperFiles.workspaceId, workspaceId))),
  );
  if (query.hasPdf) conditions.push(hasPdfSql);

  const orderBy = {
    added_desc: [desc(libraryItems.createdAt)],
    updated_desc: [desc(libraryItems.updatedAt)],
    year_desc: [sql`${papers.year} desc nulls last`, desc(libraryItems.createdAt)],
    year_asc: [sql`${papers.year} asc nulls last`, desc(libraryItems.createdAt)],
    title_asc: [asc(papers.title)],
    citations_desc: [sql`${papers.citationCount} desc nulls last`],
  }[query.sort];

  const where = and(...conditions);
  const [rows, [{ total }], statusCounts] = await Promise.all([
    db
      .select({
        paper: papers,
        status: libraryItems.status,
        addedAt: libraryItems.createdAt,
        updatedAt: libraryItems.updatedAt,
        hasPdf: hasPdfSql.mapWith(Boolean),
        noteCount:
          sql<number>`(select count(*) from ${notes} where ${notes.paperId} = ${papers.id} and ${notes.workspaceId} = ${workspaceId})`.mapWith(
            Number,
          ),
      })
      .from(libraryItems)
      .innerJoin(papers, eq(papers.id, libraryItems.paperId))
      .where(where)
      .orderBy(...orderBy)
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ total: count() })
      .from(libraryItems)
      .innerJoin(papers, eq(papers.id, libraryItems.paperId))
      .where(where),
    db
      .select({ status: libraryItems.status, n: count() })
      .from(libraryItems)
      .where(eq(libraryItems.workspaceId, workspaceId))
      .groupBy(libraryItems.status),
  ]);

  const paperIds = rows.map((r) => r.paper.id);
  const [ids, tagRows, collRows] = await Promise.all([
    identifiersFor(paperIds),
    paperIds.length
      ? db
          .select({ paperId: paperTags.paperId, id: tags.id, name: tags.name, color: tags.color })
          .from(paperTags)
          .innerJoin(tags, eq(tags.id, paperTags.tagId))
          .where(and(inArray(paperTags.paperId, paperIds), eq(tags.workspaceId, workspaceId)))
          .orderBy(tags.name)
      : [],
    paperIds.length
      ? db
          .select({
            paperId: collectionPapers.paperId,
            id: collections.id,
            name: collections.name,
            color: collections.color,
          })
          .from(collectionPapers)
          .innerJoin(collections, eq(collections.id, collectionPapers.collectionId))
          .where(and(inArray(collectionPapers.paperId, paperIds), eq(collections.workspaceId, workspaceId)))
          .orderBy(collections.name)
      : [],
  ]);

  const items: LibraryItem[] = rows.map((r) => ({
    ...toSummary(r.paper, ids.get(r.paper.id) ?? {}, { status: r.status, createdAt: r.addedAt }),
    library: { status: r.status, addedAt: r.addedAt.toISOString() },
    tags: tagRows.filter((t) => t.paperId === r.paper.id).map(({ id, name, color }) => ({ id, name, color })),
    collections: collRows.filter((c) => c.paperId === r.paper.id).map(({ id, name, color }) => ({ id, name, color })),
    hasPdf: r.hasPdf,
    noteCount: r.noteCount,
    updatedAt: r.updatedAt.toISOString(),
  }));

  const counts = { all: 0, saved: 0, reading: 0, read: 0, archived: 0 } as LibraryResponse["counts"];
  for (const c of statusCounts) {
    counts[c.status] = c.n;
    if (c.status !== "archived") counts.all += c.n;
  }
  return { items, total, counts };
}

/** Adds a paper to the library (idempotent) and schedules background reference syncing. */
export async function savePaper(
  workspaceId: string,
  userId: string,
  paperId: string,
  status: ReadingStatus = "saved",
): Promise<void> {
  const paper = await getVisiblePaper(workspaceId, paperId);
  const added = await db
    .insert(libraryItems)
    .values({ workspaceId, paperId, status, addedBy: userId })
    .onConflictDoNothing()
    .returning({ paperId: libraryItems.paperId });
  // Newly saved papers become findable by meaning (their abstract) shortly; papers known only from
  // OpenReview (anonymous while under review) get their arXiv version looked up.
  if (added.length) {
    await queueWorkspaceEmbedding(workspaceId);
    await queueArxivTwinCheck(paper);
  }
  if (paper.ownerWorkspaceId === null && !paper.referencesSyncedAt) {
    await enqueueJob({ type: "sync_references", payload: { paperId }, dedupeKey: `sync_references:${paperId}` });
  }
  // Journal papers without a known free PDF: ask Unpaywall in the background (if enabled).
  if (paper.ownerWorkspaceId === null && !paper.openAccessPdfUrl && !paper.oaCheckedAt) {
    await queueOpenAccessCheck(paperId);
  }
}

export async function setStatus(workspaceId: string, paperIds: string[], status: ReadingStatus) {
  if (!paperIds.length) return 0;
  const rows = await db
    .update(libraryItems)
    .set({ status })
    .where(and(eq(libraryItems.workspaceId, workspaceId), inArray(libraryItems.paperId, paperIds)))
    .returning({ paperId: libraryItems.paperId });
  return rows.length;
}

/**
 * Removes papers from the library together with their organization (tags, collections).
 * Notes, highlights and PDFs are user knowledge and are kept.
 */
export async function removeFromLibrary(workspaceId: string, paperIds: string[]) {
  if (!paperIds.length) return 0;
  return db.transaction(async (tx) => {
    await tx
      .delete(paperTags)
      .where(
        and(
          inArray(paperTags.paperId, paperIds),
          inArray(paperTags.tagId, tx.select({ id: tags.id }).from(tags).where(eq(tags.workspaceId, workspaceId))),
        ),
      );
    await tx
      .delete(collectionPapers)
      .where(
        and(
          inArray(collectionPapers.paperId, paperIds),
          inArray(
            collectionPapers.collectionId,
            tx.select({ id: collections.id }).from(collections).where(eq(collections.workspaceId, workspaceId)),
          ),
        ),
      );
    const rows = await tx
      .delete(libraryItems)
      .where(and(eq(libraryItems.workspaceId, workspaceId), inArray(libraryItems.paperId, paperIds)))
      .returning({ paperId: libraryItems.paperId });
    return rows.length;
  });
}
