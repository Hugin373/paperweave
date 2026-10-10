import { z } from "zod";
import { handler, parseQuery, requireContext } from "@/server/http";
import { searchWorkspace } from "@/server/search/workspace-search";

/** Searches the user's own knowledge (not external literature). */
export const GET = handler(async (req) => {
  const ctx = await requireContext();
  const { q } = parseQuery(req, z.object({ q: z.string().max(300).default("") }));
  return searchWorkspace(ctx.workspaceId, q);
});
