import { z } from "zod";
import { assertCanWrite, handler, parseBody, requireContext, uuidParam } from "@/server/http";
import { saveIncluded } from "@/server/screening/service";

/** Saves the included papers as a new collection. */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(
    req,
    z.object({ name: z.string().trim().min(1).max(120), withMaybe: z.boolean().default(false) }),
  );
  return saveIncluded(ctx, uuidParam.parse(id), body);
});
