import { z } from "zod";
import { assertCanWrite, handler, parseBody, requireContext } from "@/server/http";
import { createCollection, listCollections } from "@/server/library/organize";

export const GET = handler(async () => {
  const ctx = await requireContext();
  return listCollections(ctx.workspaceId);
});

export const POST = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(
    req,
    z.object({
      name: z.string().trim().min(1, "Name is required").max(100),
      description: z.string().max(2000).optional(),
      color: z.string().max(20).nullable().optional(),
    }),
  );
  return createCollection(ctx.workspaceId, body);
});
