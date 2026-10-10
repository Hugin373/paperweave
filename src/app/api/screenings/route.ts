import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { savedSearches, savedSearchResults } from "@/server/db/schema";
import { assertCanWrite, badRequest, handler, notFound, parseBody, rateLimit, requireContext } from "@/server/http";
import { collectionPaperIds, getOwnedCollection } from "@/server/library/organize";
import { createScreening, listScreenings, MAX_SCREENED } from "@/server/screening/service";

export const GET = handler(async () => {
  const ctx = await requireContext();
  return listScreenings(ctx.workspaceId);
});

/** Starts a screening of a collection, a saved search's papers, or given papers. */
export const POST = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  rateLimit(`screening:${ctx.userId}`, 10);
  const body = await parseBody(
    req,
    z.object({
      title: z.string().trim().min(1).max(200),
      criteria: z.string().trim().min(10).max(8000),
      collectionId: z.string().uuid().optional(),
      savedSearchId: z.string().uuid().optional(),
      paperIds: z.array(z.string().uuid()).max(MAX_SCREENED).optional(),
      useFullText: z.boolean().default(false),
    }),
  );
  let paperIds = body.paperIds ?? [];
  if (body.collectionId) {
    await getOwnedCollection(ctx.workspaceId, body.collectionId);
    paperIds = [...paperIds, ...(await collectionPaperIds(body.collectionId))];
  }
  if (body.savedSearchId) {
    const [search] = await db
      .select({ id: savedSearches.id })
      .from(savedSearches)
      .where(and(eq(savedSearches.id, body.savedSearchId), eq(savedSearches.workspaceId, ctx.workspaceId)));
    if (!search) throw notFound("Saved search");
    const rows = await db
      .select({ id: savedSearchResults.paperId })
      .from(savedSearchResults)
      .where(eq(savedSearchResults.searchId, search.id));
    paperIds = [...paperIds, ...rows.map((r) => r.id)];
  }
  if (!paperIds.length) throw badRequest("Choose a collection, a saved search or papers to screen.");
  return createScreening(ctx, { title: body.title, criteria: body.criteria, paperIds, useFullText: body.useFullText });
});
