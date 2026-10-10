import { withProvider } from "@/server/ai/route-helpers";
import { suggestConcepts } from "@/server/ai/tasks";
import { errorResponse, requireContext, uuidParam } from "@/server/http";
import { listConcepts } from "@/server/knowledge/concepts";

/** AI-suggested concepts for a paper. Suggestions only: nothing is created until the user accepts. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const paperId = uuidParam.parse((await params).id);
    return withProvider(ctx, async (provider) => {
      const existing = await listConcepts(ctx.workspaceId);
      const suggestions = await suggestConcepts(
        provider,
        ctx.workspaceId,
        paperId,
        existing.map((c) => c.name),
      );
      const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
      return {
        suggestions: suggestions.map((s) => ({ ...s, existingConceptId: byName.get(s.name.toLowerCase()) ?? null })),
      };
    });
  } catch (err) {
    return errorResponse(err);
  }
}
