import { handler, rateLimit, requireContext, uuidParam } from "@/server/http";
import { getVisiblePaper, identifiersFor, refreshPaperIfStale } from "@/server/papers/service";

/** Re-fetches metadata from scholarly sources (fill-in only; never overwrites existing values). */
export const POST = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  rateLimit(`refresh:${ctx.userId}`, 20);
  const paper = await getVisiblePaper(ctx.workspaceId, uuidParam.parse(id));
  const ids = (await identifiersFor([paper.id])).get(paper.id) ?? {};
  const updated = await refreshPaperIfStale(paper, ids, true);
  return { updated };
});
