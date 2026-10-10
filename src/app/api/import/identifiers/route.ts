import { z } from "zod";
import { assertCanWrite, handler, parseBody, rateLimit, requireContext } from "@/server/http";
import { startIdentifierImport } from "@/server/import/import";

/** Imports a list of DOIs / arXiv ids / URLs (one per line). Runs as a background job. */
export const POST = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  rateLimit(`import:${ctx.userId}`, 10);
  const body = await parseBody(
    req,
    z.object({ text: z.string().min(1).max(200_000), collectionId: z.string().uuid().nullable().optional() }),
  );
  return startIdentifierImport(ctx, body.text, body.collectionId ?? null);
});
