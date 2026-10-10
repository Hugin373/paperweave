import { handler, rateLimit, requireContext, uuidParam } from "@/server/http";
import { openReviewForPaper } from "@/server/papers/openreview";

/** The paper's OpenReview record (venue, decision, reviews), or null when it has none. */
export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  rateLimit(`openreview:${ctx.userId}`, 60);
  return (await openReviewForPaper(ctx.workspaceId, uuidParam.parse(id))) ?? { forumId: null };
});
