import { contentDisposition } from "@/server/files/service";
import { handler, requireContext, uuidParam } from "@/server/http";
import { screeningCsv } from "@/server/screening/service";

/** The screening's decisions as CSV. */
export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  const { filename, csv } = await screeningCsv(ctx.workspaceId, uuidParam.parse(id));
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition("attachment", filename),
    },
  });
});
