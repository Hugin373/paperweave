import { z } from "zod";
import { createHighlight, listHighlights } from "@/server/files/highlights";
import { assertCanWrite, handler, parseBody, requireContext, uuidParam } from "@/server/http";

const unit = z.number().min(-0.01).max(1.01);
const highlightSchema = z.object({
  kind: z.enum(["highlight", "note"]).default("highlight"),
  pageNumber: z.number().int().min(1).max(100000),
  rects: z
    .array(z.object({ x: unit, y: unit, width: unit, height: unit }))
    .min(1)
    .max(200),
  selectedText: z.string().max(10000).default(""),
  prefix: z.string().max(200).default(""),
  suffix: z.string().max(200).default(""),
  color: z.enum(["yellow", "green", "blue", "pink", "purple"]).default("yellow"),
  comment: z.string().max(10000).default(""),
});

export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  return listHighlights(ctx.workspaceId, uuidParam.parse(id));
});

export const POST = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(req, highlightSchema);
  return createHighlight(ctx.workspaceId, ctx.userId, uuidParam.parse(id), body);
});
