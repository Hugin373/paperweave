import { z } from "zod";
import { RESEARCH_MODES, RESEARCH_ORIGINS } from "@/lib/types";
import { readerContextSchema } from "@/server/research/schemas";
import { assertCanWrite, handler, parseBody, rateLimit, requireContext } from "@/server/http";
import { requestAiChoice } from "@/server/ai/route-helpers";
import { createThread, listThreads } from "@/server/research/service";

/** Conversations, newest first; ?origin=reader&paperId=… lists the reader conversations about a paper. */
export const GET = handler(async (req) => {
  const ctx = await requireContext();
  const params = new URL(req.url).searchParams;
  const filter = z
    .object({ origin: z.enum(RESEARCH_ORIGINS).optional(), paperId: z.string().uuid().optional() })
    .parse({ origin: params.get("origin") ?? undefined, paperId: params.get("paperId") ?? undefined });
  return listThreads(ctx, filter);
});

/** Starts an assistant conversation; the answer is produced in the background. */
export const POST = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  rateLimit(`ai:${ctx.userId}`, 30);
  const body = await parseBody(
    req,
    z.object({
      question: z.string().trim().min(3, "Please describe what to research.").max(4000),
      mode: z.enum(RESEARCH_MODES).default("chat"),
      autoApply: z.boolean().default(false),
      scope: z
        .object({
          paperIds: z.array(z.string().uuid()).max(30).default([]),
          collectionId: z.string().uuid().nullable().default(null),
        })
        .optional(),
      origin: z.enum(RESEARCH_ORIGINS).default("assistant"),
      context: readerContextSchema.optional(),
    }),
  );
  return createThread(ctx, { ...body, choice: await requestAiChoice() });
});
