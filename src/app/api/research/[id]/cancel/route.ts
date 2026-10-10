import { assertCanWrite, handler, requireContext, uuidParam } from "@/server/http";
import { cancelRun } from "@/server/research/service";

/** Stops the thread's running research. */
export const POST = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  await cancelRun(ctx, uuidParam.parse(id));
  return { ok: true };
});
