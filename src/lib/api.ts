/** Client-side API helpers. All server errors arrive as { error: { code, message } }. */

import { parseStream, STREAM_ERROR_MARKER, type StreamMeta } from "./ai-stream";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(
      res.status,
      body.error?.code ?? "error",
      body.error?.message ?? `Request failed (${res.status})`,
    );
  } catch {
    return new ApiError(
      res.status,
      "error",
      res.status >= 500 ? "The server had a problem. Please try again." : `Request failed (${res.status})`,
    );
  }
}

/** localStorage key of the AI model picked while working (see useAiChoice). */
export const AI_CHOICE_KEY = "pw-ai-choice";

/**
 * AI requests carry the model the user picked in the model picker, if any. Settings requests do not:
 * they always work on (and test) the saved default.
 */
function aiChoiceHeaders(path: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  if (!/^\/api\/(ai|research)(\/|$|\?)/.test(path) || /^\/api\/ai\/(config|test)/.test(path)) return {};
  try {
    const raw = localStorage.getItem(AI_CHOICE_KEY);
    return raw ? { "x-paperweave-ai": encodeURIComponent(raw) } : {};
  } catch {
    return {};
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: {
        ...aiChoiceHeaders(path),
        ...(opts.body !== undefined && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
      signal: opts.signal,
      credentials: "same-origin",
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network", "Could not reach the server. Check your connection.");
  }
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = new URL(`/login?next=${next}`, window.location.origin).toString();
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * POSTs to a streaming AI endpoint and reports text as it arrives; `onMeta` receives what the
 * answer is based on and progress notes. Throws ApiError for errors before or during streaming.
 */
export async function streamText(
  path: string,
  body: unknown,
  onText: (full: string) => void,
  signal?: AbortSignal,
  onMeta?: (meta: StreamMeta) => void,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { ...aiChoiceHeaders(path), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network", "Could not reach the server. Check your connection.");
  }
  if (!res.ok) throw await toError(res);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let seen = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    const parsed = parseStream(raw);
    for (const m of parsed.meta.slice(seen)) onMeta?.(m);
    seen = parsed.meta.length;
    text = parsed.text;
    const marker = text.indexOf(STREAM_ERROR_MARKER);
    if (marker >= 0) {
      onText(text.slice(0, marker));
      throw new ApiError(502, "ai_stream", text.slice(marker + STREAM_ERROR_MARKER.length));
    }
    onText(text);
  }
  return text;
}

/** Starts a browser download of an API URL (keeps the current page). */
export function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function errorMessage(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
