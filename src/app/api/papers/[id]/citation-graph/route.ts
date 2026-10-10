import { z } from "zod";
import { citationGraph } from "@/server/graph/citation-graph";
import { handler, parseQuery, rateLimit, requireContext, uuidParam } from "@/server/http";

export const GET = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  rateLimit(`citations:${ctx.userId}`, 60);
  const q = parseQuery(
    req,
    z.object({
      refs: z.coerce.number().int().min(0).max(60).default(20),
      cites: z.coerce.number().int().min(0).max(60).default(20),
    }),
  );
  return citationGraph(ctx.workspaceId, uuidParam.parse(id), { references: q.refs, citations: q.cites });
});
