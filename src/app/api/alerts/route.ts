import { z } from "zod";
import { ALERT_SOURCES, createSavedSearch, listSavedSearches, unseenCount } from "@/server/alerts/service";
import { assertCanWrite, handler, parseBody, rateLimit, requireContext } from "@/server/http";

/** Saved searches with their new-paper counts (and the total for the navigation badge). */
export const GET = handler(async () => {
  const ctx = await requireContext();
  const [searches, unseen] = await Promise.all([listSavedSearches(ctx.workspaceId), unseenCount(ctx.workspaceId)]);
  return { searches, unseen };
});

export const POST = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  rateLimit(`alerts:${ctx.userId}`, 20);
  const body = await parseBody(
    req,
    z.object({ query: z.string().trim().min(2).max(300), source: z.enum(ALERT_SOURCES).default("general") }),
  );
  return createSavedSearch(ctx, body);
});
