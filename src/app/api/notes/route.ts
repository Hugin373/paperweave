import { z } from "zod";
import { assertCanWrite, handler, parseBody, parseQuery, requireContext } from "@/server/http";
import { createNote, listNotes } from "@/server/knowledge/notes";

export const GET = handler(async (req) => {
  const ctx = await requireContext();
  const q = parseQuery(
    req,
    z.object({
      q: z.string().max(300).optional(),
      paperId: z.string().uuid().optional(),
      kind: z.enum(["all", "standalone", "paper"]).default("all"),
    }),
  );
  return listNotes(ctx.workspaceId, q);
});

export const POST = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(
    req,
    z.object({
      title: z.string().max(300).optional(),
      paperId: z.string().uuid().nullable().optional(),
      content: z.unknown().optional(),
    }),
  );
  const note = await createNote(ctx, body);
  return { id: note.id };
});
