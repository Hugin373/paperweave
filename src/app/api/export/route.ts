import { z } from "zod";
import { exportBibtex, exportJson, exportMarkdownZip } from "@/server/export/export";
import { handler, parseQuery, rateLimit, requireContext } from "@/server/http";

function attachment(name: string) {
  return `attachment; filename="${name}"`;
}

/** Downloads workspace data as JSON, a Markdown archive, or BibTeX. */
export const GET = handler(async (req) => {
  const ctx = await requireContext();
  rateLimit(`export:${ctx.userId}`, 20);
  const q = parseQuery(
    req,
    z.object({
      format: z.enum(["json", "markdown", "bibtex"]),
      collectionId: z.string().uuid().optional(),
      paperIds: z.string().optional(),
    }),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  if (q.format === "json") {
    const data = await exportJson(ctx.workspaceId);
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "Content-Type": "application/json", "Content-Disposition": attachment(`paperweave-${stamp}.json`) },
    });
  }
  if (q.format === "markdown") {
    const zip = await exportMarkdownZip(ctx.workspaceId);
    return new Response(Buffer.from(zip), {
      headers: { "Content-Type": "application/zip", "Content-Disposition": attachment(`paperweave-${stamp}.zip`) },
    });
  }
  const bib = await exportBibtex(ctx.workspaceId, {
    collectionId: q.collectionId,
    paperIds: q.paperIds ? q.paperIds.split(",").filter(Boolean) : undefined,
  });
  return new Response(bib, {
    headers: {
      "Content-Type": "application/x-bibtex; charset=utf-8",
      "Content-Disposition": attachment(`paperweave-${stamp}.bib`),
    },
  });
});
