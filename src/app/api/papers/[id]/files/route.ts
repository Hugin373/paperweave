import { z } from "zod";
import { attachPdfFromUrl, uploadPdf } from "@/server/files/service";
import { assertCanWrite, badRequest, handler, parseBody, rateLimit, requireContext, uuidParam } from "@/server/http";
import { env } from "@/server/env";
import { savePaper } from "@/server/library/library";

/**
 * Attaches a PDF to a paper: multipart upload (field "file"), or JSON {url?} to download the
 * paper's open-access PDF (or a user-supplied permitted URL).
 */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  rateLimit(`pdf:${ctx.userId}`, 20);
  const paperId = uuidParam.parse(id);
  const type = req.headers.get("content-type") ?? "";
  let file;
  if (type.startsWith("multipart/form-data")) {
    // Reject oversized uploads before reading the body (1 MB allowance for multipart framing).
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > (env().MAX_PDF_MB + 1) * 1024 * 1024)
      throw badRequest(`PDFs must be smaller than ${env().MAX_PDF_MB} MB.`);
    const form = await req.formData().catch(() => {
      throw badRequest("The upload could not be read.");
    });
    const upload = form.get("file");
    if (!(upload instanceof File)) throw badRequest("Choose a PDF file to upload.");
    file = await uploadPdf(ctx.workspaceId, ctx.userId, paperId, upload);
  } else {
    const { url } = await parseBody(req, z.object({ url: z.string().url().max(2000).optional() }));
    file = await attachPdfFromUrl(ctx.workspaceId, ctx.userId, paperId, url);
  }
  await savePaper(ctx.workspaceId, ctx.userId, paperId);
  return { id: file.id, filename: file.filename, textStatus: file.textStatus };
});
