import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AccessLevel, PaperSummary, ShareDto, SharedWithMeItem } from "@/lib/types";
import { db } from "@/server/db/client";
import { collections, concepts, notes, shares, users, workspaceMembers } from "@/server/db/schema";
import { env } from "@/server/env";
import { badRequest, notFound, type RequestContext } from "@/server/http";
import { collectionPaperIds } from "@/server/library/organize";
import { getPaperSummaries } from "@/server/papers/service";
import { requireAccess, type ShareResource } from "./access";

type ShareRow = typeof shares.$inferSelect;

/** Returns the owning workspace and display title of a shareable resource. */
export async function resourceInfo(type: ShareResource, id: string) {
  const table = { collection: collections, note: notes, concept: concepts }[type];
  const titleCol = type === "collection" ? collections.name : type === "note" ? notes.title : concepts.name;
  const [row] = await db
    .select({ workspaceId: table.workspaceId, title: titleCol })
    .from(table)
    .where(eq(table.id, id));
  if (!row) throw notFound(type === "collection" ? "Collection" : type === "note" ? "Note" : "Concept");
  return { workspaceId: row.workspaceId, title: row.title || (type === "note" ? "Untitled note" : "") };
}

function linkUrl(token: string) {
  return `${env().APP_URL.replace(/\/$/, "")}/s/${token}`;
}

