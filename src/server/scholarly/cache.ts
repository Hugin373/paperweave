import { createHash } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { externalCache } from "@/server/db/schema";

export function cacheKey(...parts: unknown[]): string {
  const raw = JSON.stringify(parts);
  return raw.length <= 200 ? raw : createHash("sha256").update(raw).digest("hex");
}

/**
 * Returns a cached value for `key`, or computes it with `fn` and stores it.
 * `null` results are cached too (as "not found"), but for a shorter time.
 */
export async function cached<T>(key: string, ttlHours: number, fn: () => Promise<T>): Promise<T> {
  const hit = await db
    .select({ value: externalCache.value })
    .from(externalCache)
    .where(and(eq(externalCache.key, key), gt(externalCache.expiresAt, new Date())))
    .limit(1);
  if (hit.length) return (hit[0].value as { v: T }).v;

  const value = await fn();
  const hours = value === null ? Math.min(ttlHours, 6) : ttlHours;
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  await db
    .insert(externalCache)
    .values({ key, value: { v: value }, expiresAt })
    .onConflictDoUpdate({ target: externalCache.key, set: { value: { v: value }, expiresAt, fetchedAt: new Date() } });
  return value;
}

export async function purgeExpiredCache(): Promise<number> {
  const rows = await db
    .delete(externalCache)
    .where(lt(externalCache.expiresAt, sql`now()`))
    .returning({ key: externalCache.key });
  return rows.length;
}
