import { z } from "zod";
import { assertCanWrite, handler, parseBody, requireContext } from "@/server/http";
import { ensureTags, listTags } from "@/server/library/organize";

export const GET = handler(async () => {
  const ctx = await requireContext();
  return listTags(ctx.workspaceId);
});

export const POST = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const { name } = await parseBody(req, z.object({ name: z.string().trim().min(1).max(60) }));
  const [tag] = await ensureTags(ctx.workspaceId, [name]);
  return tag;
});
