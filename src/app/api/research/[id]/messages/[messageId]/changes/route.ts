import { z } from "zod";
import { assertCanWrite, handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { updateChanges } from "@/server/research/service";

/** Applies (all or some), undoes or dismisses the workspace changes an answer proposed. */
export const POST = handler<{ id: string; messageId: string }>(async (req, { id, messageId }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(
    req,
    z.object({
      action: z.enum(["apply", "undo", "dismiss"]),
      itemIds: z.array(z.string().uuid()).max(100).optional(),
      names: z.record(z.string().uuid(), z.string().max(300)).optional(),
    }),
  );
  return updateChanges(ctx, uuidParam.parse(id), uuidParam.parse(messageId), body);
});
