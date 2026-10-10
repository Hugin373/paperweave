import { z } from "zod";
import { withProvider } from "@/server/ai/route-helpers";
import { streamCompletion } from "@/server/ai/stream";
import { NOTE_ACTIONS, noteAssistRequest } from "@/server/ai/tasks";
import { errorResponse, parseBody, requireContext } from "@/server/http";

/** Note assistance: summarize, rewrite, explain, organize, suggest links, or ask. */
export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await parseBody(
      req,
      z.object({
        action: z.enum(Object.keys(NOTE_ACTIONS) as [keyof typeof NOTE_ACTIONS]),
        text: z.string().trim().min(1, "The note is empty.").max(60000),
        question: z.string().max(2000).optional(),
      }),
    );
    return withProvider(ctx, async (provider) =>
      streamCompletion(provider, await noteAssistRequest(ctx.workspaceId, body)),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
