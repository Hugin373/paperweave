import { z } from "zod";
import { deleteHighlight, updateHighlight } from "@/server/files/highlights";
import { assertCanWrite, handler, parseBody, requireContext, uuidParam } from "@/server/http";

export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(
    req,
    z.object({
      color: z.enum(["yellow", "green", "blue", "pink", "purple"]).optional(),
      comment: z.string().max(10000).optional(),
    }),
  );
  return updateHighlight(ctx.workspaceId, uuidParam.parse(id), body);
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  await deleteHighlight(ctx.workspaceId, uuidParam.parse(id));
  return { ok: true };
});
