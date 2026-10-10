import { withProvider } from "@/server/ai/route-helpers";
import { assertCanWrite, errorResponse, requireContext, uuidParam } from "@/server/http";
import { rankAnswerSources } from "@/server/research/service";

/** Ranks a finished answer's cited sources with the AI (reading order and priority), and stores it. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  try {
    const ctx = await requireContext();
    assertCanWrite(ctx);
    const { id, messageId } = await params;
    return withProvider(ctx, (provider) =>
      rankAnswerSources(ctx, uuidParam.parse(id), uuidParam.parse(messageId), provider),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
