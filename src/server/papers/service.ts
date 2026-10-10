import { and, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { detectIdentifier } from "@/lib/identifiers";
import type { IdentifierMap, NoteSummary, PaperDetail, PaperSummary, ReadingStatus } from "@/lib/types";
import { env } from "@/server/env";
import { db } from "@/server/db/client";
import {
  collectionPapers,
  collections,
  concepts,
  highlights,
  libraryItems,
  noteLinks,
  notes,
  paperConcepts,
  paperFiles,
  paperIdentifiers,
  papers,
  paperTags,
  tags,
} from "@/server/db/schema";
import { toFileInfo } from "@/server/files/info";
import { notFound } from "@/server/http";
import { scholarly } from "@/server/scholarly/service";
import type { PaperIds } from "@/server/scholarly/types";
import { enrichPaper, ingestRecordsOfOnePaper } from "./ingest";

type PaperRow = typeof papers.$inferSelect;

const STALE_AFTER_MS = 7 * 24 * 3600_000;

export function toSummary(
  row: PaperRow,
  ids: IdentifierMap,
  library: { status: ReadingStatus; createdAt: Date } | null,
): PaperSummary {
  return {
    id: row.id,
    title: row.title,
    authors: row.authors.map((a) => a.name),
    year: row.year,
    venue: row.venue,
    abstract: row.abstract,
    citationCount: row.citationCount,
    referenceCount: row.referenceCount,
    isOpenAccess: row.isOpenAccess,
    openAccessPdfUrl: row.openAccessPdfUrl,
    publicationTypes: row.publicationTypes,
    ids,
    library: library ? { status: library.status, addedAt: library.createdAt.toISOString() } : null,
    isUserPaper: row.ownerWorkspaceId !== null,
    pdfAvailable: pdfAvailable(row, ids),
    freeReadUrl: row.ownerWorkspaceId === null ? row.freeReadUrl : null,
  };
}

/** Whether a free, legal PDF is known for a paper (see PaperSummary.pdfAvailable and openAccessCandidates). */
export function pdfAvailable(row: Pick<PaperRow, "ownerWorkspaceId" | "openAccessPdfUrl">, ids: IdentifierMap) {
  if (row.ownerWorkspaceId !== null) return false;
  const openReview = !!(ids.openreview && env().OPENREVIEW_USERNAME && env().OPENREVIEW_PASSWORD);
  return !!(row.openAccessPdfUrl || ids.arxiv || openReview);
}

export async function identifiersFor(paperIds: string[]): Promise<Map<string, IdentifierMap>> {
  const map = new Map<string, IdentifierMap>();
  if (!paperIds.length) return map;
  const rows = await db
    .select({ paperId: paperIdentifiers.paperId, kind: paperIdentifiers.kind, value: paperIdentifiers.value })
    .from(paperIdentifiers)
    .where(inArray(paperIdentifiers.paperId, paperIds));
  for (const r of rows) {
    const m = map.get(r.paperId) ?? {};
    m[r.kind] = r.value;
    map.set(r.paperId, m);
  }
  return map;
}

/** Loads summaries for the given papers, preserving input order and skipping invisible ones. */
export async function getPaperSummaries(workspaceId: string | null, paperIds: string[]): Promise<PaperSummary[]> {
  const unique = [...new Set(paperIds)];
  if (!unique.length) return [];
  const rows = await db
    .select({ paper: papers, status: libraryItems.status, addedAt: libraryItems.createdAt })
    .from(papers)
    .leftJoin(
      libraryItems,
      and(eq(libraryItems.paperId, papers.id), workspaceId ? eq(libraryItems.workspaceId, workspaceId) : sql`false`),
    )
    .where(inArray(papers.id, unique));
  const ids = await identifiersFor(unique);
  const byId = new Map(
    rows
      .filter((r) => r.paper.ownerWorkspaceId === null || r.paper.ownerWorkspaceId === workspaceId)
      .map((r) => [
        r.paper.id,
        toSummary(r.paper, ids.get(r.paper.id) ?? {}, r.status ? { status: r.status, createdAt: r.addedAt! } : null),
      ]),
  );
  return unique.map((id) => byId.get(id)).filter((p): p is PaperSummary => !!p);
}

/** Loads a paper row the workspace may see, or throws 404. */
export async function getVisiblePaper(workspaceId: string, paperId: string): Promise<PaperRow> {
  const [row] = await db
    .select()
    .from(papers)
    .where(
      and(
        eq(papers.id, paperId),
        or(sql`${papers.ownerWorkspaceId} is null`, eq(papers.ownerWorkspaceId, workspaceId)),
      ),
    );
  if (!row) throw notFound("Paper");
  return row;
}

/**
 * Refreshes metadata from external sources when it is missing or stale. Failures are
 * swallowed: stored metadata is always good enough to render the page.
 */
export async function refreshPaperIfStale(row: PaperRow, ids: IdentifierMap, force = false): Promise<boolean> {
  if (row.ownerWorkspaceId !== null) return false;
  const fresh = row.metadataRefreshedAt && Date.now() - row.metadataRefreshedAt.getTime() < STALE_AFTER_MS;
  if (fresh && !force) return false;
  try {
    const records = await Promise.race([
      scholarly().lookup(ids as PaperIds),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 12000)),
    ]);
    if (records.length) await enrichPaper(row.id, records);
    return records.length > 0;
  } catch {
    return false;
  }
}

