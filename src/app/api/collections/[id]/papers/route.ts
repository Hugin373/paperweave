import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { collections } from "@/server/db/schema";
import { handler, notFound, parseBody, requireContext, uuidParam } from "@/server/http";
import { addToCollection, removeFromCollection } from "@/server/library/organize";
import { getVisiblePaper } from "@/server/papers/service";
import { requireAccess } from "@/server/sharing/access";

const body = z.object({ paperIds: z.array(z.string().uuid()).min(1).max(500) });

/**
 * Adds/removes papers. Owners and people with edit access can change a collection; changes
 * always apply to the owner's workspace.
 */
async function authorize(id: string) {
  const ctx = await requireContext();
  const cid = uuidParam.parse(id);
  const [row] = await db.select().from(collections).where(eq(collections.id, cid));
  if (!row) throw notFound("Collection");
  await requireAccess(ctx, "collection", cid, row.workspaceId, "edit", "Collection");
  return { ctx, collection: row };
}

export const POST = handler<{ id: string }>(async (req, { id }) => {
  const { ctx, collection } = await authorize(id);
  const { paperIds } = await parseBody(req, body);
  // Editors can only add papers they can see themselves (scholarly papers or their own).
  for (const pid of paperIds) await getVisiblePaper(ctx.workspaceId, pid);
  await addToCollection(collection.workspaceId, ctx.userId, collection.id, paperIds);
  return { ok: true };
});

export const DELETE = handler<{ id: string }>(async (req, { id }) => {
  const { collection } = await authorize(id);
  const { paperIds } = await parseBody(req, body);
  await removeFromCollection(collection.workspaceId, collection.id, paperIds);
  return { ok: true };
});
