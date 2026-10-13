import { z } from "zod";
import { detectLocalServers, forgetDetectedServers, listServerModels } from "@/server/ai/local-detect";
import { env } from "@/server/env";
import { badRequest, handler, requireContext } from "@/server/http";

const query = z.object({ address: z.string().trim().url().max(500).optional() });

/** Model servers on this computer (or at the address given) and the models they list, for Settings → AI. */
export const GET = handler(async (req: Request) => {
  await requireContext();
  if (!env().AI_ALLOW_PRIVATE_ENDPOINTS) throw badRequest("This server does not allow connecting to local models.");
  const { address } = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  forgetDetectedServers();
  if (!address) return { servers: await detectLocalServers() };
  const server = await listServerModels(address);
  return { servers: server ? [server] : [] };
});
