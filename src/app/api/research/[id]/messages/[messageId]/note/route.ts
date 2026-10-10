import { assertCanWrite, handler, requireContext, uuidParam } from "@/server/http";
import { saveAnswerAsNote } from "@/server/research/service";

/** Saves a research answer as a note linked to the sources it cites. */
export const POST = handler<{ id: string; messageId: string }>(async (_req, { id, messageId }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  return saveAnswerAsNote(ctx, uuidParam.parse(id), uuidParam.parse(messageId));
});