const g = globalThis as unknown as { __pwRefreshing?: Set<string> };
const refreshing = (g.__pwRefreshing ??= new Set());

/** Refreshes a paper's metadata without making the caller wait (one refresh per paper at a time). */
function refreshInBackground(row: PaperRow, ids: IdentifierMap) {
  if (row.ownerWorkspaceId !== null || refreshing.has(row.id)) return;
  if (!ids.arxiv) void import("./arxiv-twin").then((m) => m.queueArxivTwinCheck(row)).catch(() => {});
  const fresh = row.metadataRefreshedAt && Date.now() - row.metadataRefreshedAt.getTime() < STALE_AFTER_MS;
  if (fresh) return;
  refreshing.add(row.id);
  void refreshPaperIfStale(row, ids).finally(() => refreshing.delete(row.id));
}

async function noteSummaries(where: ReturnType<typeof and>): Promise<NoteSummary[]> {
  const rows = await db
    .select({
      id: notes.id,
      title: notes.title,
      text: notes.contentText,
      paperId: notes.paperId,
      paperTitle: papers.title,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .leftJoin(papers, eq(papers.id, notes.paperId))
    .where(where)
    .orderBy(desc(notes.updatedAt))
    .limit(100);
  return rows.map(toNoteSummary);
}

export function toNoteSummary(r: {
  id: string;
  title: string;
  text: string;
  paperId: string | null;
  paperTitle: string | null;
  updatedAt: Date;
}): NoteSummary {
  return {
    id: r.id,
    title: r.title || "Untitled note",
    excerpt: r.text.slice(0, 240),
    paperId: r.paperId,
    paperTitle: r.paperTitle,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The workspace's own data about a paper (library entry, organization, files, notes, highlights). */
async function workspacePaperParts(workspaceId: string, paperId: string) {
  const [[lib], tagRows, collectionRows, conceptRows, fileRows, paperNotes, mentionedIn, [hl]] = await Promise.all([
    db
      .select()
      .from(libraryItems)
      .where(and(eq(libraryItems.workspaceId, workspaceId), eq(libraryItems.paperId, paperId))),
    db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(paperTags)
      .innerJoin(tags, eq(tags.id, paperTags.tagId))
      .where(and(eq(paperTags.paperId, paperId), eq(tags.workspaceId, workspaceId)))
      .orderBy(tags.name),
    db
      .select({ id: collections.id, name: collections.name, color: collections.color })
      .from(collectionPapers)
      .innerJoin(collections, eq(collections.id, collectionPapers.collectionId))
      .where(and(eq(collectionPapers.paperId, paperId), eq(collections.workspaceId, workspaceId)))
      .orderBy(collections.name),
    db
      .select({ id: concepts.id, name: concepts.name })
      .from(paperConcepts)
      .innerJoin(concepts, eq(concepts.id, paperConcepts.conceptId))
      .where(and(eq(paperConcepts.paperId, paperId), eq(concepts.workspaceId, workspaceId)))
      .orderBy(concepts.name),
    db
      .select()
      .from(paperFiles)
      .where(and(eq(paperFiles.paperId, paperId), eq(paperFiles.workspaceId, workspaceId)))
      .orderBy(desc(paperFiles.createdAt)),
    noteSummaries(and(eq(notes.workspaceId, workspaceId), eq(notes.paperId, paperId))),
    noteSummaries(
      and(
        eq(notes.workspaceId, workspaceId),
        or(sql`${notes.paperId} is null`, ne(notes.paperId, paperId)),
        inArray(
          notes.id,
          db.select({ id: noteLinks.noteId }).from(noteLinks).where(eq(noteLinks.targetPaperId, paperId)),
        ),
      ),
    ),
    db
      .select({ n: count() })
      .from(highlights)
      .where(and(eq(highlights.workspaceId, workspaceId), eq(highlights.paperId, paperId))),
  ]);
  return { lib, tagRows, collectionRows, conceptRows, fileRows, paperNotes, mentionedIn, hl };
}

export async function getPaperDetail(workspaceId: string, paperId: string): Promise<PaperDetail> {
  // Everything below depends only on the ids, so it is fetched at once: against a cloud database each
  // round trip costs ~70 ms. The workspace-scoped parts can run before the visibility check settles.
  const [visible, idMap, workspaceParts] = await Promise.allSettled([
    getVisiblePaper(workspaceId, paperId),
    identifiersFor([paperId]),
    workspacePaperParts(workspaceId, paperId),
  ]);
  if (visible.status === "rejected") throw visible.reason;
  if (idMap.status === "rejected") throw idMap.reason;
  if (workspaceParts.status === "rejected") throw workspaceParts.reason;
  let row = visible.value;
  let ids = idMap.value.get(paperId) ?? {};
  if (!row.abstract && !row.metadataRefreshedAt) {
    // Nothing useful to show yet beyond the title: worth waiting briefly for the sources.
    if (await refreshPaperIfStale(row, ids)) {
      row = await getVisiblePaper(workspaceId, paperId);
      ids = (await identifiersFor([paperId])).get(paperId) ?? {};
    }
  } else {
    // Stored metadata is good enough to render now; refresh in the background for next time.
    refreshInBackground(row, ids);
  }

  const { lib, tagRows, collectionRows, conceptRows, fileRows, paperNotes, mentionedIn, hl } = workspaceParts.value;

  return {
    ...toSummary(row, ids, lib ? { status: lib.status, createdAt: lib.createdAt } : null),
    publicationDate: row.publicationDate,
    fieldsOfStudy: row.fieldsOfStudy,
    url: row.url,
    influentialCitationCount: row.influentialCitationCount,
    authorDetails: row.authors,
    metadataSource: row.source,
    metadataRefreshedAt: row.metadataRefreshedAt?.toISOString() ?? null,
    tags: tagRows,
    collections: collectionRows,
    concepts: conceptRows,
    files: fileRows.map(toFileInfo),
    notes: paperNotes,
    mentionedIn,
    highlightCount: hl?.n ?? 0,
  };
}

/**
 * Resolves an identifier (DOI, arXiv id, …) to an internal paper, fetching it from external
 * sources if it is not known yet. Returns null when no source knows the identifier.
 */
export async function resolveIdentifier(raw: string): Promise<string | null> {
  const parsed = detectIdentifier(raw);
  if (!parsed) return null;
  const [existing] = await db
    .select({ paperId: paperIdentifiers.paperId })
    .from(paperIdentifiers)
    .where(
      and(
        eq(paperIdentifiers.scope, "global"),
        eq(paperIdentifiers.kind, parsed.kind),
        eq(paperIdentifiers.value, parsed.value),
      ),
    );
  if (existing) {
    // Papers first seen inside someone else's citation list may never have been enriched.
    const [row] = await db.select().from(papers).where(eq(papers.id, existing.paperId));
    if (row && !row.metadataRefreshedAt) {
      await refreshPaperIfStale(row, (await identifiersFor([row.id])).get(row.id) ?? {});
    }
    return existing.paperId;
  }
  const records = await scholarly().lookup({ [parsed.kind]: parsed.value });
  return ingestRecordsOfOnePaper(records);
}
