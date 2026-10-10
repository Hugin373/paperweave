import { z } from "zod";
import { withProvider } from "@/server/ai/route-helpers";
import { streamCompletion } from "@/server/ai/stream";
import { citationExplainRequest } from "@/server/ai/tasks";
import { errorResponse, parseBody, requireContext } from "@/server/http";

/** Explains the relationship between a citing and a cited paper. */
export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await parseBody(req, z.object({ citingId: z.string().uuid(), citedId: z.string().uuid() }));
    return withProvider(ctx, async (provider) =>
      streamCompletion(provider, await citationExplainRequest(ctx.workspaceId, body.citingId, body.citedId)),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
