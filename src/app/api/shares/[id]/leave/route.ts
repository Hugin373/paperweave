import { handler, requireContext, uuidParam } from "@/server/http";
import { leaveShare } from "@/server/sharing/shares";

/** Removes an item someone shared with the current user from their "Shared with me" list. */
export const POST = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  await leaveShare(ctx, uuidParam.parse(id));
  return { ok: true };
});
