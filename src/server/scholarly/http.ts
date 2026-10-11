import { AsyncLocalStorage } from "node:async_hooks";
import { ProviderError, type ProviderName } from "./types";

const USER_AGENT = "Paperweave/1.0 (research knowledge workspace)";

const background = new AsyncLocalStorage<boolean>();

/** Runs background work (jobs): its requests to scholarly sources give way to what the user is doing. */
export function runInBackground<T>(fn: () => Promise<T>): Promise<T> {
  return background.run(true, fn);
}

/**
 * Enforces a minimum interval between requests to one provider (process-local). Background requests wait
 * until the provider has had no request from the user for two intervals, so searches and pages opened while
 * jobs run (e.g. after an import) are not stuck behind them or pushed into the provider's rate limit.
 */
export class Throttle {
  private next = 0;
  private lastForeground = 0;
  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    if (background.getStore()) {
      const quietMs = Math.max(2 * this.minIntervalMs, 500);
      for (let idle = Date.now() - this.lastForeground; idle < quietMs; idle = Date.now() - this.lastForeground) {
        await new Promise((r) => setTimeout(r, quietMs - idle));
      }
    } else {
      this.lastForeground = Date.now();
    }
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.minIntervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

/**
 * Remembers providers that recently refused service so we fail over immediately instead of
 * hammering an API that is rate limiting us.
 */
export class CircuitBreaker {
  private openUntil = new Map<ProviderName, number>();
  private quotaUntil = new Map<ProviderName, number>();

  isOpen(provider: ProviderName): boolean {
    return (this.openUntil.get(provider) ?? 0) > Date.now();
  }

  /** True while a provider's daily quota is known to be used up. */
  quotaExhausted(provider: ProviderName): boolean {
    return (this.quotaUntil.get(provider) ?? 0) > Date.now();
  }

  trip(provider: ProviderName, seconds: number, quotaSeconds?: number) {
    this.openUntil.set(provider, Date.now() + seconds * 1000);
    if (quotaSeconds) this.quotaUntil.set(provider, Date.now() + quotaSeconds * 1000);
  }
}

/** A retry-after this long means a daily quota is used up rather than a short burst limit. */
export const QUOTA_RETRY_SECONDS = 3600;

export interface FetchOptions {
  provider: ProviderName;
  headers?: Record<string, string>;
  timeoutMs?: number;
  throttle?: Throttle;
  /** How the body should be read. */
  as?: "json" | "text";
  /**
   * Retry once after a short wait when the provider says "too many requests" without asking for a long
   * pause (per-second limits, e.g. Semantic Scholar's 1 request/second), instead of failing over at once.
   */
  retryShortLimit?: boolean;
}

/** Retries after a short rate limit, and the longest wait before one. */
const SHORT_RETRIES = 2;
const SHORT_RETRY_MAX_SECONDS = 3;

/**
 * GET a URL from an external scholarly API, translating failures into ProviderError.
 * Returns null on 404 so callers can treat "not found" as a normal outcome.
 */
export async function providerFetch<T = unknown>(url: string, opts: FetchOptions): Promise<T | null> {
  // Per-second limits are shared by everything using the same key (e.g. two computers), so a burst can
  // still hit them: wait a little longer each time before giving up and failing over.
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce<T>(url, opts);
    } catch (err) {
      if (!opts.retryShortLimit || !(err instanceof ProviderError) || err.kind !== "rate_limited") throw err;
      const wait = err.retryAfterSeconds ?? 1.5 * attempt;
      if (attempt > SHORT_RETRIES || wait > SHORT_RETRY_MAX_SECONDS) throw err;
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

async function fetchOnce<T>(url: string, opts: FetchOptions): Promise<T | null> {
  await opts.throttle?.wait();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      cache: "no-store",
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new ProviderError(opts.provider, "unavailable", `${opts.provider} ${reason}`);
  }
  if (res.status === 404) return null;
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    throw new ProviderError(
      opts.provider,
      "rate_limited",
      `${opts.provider} rate limit reached`,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }
  if (res.status >= 500 || res.status === 403 || res.status === 401) {
    throw new ProviderError(opts.provider, "unavailable", `${opts.provider} responded with HTTP ${res.status}`);
  }
  if (!res.ok) {
    // 400-class errors usually mean the identifier/query was not acceptable for this source.
    return null;
  }
  try {
    return (opts.as === "text" ? await res.text() : await res.json()) as T;
  } catch {
    throw new ProviderError(opts.provider, "bad_response", `${opts.provider} returned an unreadable response`);
  }
}