function toDto(row: ShareRow, grantee: { id: string; name: string; email: string } | null): ShareDto {
  return {
    id: row.id,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    permission: row.permission,
    grantee,
    linkUrl: row.linkToken ? linkUrl(row.linkToken) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listShares(ctx: RequestContext, type: ShareResource, id: string): Promise<ShareDto[]> {
  const info = await resourceInfo(type, id);
  await requireAccess(ctx, type, id, info.workspaceId, "owner", "Resource");
  const rows = await db
    .select({ share: shares, user: { id: users.id, name: users.name, email: users.email } })
    .from(shares)
    .leftJoin(users, eq(users.id, shares.granteeUserId))
    .where(and(eq(shares.resourceType, type), eq(shares.resourceId, id)))
    .orderBy(shares.createdAt);
  return rows.map((r) => toDto(r.share, r.user?.id ? r.user : null));
}

export async function createShare(
  ctx: RequestContext,
  input: {
    resourceType: ShareResource;
    resourceId: string;
    email?: string;
    permission: "view" | "edit";
    link?: boolean;
  },
): Promise<ShareDto> {
  const info = await resourceInfo(input.resourceType, input.resourceId);
  await requireAccess(ctx, input.resourceType, input.resourceId, info.workspaceId, "owner", "Resource");

  if (input.link) {
    const [existing] = await db
      .select()
      .from(shares)
      .where(
        and(
          eq(shares.resourceType, input.resourceType),
          eq(shares.resourceId, input.resourceId),
          sql`${shares.linkToken} is not null`,
        ),
      );
    if (existing) return toDto(existing, null);
    const [row] = await db
      .insert(shares)
      .values({
        workspaceId: info.workspaceId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        linkToken: randomBytes(24).toString("base64url"),
        permission: "view",
        createdBy: ctx.userId,
      })
      .returning();
    return toDto(row, null);
  }

  const email = input.email?.trim().toLowerCase();
  if (!email) throw badRequest("Enter the email address of the person to share with.");
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`);
  if (!user) throw badRequest("No Paperweave account uses that email address. Ask them to sign up first.");
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, info.workspaceId), eq(workspaceMembers.userId, user.id)));
  if (member) throw badRequest("That person already has access to this workspace.");
  const [row] = await db
    .insert(shares)
    .values({
      workspaceId: info.workspaceId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      granteeUserId: user.id,
      permission: input.permission,
      createdBy: ctx.userId,
    })
    .onConflictDoUpdate({
      target: [shares.resourceType, shares.resourceId, shares.granteeUserId],
      targetWhere: sql`${shares.granteeUserId} is not null`,
      set: { permission: input.permission },
    })
    .returning();
  return toDto(row, user);
}

async function ownedShare(ctx: RequestContext, shareId: string) {
  const [row] = await db.select().from(shares).where(eq(shares.id, shareId));
  if (!row || row.workspaceId !== ctx.workspaceId || ctx.role === "viewer") throw notFound("Share");
  return row;
}

export async function updateShare(ctx: RequestContext, shareId: string, permission: "view" | "edit") {
  const row = await ownedShare(ctx, shareId);
  if (row.linkToken && permission !== "view") throw badRequest("Share links are always view-only.");
  await db.update(shares).set({ permission }).where(eq(shares.id, shareId));
}

export async function deleteShare(ctx: RequestContext, shareId: string) {
  await ownedShare(ctx, shareId);
  await db.delete(shares).where(eq(shares.id, shareId));
}

/** Lets a grantee remove something that was shared with them. */
export async function leaveShare(ctx: RequestContext, shareId: string) {
  const [row] = await db.select().from(shares).where(eq(shares.id, shareId));
  if (!row || row.granteeUserId !== ctx.userId) throw notFound("Share");
  await db.delete(shares).where(eq(shares.id, shareId));
}

export async function sharedWithMe(ctx: RequestContext): Promise<SharedWithMeItem[]> {
  const rows = await db
    .select({
      id: shares.id,
      resourceType: shares.resourceType,
      resourceId: shares.resourceId,
      permission: shares.permission,
      createdAt: shares.createdAt,
      ownerName: sql<string>`coalesce((select u.name from ${users} u where u.id = ${shares.createdBy}), 'Someone')`,
      title: sql<string>`case ${shares.resourceType}
        when 'collection' then (select name from ${collections} where id = ${shares.resourceId})
        when 'note' then (select coalesce(nullif(title, ''), 'Untitled note') from ${notes} where id = ${shares.resourceId})
        when 'concept' then (select name from ${concepts} where id = ${shares.resourceId}) end`,
    })
    .from(shares)
    .where(eq(shares.granteeUserId, ctx.userId))
    .orderBy(desc(shares.createdAt));
  return rows
    .filter((r) => r.title !== null)
    .map((r) => ({
      shareId: r.id,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      title: r.title,
      permission: r.permission,
      ownerName: r.ownerName,
      createdAt: r.createdAt.toISOString(),
    }));
}

// ---------------------------------------------------------------------------
// Read-only views used for shared collections and public links
// ---------------------------------------------------------------------------

export interface CollectionView {
  id: string;
  name: string;
  description: string;
  color: string | null;
  papers: PaperSummary[];
  access: AccessLevel;
}

export async function collectionView(
  collectionId: string,
  viewerWorkspaceId: string | null,
  access: AccessLevel,
): Promise<CollectionView> {
  const [c] = await db.select().from(collections).where(eq(collections.id, collectionId));
  if (!c) throw notFound("Collection");
  const ids = await collectionPaperIds(collectionId);
  // Summaries resolved against the owner workspace (to include its private papers), with the
  // library state of the viewer's own workspace when they are the owner.
  const owned = await getPaperSummaries(c.workspaceId, ids);
  let papers = owned;
  if (viewerWorkspaceId !== c.workspaceId) {
    const viewerState = new Map(
      viewerWorkspaceId ? (await getPaperSummaries(viewerWorkspaceId, ids)).map((p) => [p.id, p.library]) : [],
    );
    papers = owned.map((p) => ({ ...p, library: viewerState.get(p.id) ?? null }));
  }
  return { id: c.id, name: c.name, description: c.description, color: c.color, papers, access };
}

export async function getByLinkToken(token: string) {
  const [row] = await db.select().from(shares).where(eq(shares.linkToken, token));
  if (!row) throw notFound("Shared item");
  return row;
}
