import { z } from "zod";
import { READING_STATUSES } from "@/lib/types";
import { assertCanWrite, handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { removeFromLibrary, savePaper, setStatus } from "@/server/library/library";

/** Saves the paper (or updates its reading status). */
export const PUT = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const { status } = await parseBody(req, z.object({ status: z.enum(READING_STATUSES).default("saved") }));
  const paperId = uuidParam.parse(id);
  await savePaper(ctx.workspaceId, ctx.userId, paperId, status);
  await setStatus(ctx.workspaceId, [paperId], status);
  return { ok: true };
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  await removeFromLibrary(ctx.workspaceId, [uuidParam.parse(id)]);
  return { ok: true };
});
