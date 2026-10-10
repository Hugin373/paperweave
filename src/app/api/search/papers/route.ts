import { z } from "zod";
import { discover } from "@/server/papers/discovery";
import { handler, parseQuery, rateLimit, requireContext } from "@/server/http";
import { PUBLICATION_TYPE_FILTERS, SEARCH_SORTS, SEARCH_SOURCES } from "@/server/scholarly/types";

const optionalInt = z.coerce.number().int().optional().catch(undefined);

const schema = z.object({
  q: z.string().trim().min(1, "Enter something to search for").max(500),
  mode: z.enum(["all", "title", "author"]).default("all"),
  yearFrom: optionalInt,
  yearTo: optionalInt,
  oa: z.enum(["true", "false"]).optional(),
  minCitations: optionalInt,
  venue: z.string().trim().max(200).optional(),
  type: z.enum(PUBLICATION_TYPE_FILTERS).optional().catch(undefined),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  exact: z.enum(["true", "false"]).optional(),
  sort: z.enum(SEARCH_SORTS).default("relevance").catch("relevance"),
  source: z.enum(SEARCH_SOURCES).default("general").catch("general"),
  underReview: z.enum(["true", "false"]).optional(),
});

/** Scholarly discovery search across external literature sources. */
export const GET = handler(async (req) => {
  const ctx = await requireContext();
  rateLimit(`search:${ctx.userId}`, 60);
  const p = parseQuery(req, schema);
  return discover(ctx.workspaceId, {
    q: p.q,
    mode: p.mode,
    filters: {
      yearFrom: p.yearFrom,
      yearTo: p.yearTo,
      openAccessOnly: p.oa === "true",
      minCitations: p.minCitations,
      venue: p.venue || undefined,
      publicationType: p.type,
      includeUnderReview: p.underReview === "true",
    },
    offset: Math.floor(p.offset / p.limit) * p.limit,
    limit: p.limit,
    exact: p.exact === "true",
    sort: p.sort,
    source: p.source,
  });
});
