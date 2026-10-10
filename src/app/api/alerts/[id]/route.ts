import { deleteSavedSearch, savedSearchResultsOf } from "@/server/alerts/service";
import { assertCanWrite, handler, requireContext, uuidParam } from "@/server/http";

export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  return savedSearchResultsOf(ctx.workspaceId, uuidParam.parse(id));
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  await deleteSavedSearch(ctx.workspaceId, uuidParam.parse(id));
  return { ok: true };
});
