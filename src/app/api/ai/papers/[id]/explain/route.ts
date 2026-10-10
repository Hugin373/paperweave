import { z } from "zod";
import { withProvider } from "@/server/ai/route-helpers";
import { streamCompletion } from "@/server/ai/stream";
import { explainSelectionRequest } from "@/server/ai/tasks";
import { errorResponse, parseBody, requireContext, uuidParam } from "@/server/http";

/** Explains (or answers a question about) a passage selected in the reader. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const paperId = uuidParam.parse((await params).id);
    const body = await parseBody(
      req,
      z.object({
        text: z.string().trim().min(1).max(8000),
        pageNumber: z.number().int().min(1).optional(),
        question: z.string().max(2000).optional(),
      }),
    );
    return withProvider(ctx, async (provider) =>
      streamCompletion(provider, await explainSelectionRequest(ctx.workspaceId, paperId, body)),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
