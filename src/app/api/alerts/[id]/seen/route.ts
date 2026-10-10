import { markSearchSeen } from "@/server/alerts/service";
import { handler, requireContext, uuidParam } from "@/server/http";

/** The user has looked at a saved search's new papers. */
export const POST = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  await markSearchSeen(ctx.workspaceId, uuidParam.parse(id));
  return { ok: true };
});
