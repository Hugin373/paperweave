import { z } from "zod";
import { READING_STATUSES } from "@/lib/types";
import { assertCanWrite, handler, parseBody, requireContext } from "@/server/http";
import { removeFromLibrary, savePaper, setStatus } from "@/server/library/library";
import { addToCollection, removeFromCollection, tagPapers } from "@/server/library/organize";

const ids = z.array(z.string().uuid()).min(1).max(500);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), paperIds: ids }),
  z.object({ action: z.literal("status"), paperIds: ids, status: z.enum(READING_STATUSES) }),
  z.object({ action: z.literal("remove"), paperIds: ids }),
  z.object({
    action: z.literal("tag"),
    paperIds: ids,
    tagIds: z.array(z.string().uuid()).max(50).default([]),
    tagNames: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  }),
  z.object({ action: z.literal("untag"), paperIds: ids, tagIds: z.array(z.string().uuid()).min(1).max(50) }),
  z.object({ action: z.literal("collect"), paperIds: ids, collectionId: z.string().uuid() }),
  z.object({ action: z.literal("uncollect"), paperIds: ids, collectionId: z.string().uuid() }),
]);

/** Bulk organization of library papers. */
export const POST = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(req, schema);
  switch (body.action) {
    case "save":
      for (const id of body.paperIds) await savePaper(ctx.workspaceId, ctx.userId, id);
      break;
    case "status":
      await setStatus(ctx.workspaceId, body.paperIds, body.status);
      break;
    case "remove":
      await removeFromLibrary(ctx.workspaceId, body.paperIds);
      break;
    case "tag":
      await tagPapers(ctx.workspaceId, ctx.userId, body.paperIds, { tagIds: body.tagIds, names: body.tagNames });
      break;
    case "untag":
      await tagPapers(ctx.workspaceId, ctx.userId, body.paperIds, {}, body.tagIds);
      break;
    case "collect":
      await addToCollection(ctx.workspaceId, ctx.userId, body.collectionId, body.paperIds);
      break;
    case "uncollect":
      await removeFromCollection(ctx.workspaceId, body.collectionId, body.paperIds);
      break;
  }
  return { ok: true };
});
