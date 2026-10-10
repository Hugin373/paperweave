import { z } from "zod";
import { db } from "@/server/db/client";
import { collections } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { handler, notFound, parseBody, requireContext, uuidParam } from "@/server/http";
import { deleteCollection, updateCollection } from "@/server/library/organize";
import { requireAccess } from "@/server/sharing/access";
import { collectionView } from "@/server/sharing/shares";

async function owner(id: string) {
  const [row] = await db.select({ ws: collections.workspaceId }).from(collections).where(eq(collections.id, id));
  if (!row) throw notFound("Collection");
  return row.ws;
}

/** Collection detail for its owner or anyone it was shared with. */
export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  const cid = uuidParam.parse(id);
  const access = await requireAccess(ctx, "collection", cid, await owner(cid), "view", "Collection");
  return collectionView(cid, ctx.workspaceId, access);
});

export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  const cid = uuidParam.parse(id);
  await requireAccess(ctx, "collection", cid, await owner(cid), "owner", "Collection");
  const body = await parseBody(
    req,
    z.object({
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().max(2000).optional(),
      color: z.string().max(20).nullable().optional(),
    }),
  );
  return updateCollection(ctx.workspaceId, cid, body);
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  const cid = uuidParam.parse(id);
  await requireAccess(ctx, "collection", cid, await owner(cid), "owner", "Collection");
  await deleteCollection(ctx.workspaceId, cid);
  return { ok: true };
});
