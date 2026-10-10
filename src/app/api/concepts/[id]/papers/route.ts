import { z } from "zod";
import { handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { linkPaper, unlinkPaper } from "@/server/knowledge/concepts";

const body = z.object({ paperId: z.string().uuid() });

/** Links a paper to the concept. */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  const { paperId } = await parseBody(req, body);
  await linkPaper(ctx, uuidParam.parse(id), paperId);
  return { ok: true };
});

export const DELETE = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  const { paperId } = await parseBody(req, body);
  await unlinkPaper(ctx, uuidParam.parse(id), paperId);
  return { ok: true };
});
