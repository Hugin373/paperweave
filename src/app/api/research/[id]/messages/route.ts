import { z } from "zod";
import { RESEARCH_MODES } from "@/lib/types";
import { assertCanWrite, handler, parseBody, rateLimit, requireContext, uuidParam } from "@/server/http";
import { requestAiChoice } from "@/server/ai/route-helpers";
import { readerContextSchema } from "@/server/research/schemas";
import { askFollowUp } from "@/server/research/service";

/** Sends a follow-up message in an assistant conversation. */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  rateLimit(`ai:${ctx.userId}`, 30);
  const body = await parseBody(
    req,
    z.object({
      question: z.string().trim().min(1).max(4000),
      mode: z.enum(RESEARCH_MODES).default("chat"),
      autoApply: z.boolean().default(false),
      context: readerContextSchema.optional(),
    }),
  );
  return askFollowUp(ctx, uuidParam.parse(id), { ...body, choice: await requestAiChoice() });
});
