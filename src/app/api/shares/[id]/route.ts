import { z } from "zod";
import { handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { deleteShare, updateShare } from "@/server/sharing/shares";

export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  const { permission } = await parseBody(req, z.object({ permission: z.enum(["view", "edit"]) }));
  await updateShare(ctx, uuidParam.parse(id), permission);
  return { ok: true };
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  await deleteShare(ctx, uuidParam.parse(id));
  return { ok: true };
});
