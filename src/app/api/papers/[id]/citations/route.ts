import { z } from "zod";
import { handler, parseQuery, rateLimit, requireContext, uuidParam } from "@/server/http";
import { listCitationEdges } from "@/server/papers/citations";

export const GET = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  rateLimit(`citations:${ctx.userId}`, 60);
  const { offset } = parseQuery(req, z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0) }));
  return listCitationEdges(ctx.workspaceId, uuidParam.parse(id), "citations", offset);
});
