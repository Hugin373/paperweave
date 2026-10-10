import { testProvider } from "@/server/ai/config";
import { withProvider } from "@/server/ai/route-helpers";
import { requireContext } from "@/server/http";

/** Verifies the saved AI configuration with a tiny request. */
export async function POST() {
  let ctx;
  try {
    ctx = await requireContext();
  } catch (err) {
    const { errorResponse } = await import("@/server/http");
    return errorResponse(err);
  }
  // Tests the saved default configuration, not a model picked while working.
  return withProvider(
    ctx,
    async (provider) => ({
      ok: true,
      provider: provider.kind,
      model: provider.model,
      reply: await testProvider(provider),
    }),
    { useChoice: false },
  );
}
