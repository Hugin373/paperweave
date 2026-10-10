import { z } from "zod";
import { badRequest, handler, parseQuery, requireContext } from "@/server/http";
import { focusedGraph, workspaceGraph } from "@/server/graph/knowledge-graph";

export const GET = handler(async (req) => {
  const ctx = await requireContext();
  const q = parseQuery(
    req,
    z.object({
      focus: z.string().optional(),
      depth: z.coerce.number().int().min(1).max(3).default(1),
      archived: z.enum(["true", "false"]).optional(),
      collectionId: z.string().uuid().optional(),
      citations: z.enum(["true", "false"]).optional(),
    }),
  );
  const opts = {
    includeArchived: q.archived === "true",
    collectionId: q.collectionId,
    includeCitations: q.citations !== "false",
  };
  if (q.focus) {
    const m = /^(paper|concept|note):([0-9a-f-]{36})$/i.exec(q.focus);
    if (!m) throw badRequest("Invalid focus.");
    return focusedGraph(ctx.workspaceId, { type: m[1] as "paper" | "concept" | "note", id: m[2] }, q.depth, opts);
  }
  return workspaceGraph(ctx.workspaceId, opts);
});
