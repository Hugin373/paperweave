import { z } from "zod";
import { withProvider } from "@/server/ai/route-helpers";
import { contextBudget } from "@/server/ai/paper-text";
import { streamCompletion } from "@/server/ai/stream";
import { latestPaperResults, PAPER_ANALYSES, paperAnalysisRequest, saveAiResult } from "@/server/ai/tasks";
import { errorResponse, handler, parseBody, requireContext, uuidParam } from "@/server/http";

/** Previously generated (and stored) AI analyses of this paper. */
export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  return latestPaperResults(ctx.workspaceId, uuidParam.parse(id));
});

/** Generates (streams) a summary / key contributions / prerequisites analysis and stores it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const paperId = uuidParam.parse((await params).id);
    const { kind } = await parseBody(
      req,
      z.object({ kind: z.enum(Object.keys(PAPER_ANALYSES) as [keyof typeof PAPER_ANALYSES]) }),
    );
    return withProvider(ctx, async (provider) => {
      const { request, basis } = await paperAnalysisRequest(
        ctx.workspaceId,
        paperId,
        kind,
        contextBudget(provider).whole,
      );
      return streamCompletion(
        provider,
        request,
        (content) =>
          saveAiResult({ workspaceId: ctx.workspaceId, userId: ctx.userId, paperId, kind, content, provider, basis }),
        { basis },
      );
    });
  } catch (err) {
    return errorResponse(err);
  }
}
