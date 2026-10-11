/**
 * Undo for the assistant's deletions: before deleting, the rows that will disappear (the item and everything
 * that cascades with it) are copied; undo puts them back with their original ids, so links to them from
 * notes, the graph and other places keep working.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/server/db/client";
import {
  collectionPapers,
  collections,
  conceptRelations,
  concepts,
  libraryItems,
  noteLinks,
  paperConcepts,
  paperTags,
  savedSearches,
  savedSearchResults,
  tags,
} from "@/server/db/schema";
import { conflict } from "@/server/http";

/** Parents before children, so foreign keys are satisfied when restoring. */
const TABLES = {
  collections,
  tags,
  concepts,
  savedSearches,
  libraryItems,
  collectionPapers,
  paperTags,
  paperConcepts,
  conceptRelations,
  noteLinks,
  savedSearchResults,
} as const;
type TableName = keyof typeof TABLES;
type Row = Record<string, unknown>;
export type Snapshot = Partial<Record<TableName, Row[]>>;

const rows = (list: Row[]) => list as Row[];

export async function snapshotCollection(id: string): Promise<Snapshot> {
  return {
    collections: rows(await db.select().from(collections).where(eq(collections.id, id))),
    collectionPapers: rows(await db.select().from(collectionPapers).where(eq(collectionPapers.collectionId, id))),
  };
}

export async function snapshotTag(id: string): Promise<Snapshot> {
  return {
    tags: rows(await db.select().from(tags).where(eq(tags.id, id))),
    paperTags: rows(await db.select().from(paperTags).where(eq(paperTags.tagId, id))),
  };
}

export async function snapshotConcept(id: string): Promise<Snapshot> {
  return {
    concepts: rows(await db.select().from(concepts).where(eq(concepts.id, id))),
    paperConcepts: rows(await db.select().from(paperConcepts).where(eq(paperConcepts.conceptId, id))),
    conceptRelations: rows(
      await db
        .select()
        .from(conceptRelations)
        .where(or(eq(conceptRelations.conceptAId, id), eq(conceptRelations.conceptBId, id))),
    ),
    noteLinks: rows(await db.select().from(noteLinks).where(eq(noteLinks.targetConceptId, id))),
  };
}

/** Library entries of these papers, with their tags and collection memberships in the workspace. */
export async function snapshotLibrary(workspaceId: string, paperIds: string[]): Promise<Snapshot> {
  if (!paperIds.length) return {};
  const wsTags = db.select({ id: tags.id }).from(tags).where(eq(tags.workspaceId, workspaceId));
  const wsCollections = db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.workspaceId, workspaceId));
  return {
    libraryItems: rows(
      await db
        .select()
        .from(libraryItems)
        .where(and(eq(libraryItems.workspaceId, workspaceId), inArray(libraryItems.paperId, paperIds))),
    ),
    paperTags: rows(
      await db
        .select()
        .from(paperTags)
        .where(and(inArray(paperTags.paperId, paperIds), inArray(paperTags.tagId, wsTags))),
    ),
    collectionPapers: rows(
      await db
        .select()
        .from(collectionPapers)
        .where(and(inArray(collectionPapers.paperId, paperIds), inArray(collectionPapers.collectionId, wsCollections))),
    ),
  };
}

export async function snapshotSavedSearch(id: string): Promise<Snapshot> {
  return {
    savedSearches: rows(await db.select().from(savedSearches).where(eq(savedSearches.id, id))),
    savedSearchResults: rows(await db.select().from(savedSearchResults).where(eq(savedSearchResults.searchId, id))),
  };
}

/** Dates come back from the stored change as strings. */
function revive(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "string" && /At$/.test(k) && !Number.isNaN(Date.parse(v)) ? new Date(v) : v;
  }
  return out;
}

/** Puts deleted rows back (rows that exist again are left alone). */
export async function restoreSnapshot(snapshot: unknown) {
  const snap = (snapshot ?? {}) as Snapshot;
  try {
    await db.transaction(async (tx) => {
      for (const name of Object.keys(TABLES) as TableName[]) {
        const list = snap[name];
        if (!list?.length) continue;
        // The rows are this table's own, as copied: the generic table type cannot express that.
        await tx
          .insert(TABLES[name] as PgTable)
          .values(list.map(revive) as never)
          .onConflictDoNothing();
      }
    });
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") throw conflict("Something with the same name exists now; rename it first, then undo.");
    throw err;
  }
}
