import { z } from "zod";
import { handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { deleteConcept, getConceptDetail, updateConcept } from "@/server/knowledge/concepts";

export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  return getConceptDetail(ctx, uuidParam.parse(id));
});

export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  const body = await parseBody(
    req,
    z.object({
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(10000).optional(),
      aliases: z.array(z.string().trim().max(120)).max(30).optional(),
    }),
  );
  const c = await updateConcept(ctx, uuidParam.parse(id), body);
  return { id: c.id };
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  await deleteConcept(ctx, uuidParam.parse(id));
  return { ok: true };
});
