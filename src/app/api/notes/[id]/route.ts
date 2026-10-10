import { z } from "zod";
import { handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { deleteNote, getNoteDetail, updateNote } from "@/server/knowledge/notes";

export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  return getNoteDetail(ctx, uuidParam.parse(id));
});

export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  const body = await parseBody(
    req,
    z.object({
      title: z.string().max(300).optional(),
      content: z.unknown().optional(),
      paperId: z.string().uuid().nullable().optional(),
      baseUpdatedAt: z.string().datetime().optional(),
    }),
  );
  const note = await updateNote(ctx, uuidParam.parse(id), body);
  return { id: note.id, updatedAt: note.updatedAt.toISOString() };
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  await deleteNote(ctx, uuidParam.parse(id));
  return { ok: true };
});
