import { z } from "zod";
import { assertCanWrite, handler, parseBody, parseQuery, requireContext } from "@/server/http";
import { createConcept, listConcepts } from "@/server/knowledge/concepts";

export const GET = handler(async (req) => {
  const ctx = await requireContext();
  const { q } = parseQuery(req, z.object({ q: z.string().max(200).optional() }));
  return listConcepts(ctx.workspaceId, q);
});

export const POST = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(
    req,
    z.object({
      name: z.string().trim().min(1, "Name is required").max(120),
      description: z.string().max(10000).optional(),
      aliases: z.array(z.string().trim().max(120)).max(30).optional(),
      origin: z.enum(["user", "ai_suggestion"]).optional(),
      paperId: z.string().uuid().optional(),
    }),
  );
  const concept = await createConcept(ctx, body);
  return { id: concept.id, name: concept.name };
});
