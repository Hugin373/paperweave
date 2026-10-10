import { z } from "zod";
import { assertCanWrite, handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { deleteTag, updateTag } from "@/server/library/organize";

export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(
    req,
    z.object({ name: z.string().trim().min(1).max(60).optional(), color: z.string().max(20).nullable().optional() }),
  );
  return updateTag(ctx.workspaceId, uuidParam.parse(id), body);
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  await deleteTag(ctx.workspaceId, uuidParam.parse(id));
  return { ok: true };
});
