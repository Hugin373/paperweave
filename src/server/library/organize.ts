/** Tags and collections: lightweight organization of library papers. */
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { CollectionSummary, TagSummary } from "@/lib/types";
import { nextCollectionColor } from "@/lib/collection-colors";
import { db } from "@/server/db/client";
import { collectionPapers, collections, libraryItems, paperTags, tags } from "@/server/db/schema";
import { conflict, notFound } from "@/server/http";
import { savePaper } from "./library";

function isUniqueViolation(err: unknown) {
  const code = (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  return code === "23505";
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export async function listTags(workspaceId: string): Promise<TagSummary[]> {
  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      paperCount: sql<number>`count(${libraryItems.paperId})`.mapWith(Number),
    })
    .from(tags)
    .leftJoin(paperTags, eq(paperTags.tagId, tags.id))
    .leftJoin(libraryItems, and(eq(libraryItems.paperId, paperTags.paperId), eq(libraryItems.workspaceId, workspaceId)))
    .where(eq(tags.workspaceId, workspaceId))
    .groupBy(tags.id)
    .orderBy(tags.name);
  return rows;
}

async function ownedTag(workspaceId: string, tagId: string) {
  const [tag] = await db
    .select()
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.workspaceId, workspaceId)));
  if (!tag) throw notFound("Tag");
  return tag;
}

/** Returns existing tags matching the names (case-insensitive) and creates the missing ones. */
export async function ensureTags(workspaceId: string, names: string[]) {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (!clean.length) return [];
  await db
    .insert(tags)
    .values(clean.map((name) => ({ workspaceId, name })))
    .onConflictDoNothing();
  return db
    .select()
    .from(tags)
    .where(
      and(
        eq(tags.workspaceId, workspaceId),
        inArray(
          sql`lower(${tags.name})`,
          clean.map((n) => n.toLowerCase()),
        ),
      ),
    );
}

export async function updateTag(workspaceId: string, tagId: string, patch: { name?: string; color?: string | null }) {
  await ownedTag(workspaceId, tagId);
  try {
    const [row] = await db.update(tags).set(patch).where(eq(tags.id, tagId)).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A tag with that name already exists.");
    throw err;
  }
}

export async function deleteTag(workspaceId: string, tagId: string) {
  await ownedTag(workspaceId, tagId);
  await db.delete(tags).where(eq(tags.id, tagId));
}

/** Adds/removes tags on papers. Tagging a paper saves it to the library if needed. */
export async function tagPapers(
  workspaceId: string,
  userId: string,
  paperIds: string[],
  add: { tagIds?: string[]; names?: string[] },
  remove: string[] = [],
) {
  const named = await ensureTags(workspaceId, add.names ?? []);
  const addIds = [...new Set([...(add.tagIds ?? []), ...named.map((t) => t.id)])];
  for (const id of [...addIds, ...remove]) await ownedTag(workspaceId, id);
  for (const paperId of paperIds) await savePaper(workspaceId, userId, paperId);
  if (addIds.length && paperIds.length) {
    await db
      .insert(paperTags)
      .values(paperIds.flatMap((paperId) => addIds.map((tagId) => ({ paperId, tagId }))))
      .onConflictDoNothing();
  }
  if (remove.length && paperIds.length) {
    await db.delete(paperTags).where(and(inArray(paperTags.paperId, paperIds), inArray(paperTags.tagId, remove)));
  }
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export async function listCollections(workspaceId: string): Promise<CollectionSummary[]> {
  const rows = await db
    .select({
      id: collections.id,
      name: collections.name,
      color: collections.color,
      description: collections.description,
      updatedAt: collections.updatedAt,
      paperCount: count(collectionPapers.paperId),
    })
    .from(collections)
    .leftJoin(collectionPapers, eq(collectionPapers.collectionId, collections.id))
    .where(eq(collections.workspaceId, workspaceId))
    .groupBy(collections.id)
    .orderBy(collections.name);
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}

export async function getOwnedCollection(workspaceId: string, collectionId: string) {
  const [row] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.workspaceId, workspaceId)));
  if (!row) throw notFound("Collection");
  return row;
}

export async function createCollection(
  workspaceId: string,
  input: { name: string; description?: string; color?: string | null },
) {
  // Collections created without a color take the least-used palette color.
  const color =
    input.color ??
    nextCollectionColor(
      (
        await db.select({ color: collections.color }).from(collections).where(eq(collections.workspaceId, workspaceId))
      ).map((r) => r.color),
    );
  try {
    const [row] = await db
      .insert(collections)
      .values({
        workspaceId,
        name: input.name.trim(),
        description: input.description ?? "",
        color,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A collection with that name already exists.");
    throw err;
  }
}

export async function updateCollection(
  workspaceId: string,
  collectionId: string,
  patch: { name?: string; description?: string; color?: string | null },
) {
  await getOwnedCollection(workspaceId, collectionId);
  try {
    const [row] = await db
      .update(collections)
      .set({ ...patch, name: patch.name?.trim() })
      .where(eq(collections.id, collectionId))
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A collection with that name already exists.");
    throw err;
  }
}

export async function deleteCollection(workspaceId: string, collectionId: string) {
  await getOwnedCollection(workspaceId, collectionId);
  await db.delete(collections).where(eq(collections.id, collectionId));
}

/** Adds papers to a collection. Papers are saved to the collection owner's library first. */
export async function addToCollection(workspaceId: string, userId: string, collectionId: string, paperIds: string[]) {
  await getOwnedCollection(workspaceId, collectionId);
  for (const paperId of paperIds) await savePaper(workspaceId, userId, paperId);
  if (paperIds.length) {
    await db
      .insert(collectionPapers)
      .values(paperIds.map((paperId) => ({ collectionId, paperId })))
      .onConflictDoNothing();
    await db.update(collections).set({ updatedAt: new Date() }).where(eq(collections.id, collectionId));
  }
}

export async function removeFromCollection(workspaceId: string, collectionId: string, paperIds: string[]) {
  await getOwnedCollection(workspaceId, collectionId);
  if (!paperIds.length) return;
  await db
    .delete(collectionPapers)
    .where(and(eq(collectionPapers.collectionId, collectionId), inArray(collectionPapers.paperId, paperIds)));
}

export async function collectionPaperIds(collectionId: string): Promise<string[]> {
  const rows = await db
    .select({ paperId: collectionPapers.paperId })
    .from(collectionPapers)
    .where(eq(collectionPapers.collectionId, collectionId))
    .orderBy(desc(collectionPapers.createdAt));
  return rows.map((r) => r.paperId);
}
