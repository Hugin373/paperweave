import { and, eq } from "drizzle-orm";
import type { AccessLevel } from "@/lib/types";
import { db } from "@/server/db/client";
import { shares } from "@/server/db/schema";
import { forbidden, notFound, type RequestContext } from "@/server/http";

export type ShareResource = "collection" | "note" | "concept";

/**
 * Determines what the current user may do with a resource owned by `ownerWorkspaceId`.
 * Members of the owning workspace get full access (read-only for viewers); everyone else
 * needs an explicit share. Returns null when the user has no access at all.
 */
export async function accessFor(
  ctx: RequestContext,
  resourceType: ShareResource,
  resourceId: string,
  ownerWorkspaceId: string,
): Promise<AccessLevel | null> {
  if (ownerWorkspaceId === ctx.workspaceId) return ctx.role === "viewer" ? "view" : "owner";
  const [share] = await db
    .select({ permission: shares.permission })
    .from(shares)
    .where(
      and(
        eq(shares.resourceType, resourceType),
        eq(shares.resourceId, resourceId),
        eq(shares.granteeUserId, ctx.userId),
      ),
    );
  return share?.permission ?? null;
}

/** Like accessFor, but throws 404 (no access) or 403 (insufficient access). */
export async function requireAccess(
  ctx: RequestContext,
  resourceType: ShareResource,
  resourceId: string,
  ownerWorkspaceId: string,
  needed: "view" | "edit" | "owner",
  what: string,
): Promise<AccessLevel> {
  const access = await accessFor(ctx, resourceType, resourceId, ownerWorkspaceId);
  // Never reveal the existence of resources the user cannot see.
  if (!access) throw notFound(what);
  const rank = { view: 0, edit: 1, owner: 2 } as const;
  if (rank[access] < rank[needed]) {
    throw forbidden(
      needed === "owner" ? `Only the owner can do that.` : `You have read-only access to this ${what.toLowerCase()}.`,
    );
  }
  return access;
}
