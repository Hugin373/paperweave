import { z } from "zod";
import { withProvider } from "@/server/ai/route-helpers";
import { streamCompletion } from "@/server/ai/stream";
import { searchSummaryRequest } from "@/server/ai/tasks";
import { errorResponse, parseBody, requireContext } from "@/server/http";

/** Summarizes a page of search results (titles + abstracts only). */
export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await parseBody(
      req,
      z.object({ question: z.string().trim().min(1).max(1000), paperIds: z.array(z.string().uuid()).min(1).max(12) }),
    );
    return withProvider(ctx, async (provider) =>
      streamCompletion(provider, await searchSummaryRequest(ctx.workspaceId, body.question, body.paperIds)),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
