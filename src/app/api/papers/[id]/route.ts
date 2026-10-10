import { handler, requireContext, uuidParam } from "@/server/http";
import { getPaperDetail } from "@/server/papers/service";

export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  return getPaperDetail(ctx.workspaceId, uuidParam.parse(id));
});
