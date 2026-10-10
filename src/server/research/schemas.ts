import { z } from "zod";

/** What the user is looking at in the PDF reader when they ask (see ReaderContext). */
export const readerContextSchema = z.object({
  paperId: z.string().uuid(),
  page: z.number().int().min(1).max(100_000).nullable().optional(),
  selection: z.string().max(8000).nullable().optional(),
});
