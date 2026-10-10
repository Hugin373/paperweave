import { z } from "zod";
import { handler, parseQuery, requireContext } from "@/server/http";
import { searchLinkTargets } from "@/server/knowledge/link-targets";

/** Autocomplete for [[links]] in notes and link pickers. */
export const GET = handler(async (req) => {
  const ctx = await requireContext();
  const q = parseQuery(
    req,
    z.object({
      q: z.string().max(200).default(""),
      types: z.string().default("paper,concept,note"),
      exclude: z.string().uuid().optional(),
    }),
  );
  const types = q.types
    .split(",")
    .filter((t): t is "paper" | "concept" | "note" => ["paper", "concept", "note"].includes(t));
  return searchLinkTargets(ctx.workspaceId, q.q, types, 6, q.exclude);
});
