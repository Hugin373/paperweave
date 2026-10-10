import { z } from "zod";
import { assertCanWrite, handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { decide } from "@/server/screening/service";

/** The user's decision for one paper (replaces the AI's). */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(
    req,
    z.object({ paperId: z.string().uuid(), decision: z.enum(["include", "exclude", "maybe"]) }),
  );
  await decide(ctx.workspaceId, uuidParam.parse(id), body.paperId, body.decision);
  return { ok: true };
});
