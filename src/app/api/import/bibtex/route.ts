import { assertCanWrite, badRequest, handler, rateLimit, requireContext } from "@/server/http";
import { startBibtexImport } from "@/server/import/import";

const MAX_BYTES = 5 * 1024 * 1024;

/** Imports a BibTeX file (multipart field "file", or "text"). Runs as a background job. */
export const POST = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  rateLimit(`import:${ctx.userId}`, 10);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) throw badRequest("BibTeX files must be under 5 MB.");
  const form = await req.formData().catch(() => {
    throw badRequest("The upload could not be read.");
  });
  const file = form.get("file");
  const text = file instanceof File ? await file.text() : String(form.get("text") ?? "");
  if (!text.trim()) throw badRequest("Choose a .bib file or paste BibTeX.");
  const collectionId = String(form.get("collectionId") ?? "") || null;
  return startBibtexImport(ctx, text, collectionId);
});
