import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db/client";
import { paperFiles, workspaceMembers, workspaces } from "@/server/db/schema";
import { storage } from "@/server/files/storage";

export type WorkspaceRole = (typeof workspaceMembers.$inferSelect)["role"];

export async function createPersonalWorkspace(userId: string, userName: string) {
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspaces)
      .values({ name: userName ? `${userName}'s workspace` : "My workspace", isPersonal: true })
      .returning();
    await tx.insert(workspaceMembers).values({ workspaceId: ws.id, userId, role: "owner" });
    return ws;
  });
}

/**
 * The workspace a user is working in. Today every user has one personal workspace; the
 * membership table already supports shared/team workspaces.
 */
/** Which workspace a user is in rarely changes; a short cache saves a lookup on every request. */
const ACTIVE_TTL_MS = 60_000;
const activeCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof loadActiveWorkspace>> }>();

export function forgetActiveWorkspace(userId?: string) {
  if (userId) activeCache.delete(userId);
  else activeCache.clear();
}

export async function getActiveWorkspace(userId: string, requestedId?: string | null) {
  if (requestedId) return loadActiveWorkspace(userId, requestedId);
  const hit = activeCache.get(userId);
  if (hit && Date.now() - hit.at < ACTIVE_TTL_MS) return hit.value;
  const value = await loadActiveWorkspace(userId);
  if (value) activeCache.set(userId, { at: Date.now(), value });
  if (activeCache.size > 1000) activeCache.delete(activeCache.keys().next().value!);
  return value;
}

async function loadActiveWorkspace(userId: string, requestedId?: string | null) {
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      requestedId
        ? and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, requestedId))
        : eq(workspaceMembers.userId, userId),
    )
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Deletes the personal workspaces a user owns (used when the account is deleted). */
export async function deleteOwnedWorkspaces(userId: string) {
  forgetActiveWorkspace(userId);
  const owned = await db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "owner"), eq(workspaces.isPersonal, true)),
    );
  if (!owned.length) return;
  const ids = owned.map((w) => w.id);
  const files = await db
    .select({ key: paperFiles.storageKey })
    .from(paperFiles)
    .where(inArray(paperFiles.workspaceId, ids));
  await db.delete(workspaces).where(inArray(workspaces.id, ids));
  // Stored PDFs are removed after the rows; failures only leave unreachable objects behind.
  for (const f of files) {
    if (!f.key) continue;
    await storage()
      .delete(f.key)
      .catch((err) => console.error("[workspaces] could not delete object", f.key, err));
  }
}
