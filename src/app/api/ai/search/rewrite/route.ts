import { z } from "zod";
import { withProvider } from "@/server/ai/route-helpers";
import { rewriteSearchQuery } from "@/server/ai/tasks";
import { AIError } from "@/server/ai/types";
import { errorResponse, parseBody, requireContext } from "@/server/http";

/** Rewrites a natural-language research question into a scholarly search query. */
export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const { question } = await parseBody(req, z.object({ question: z.string().trim().min(1).max(1000) }));
    return withProvider(ctx, async (provider) => {
      const out = await rewriteSearchQuery(provider, question);
      if (!out) throw new AIError("bad_request", "The AI response could not be used as a search query.");
      return out;
    });
  } catch (err) {
    return errorResponse(err);
  }
}
