import { handler, parseBody, rateLimit, requireContext } from "@/server/http";
import { clientErrorSchema, logClientError } from "@/server/client-errors";

/** Errors a page hit in the browser, reported by the error page (see src/server/client-errors.ts). */
export const POST = handler(async (req) => {
  const ctx = await requireContext();
  rateLimit(`client-errors:${ctx.userId}`, 20);
  logClientError(await parseBody(req, clientErrorSchema), req.headers.get("user-agent"));
  return { ok: true };
});
