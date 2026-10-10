import { z } from "zod";
import { assertCanWrite, handler, parseBody, rateLimit, requireContext, uuidParam } from "@/server/http";
import { findArxivTwin, linkArxivVersion } from "@/server/papers/arxiv-twin";
import { getVisiblePaper } from "@/server/papers/service";

/**
 * Links a paper to its arXiv version: the id or link the user gives, or (without one) a search by title.
 * The paper then gets the arXiv authors, abstract and free PDF.
 */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  rateLimit(`arxiv-link:${ctx.userId}`, 10);
  const paperId = uuidParam.parse(id);
  const { arxiv } = await parseBody(req, z.object({ arxiv: z.string().trim().max(300).optional() }));
  if (arxiv) return { arxiv: await linkArxivVersion(ctx.workspaceId, paperId, arxiv) };
  await getVisiblePaper(ctx.workspaceId, paperId);
  return { arxiv: await findArxivTwin(paperId) };
});
