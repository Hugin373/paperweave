import { z } from "zod";
import { toFileInfo } from "@/server/files/info";
import { checkForNewVersion } from "@/server/files/service";
import { assertCanWrite, handler, parseBody, rateLimit, requireContext, uuidParam } from "@/server/http";

/**
 * Checks a free PDF's source for a newer version and moves to it (with its highlights). The reader
 * calls this when it opens; `force` (the "Check for a new version" button) skips the recent-check window.
 */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const { force } = await parseBody(req, z.object({ force: z.boolean().default(false) }));
  if (force) rateLimit(`pdf-check:${ctx.userId}`, 20);
  const { file, updated } = await checkForNewVersion(ctx.workspaceId, uuidParam.parse(id), { force });
  return { file: toFileInfo(file), updated };
});
