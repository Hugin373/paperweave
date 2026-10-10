import { z } from "zod";
import { handler, rateLimit } from "@/server/http";
import { publicShare } from "@/server/sharing/public";

/** Public, read-only view of something shared by link. */
export const GET = handler<{ token: string }>(async (req, { token }) => {
  rateLimit(`public:${req.headers.get("x-forwarded-for") ?? "anon"}`, 120);
  return publicShare(z.string().min(16).max(100).parse(token));
});
