import { z } from "zod";
import { handler, parseBody, parseQuery, rateLimit, requireContext } from "@/server/http";
import { createShare, listShares } from "@/server/sharing/shares";

const resource = z.enum(["collection", "note", "concept"]);

export const GET = handler(async (req) => {
  const ctx = await requireContext();
  const q = parseQuery(req, z.object({ resourceType: resource, resourceId: z.string().uuid() }));
  return listShares(ctx, q.resourceType, q.resourceId);
});

export const POST = handler(async (req) => {
  const ctx = await requireContext();
  rateLimit(`share:${ctx.userId}`, 30);
  const body = await parseBody(
    req,
    z.object({
      resourceType: resource,
      resourceId: z.string().uuid(),
      email: z.string().email().max(300).optional(),
      permission: z.enum(["view", "edit"]).default("view"),
      link: z.boolean().optional(),
    }),
  );
  return createShare(ctx, body);
});
