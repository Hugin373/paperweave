import { checkSavedSearchNow } from "@/server/alerts/service";
import { assertCanWrite, handler, rateLimit, requireContext, uuidParam } from "@/server/http";

/** Runs a saved search now instead of waiting for the daily run. */
export const POST = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  rateLimit(`alerts-check:${ctx.userId}`, 10);
  return checkSavedSearchNow(ctx.workspaceId, uuidParam.parse(id));
});
