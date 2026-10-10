import { z } from "zod";
import { detectIdentifier } from "@/lib/identifiers";
import { badRequest, handler, notFound, parseBody, rateLimit, requireContext } from "@/server/http";
import { resolveIdentifier } from "@/server/papers/service";

/** Resolves a DOI / arXiv id / URL to an internal paper id, fetching metadata if needed. */
export const POST = handler(async (req) => {
  const ctx = await requireContext();
  rateLimit(`resolve:${ctx.userId}`, 60);
  const { identifier } = await parseBody(req, z.object({ identifier: z.string().trim().min(1).max(500) }));
  if (!detectIdentifier(identifier))
    throw badRequest("That doesn't look like a DOI, arXiv id or other supported identifier.");
  const id = await resolveIdentifier(identifier);
  if (!id) throw notFound("No paper with that identifier");
  return { id };
});
