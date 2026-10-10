import { z } from "zod";
import { READING_STATUSES } from "@/lib/types";
import { handler, parseQuery, requireContext } from "@/server/http";
import { LIBRARY_SORTS, listLibrary } from "@/server/library/library";

const schema = z.object({
  status: z.enum([...READING_STATUSES, "all"]).default("all"),
  q: z.string().max(300).optional(),
  tagId: z.string().uuid().optional(),
  collectionId: z.string().uuid().optional(),
  yearFrom: z.coerce.number().int().optional().catch(undefined),
  yearTo: z.coerce.number().int().optional().catch(undefined),
  hasPdf: z.enum(["true", "false"]).optional(),
  sort: z.enum(LIBRARY_SORTS).default("added_desc"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = handler(async (req) => {
  const ctx = await requireContext();
  const q = parseQuery(req, schema);
  return listLibrary(ctx.workspaceId, { ...q, hasPdf: q.hasPdf === "true" });
});
