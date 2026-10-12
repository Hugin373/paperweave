import { z } from "zod";
import { handler, requireContext } from "@/server/http";
import { publicationTrend } from "@/server/search/trend";

const query = z.object({
  q: z.string().trim().min(2).max(300),
  from: z.coerce.number().int().min(1900).max(2100).optional(),
  to: z.coerce.number().int().min(1900).max(2100).optional(),
});

/** Papers published per year for a search (OpenAlex counts; no AI). */
export const GET = handler(async (req: Request) => {
  await requireContext();
  const { q, from, to } = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return publicationTrend([q], { yearFrom: from, yearTo: to });
});
