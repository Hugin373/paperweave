import { z } from "zod";
import { assertCanWrite, handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { deleteThread, getThread, renameThread } from "@/server/research/service";

export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  return getThread(ctx, uuidParam.parse(id));
});

export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(req, z.object({ title: z.string().trim().min(1).max(200) }));
  await renameThread(ctx, uuidParam.parse(id), body.title);
  return { ok: true };
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  await deleteThread(ctx, uuidParam.parse(id));
  return { ok: true };
});
