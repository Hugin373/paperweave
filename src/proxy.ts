import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function allowedOrigins(request: NextRequest) {
  const origins = new Set([request.nextUrl.origin]);
  if (process.env.APP_URL) origins.add(new URL(process.env.APP_URL).origin);
  // Other addresses this instance is reached at, e.g. a Tailscale URL (comma-separated).
  for (const o of (process.env.TRUSTED_ORIGINS ?? "").split(",")) {
    if (o.trim()) origins.add(new URL(o.trim()).origin);
  }
  return origins;
}

/**
 * Sent from a page of this instance: the Origin is one of its addresses, or names the same host the request
 * was sent to (e.g. a page opened at http://127.0.0.1:3300, which the server's own URL may not reflect).
 */
export function sameSite(origin: string, host: string | null, allowed: Set<string>) {
  if (allowed.has(origin)) return true;
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 1. API: rejects state-changing requests sent from other websites (CSRF defense in depth; session
 *    cookies are also SameSite=Lax). Requests without an Origin header (non-browser clients) pass.
 * 2. Pages: optimistic redirect to sign-in for visitors without a session cookie (not in single-user
 *    mode, where the server decides). Every page and API route still verifies the session itself.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    const origin = request.headers.get("origin");
    if (
      !SAFE_METHODS.has(request.method) &&
      origin &&
      !sameSite(origin, request.headers.get("host"), allowedOrigins(request))
    ) {
      return NextResponse.json(
        { error: { code: "forbidden", message: "Cross-site request blocked." } },
        { status: 403 },
      );
    }
    return NextResponse.next();
  }
  if (!process.env.SINGLE_USER_EMAIL && !getSessionCookie(request)) {
    const url = new URL("/login", request.url);
    const next = pathname + request.nextUrl.search;
    if (next !== "/") url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/((?!api|_next|login|register|s/|favicon.ico|pdf.worker.min.mjs|icon.svg|robots.txt).*)"],
};
