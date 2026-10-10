import { z } from "zod";
import { withProvider } from "@/server/ai/route-helpers";
import { contextBudget } from "@/server/ai/paper-text";
import { streamCompletion } from "@/server/ai/stream";
import { paperQuestionRequest } from "@/server/ai/tasks";
import { errorResponse, parseBody, requireContext, uuidParam } from "@/server/http";

/** Answers a question about the paper, grounded in its full text when available (see paper-text.ts). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const paperId = uuidParam.parse((await params).id);
    const body = await parseBody(
      req,
      z.object({
        question: z.string().trim().min(1).max(4000),
        history: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) }))
          .max(20)
          .default([]),
      }),
    );
    return withProvider(ctx, async (provider) => {
      const { request, basis } = await paperQuestionRequest(
        ctx.workspaceId,
        paperId,
        body.question,
        body.history,
        contextBudget(provider).question,
      );
      return streamCompletion(provider, request, undefined, { basis });
    });
  } catch (err) {
    return errorResponse(err);
  }
}
