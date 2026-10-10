import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { z, ZodError } from "zod";
import { getAuth } from "@/server/auth";
import { singleUser, type SessionUser } from "@/server/single-user";
import { ProviderError } from "@/server/scholarly/types";
import { ScholarlyUnavailableError } from "@/server/scholarly/service";
import { getActiveWorkspace, type WorkspaceRole } from "@/server/workspaces";
import { aiErrorResponse } from "@/server/ai/stream";
import { AIError } from "@/server/ai/types";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string) => new AppError(400, "bad_request", message);
export const unauthorized = () => new AppError(401, "unauthorized", "Please sign in to continue.");
export const forbidden = (message = "You don't have permission to do that.") => new AppError(403, "forbidden", message);
export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found.`);
export const conflict = (message: string) => new AppError(409, "conflict", message);
export const tooManyRequests = () =>
  new AppError(429, "rate_limited", "You're doing that too often. Please wait a moment and try again.");

export interface RequestContext {
  userId: string;
  userName: string;
  userEmail: string;
  workspaceId: string;
  role: WorkspaceRole;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  // Read request headers first: this marks the render as dynamic before any config is loaded.
  const requestHeaders = await headers();
  // Single-user mode wins over sign-in cookies, which may carry an older copy of the account (name, email).
  const own = await singleUser(requestHeaders.get("host"));
  if (own) return own;
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  return session?.user ?? null;
}

export async function requireContext(): Promise<RequestContext> {
  const user = await getSessionUser();
  if (!user) throw unauthorized();
  const ws = await getActiveWorkspace(user.id);
  if (!ws) throw new AppError(500, "no_workspace", "Your workspace could not be loaded.");
  return { userId: user.id, userName: user.name, userEmail: user.email, workspaceId: ws.id, role: ws.role };
}

/** Throws unless the user may modify content in their active workspace. */
export function assertCanWrite(ctx: RequestContext) {
  if (ctx.role === "viewer") throw forbidden("This workspace is read-only for you.");
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  if (err instanceof AIError) return aiErrorResponse(err);
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return Response.json(
      { error: { code: "invalid_input", message: `${where}${issue?.message ?? "Invalid input"}` } },
      { status: 400 },
    );
  }
  if (err instanceof ScholarlyUnavailableError) {
    return Response.json({ error: { code: "scholarly_unavailable", message: err.message } }, { status: 503 });
  }
  if (err instanceof ProviderError) {
    return Response.json(
      {
        error: { code: "scholarly_unavailable", message: "A scholarly data source is unavailable. Please try again." },
      },
      { status: 503 },
    );
  }
  console.error("[api] unhandled error", err);
  return Response.json(
    { error: { code: "internal", message: "Something went wrong on our side. Please try again." } },
    { status: 500 },
  );
}

type Handler<P> = (req: NextRequest, params: P) => Promise<Response | unknown>;

/**
 * Wraps a route handler: resolves dynamic params, converts thrown errors into JSON error
 * responses and serializes plain return values as JSON.
 */
export function handler<P = Record<string, string>>(fn: Handler<P>) {
  return async (req: NextRequest, ctx: { params: Promise<P> }) => {
    try {
      const params = ctx?.params ? await ctx.params : ({} as P);
      const out = await fn(req, params);
      if (out instanceof Response) return out;
      return Response.json(out ?? { ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
  return schema.parse(json);
}

export function parseQuery<T extends z.ZodType>(req: NextRequest, schema: T): z.infer<T> {
  return schema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
}

export const uuidParam = z.string().uuid("Invalid id");

// ---------------------------------------------------------------------------
// Simple in-process rate limiting for abuse-sensitive endpoints (external API proxies,
// AI calls, uploads). Per-instance by design (see "Server deployment" in SETUP.md).
// ---------------------------------------------------------------------------

const buckets = new Map<string, { tokens: number; updated: number }>();

export function rateLimit(key: string, perMinute: number) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, updated: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.updated) / 60_000) * perMinute);
  b.updated = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    throw tooManyRequests();
  }
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (now - v.updated > 600_000) buckets.delete(k);
  }
}
