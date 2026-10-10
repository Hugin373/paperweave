import { handler, requireContext } from "@/server/http";
import { sharedWithMe } from "@/server/sharing/shares";

export const GET = handler(async () => sharedWithMe(await requireContext()));
