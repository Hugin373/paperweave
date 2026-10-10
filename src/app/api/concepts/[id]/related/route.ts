import { z } from "zod";
import { handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { relateConcepts } from "@/server/knowledge/concepts";

const body = z.object({ conceptId: z.string().uuid() });

export const POST = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  const { conceptId } = await parseBody(req, body);
  await relateConcepts(ctx, uuidParam.parse(id), conceptId, true);
  return { ok: true };
});

export const DELETE = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  const { conceptId } = await parseBody(req, body);
  await relateConcepts(ctx, uuidParam.parse(id), conceptId, false);
  return { ok: true };
});
