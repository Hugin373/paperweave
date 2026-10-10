import { z } from "zod";
import { assertCanWrite, handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { deleteScreening, screeningDetail, setScreeningRunning } from "@/server/screening/service";

export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  return screeningDetail(ctx.workspaceId, uuidParam.parse(id));
});

/** Pause or resume. */
export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const { running } = await parseBody(req, z.object({ running: z.boolean() }));
  return { status: await setScreeningRunning(ctx.workspaceId, uuidParam.parse(id), running) };
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  await deleteScreening(ctx.workspaceId, uuidParam.parse(id));
  return { ok: true };
});
