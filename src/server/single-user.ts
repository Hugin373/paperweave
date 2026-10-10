/**
 * Single-user mode (SINGLE_USER_EMAIL): for a library kept on one computer and opened only from there and
 * through Tailscale, requests without a sign-in act as that account, so there is no sign-in page.
 */
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { env } from "@/server/env";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

/**
 * True when the request was addressed to this computer or to an address this instance is configured for
 * (APP_URL, TRUSTED_ORIGINS). A website that points its own domain at this computer (DNS rebinding) sends
 * its domain as the host, so it is refused and its visitors are not signed in.
 */
export function isOwnHost(host: string | null, origins: string[]): boolean {
  if (!host) return false;
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  const own = new Set(["localhost", "127.0.0.1", "[::1]"]);
  for (const o of origins) {
    try {
      own.add(new URL(o).hostname);
    } catch {
      /* not a URL */
    }
  }
  return own.has(name);
}

let cached: { email: string; user: SessionUser | null; at: number } | undefined;

/** The account single-user mode signs in, or null when the mode is off or the request is not from here. */
export async function singleUser(host: string | null): Promise<SessionUser | null> {
  const e = env();
  const email = e.SINGLE_USER_EMAIL?.toLowerCase();
  if (!email || !isOwnHost(host, [e.APP_URL, ...e.TRUSTED_ORIGINS])) return null;
  if (cached?.email === email && Date.now() - cached.at < 60_000) return cached.user;
  const [row] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.email, email));
  if (!row) console.warn(`[auth] SINGLE_USER_EMAIL: there is no account with the email ${email}`);
  cached = { email, user: row ?? null, at: Date.now() };
  return cached.user;
}

/** Forgets the cached account (after its name changes). */
export function resetSingleUserCache() {
  cached = undefined;
}
