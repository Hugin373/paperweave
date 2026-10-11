import { handler, rateLimit, requireContext } from "@/server/http";
import { refreshTopicSuggestions, topicSuggestions } from "@/server/search/suggestions";

/** Personal search suggestions for the search page (AI ideas are made in the background). */
export const GET = handler(async () => {
  const ctx = await requireContext();
  return topicSuggestions(ctx.workspaceId);
});

/** "New ideas": think up fresh AI suggestions. */
export const POST = handler(async () => {
  const ctx = await requireContext();
  rateLimit(`topic-suggestions:${ctx.userId}`, 6);
  await refreshTopicSuggestions(ctx.workspaceId);
  return { ok: true };
});
