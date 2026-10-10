import { z } from "zod";
import { toFileInfo } from "@/server/files/info";
import { deleteFile, dismissVersionNotice, getWorkspaceFile, setFileLive, streamFile } from "@/server/files/service";
import { assertCanWrite, handler, parseBody, rateLimit, requireContext, uuidParam } from "@/server/http";

/**
 * Streams a PDF to an authorized workspace member (supports Range requests): a stored PDF from
 * storage, a live one from its source. `?download=1` saves it as a file.
 */
export const GET = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  const file = await getWorkspaceFile(ctx.workspaceId, uuidParam.parse(id));
  const download = new URL(req.url).searchParams.get("download") === "1";
  return streamFile(file, req.headers.get("range"), download);
});

export const DELETE = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  await deleteFile(ctx.workspaceId, uuidParam.parse(id));
  return { ok: true };
});

/** `live` switches a free PDF between live and stored; `dismissNotice` hides the new-version notice. */
export const PATCH = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const fileId = uuidParam.parse(id);
  const body = await parseBody(
    req,
    z.object({ live: z.boolean().optional(), dismissNotice: z.literal(true).optional() }),
  );
  if (body.dismissNotice) await dismissVersionNotice(ctx.workspaceId, fileId);
  if (body.live !== undefined) {
    rateLimit(`pdf:${ctx.userId}`, 20);
    await setFileLive(ctx.workspaceId, fileId, body.live);
  }
  return toFileInfo(await getWorkspaceFile(ctx.workspaceId, fileId));
});
