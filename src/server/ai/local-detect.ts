/**
 * Finding a local model: model servers on this computer that speak the OpenAI chat API, found by asking
 * the usual local ports for their model list (/v1/models). Paperweave does not care which server it is.
 */
import type { LocalModelServer } from "@/lib/types";
import { AIError } from "./types";

/** Ports local model servers listen on by default. */
export const LOCAL_MODEL_PORTS = [8000, 1234, 8080, 11434, 5000, 5001, 30000, 1337, 4891];

const PROBE_MS = 1200;
/** How long a found server is remembered before looking again (requests come in bursts). */
const CACHE_MS = 30_000;

const trimBase = (url: string) => {
  const base = url.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
};

/** The context window a server reports for a model, under the names servers use for it. */
function contextLength(model: Record<string, unknown>): number | null {
  const meta = (model.meta ?? {}) as Record<string, unknown>;
  for (const v of [model.max_model_len, model.context_length, model.context_window, meta.n_ctx_train, meta.n_ctx]) {
    if (typeof v === "number" && v > 0) return v;
  }
  return null;
}

/** The models a server lists, or null when nothing answering the OpenAI API is there. */
export async function listServerModels(baseUrl: string, apiKey?: string | null): Promise<LocalModelServer | null> {
  const base = trimBase(baseUrl);
  try {
    const res = await fetch(`${base}/models`, {
      signal: AbortSignal.timeout(PROBE_MS),
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return null;
    const models = body.data
      .filter((m): m is Record<string, unknown> => !!m && typeof (m as { id?: unknown }).id === "string")
      .map((m) => ({ id: m.id as string, contextLength: contextLength(m) }));
    return { baseUrl: base, models };
  } catch {
    return null;
  }
}

/** Model servers on this computer, in the order of LOCAL_MODEL_PORTS. */
export async function detectLocalServers(): Promise<LocalModelServer[]> {
  const found = await Promise.all(LOCAL_MODEL_PORTS.map((port) => listServerModels(`http://127.0.0.1:${port}`)));
  return found.filter((s): s is LocalModelServer => !!s && s.models.length > 0);
}

let cached: { at: number; servers: LocalModelServer[] } | null = null;

/** Clears the remembered servers (tests, and "Detect again"). */
export function forgetDetectedServers() {
  cached = null;
}

/**
 * The server and model to use for a request. With an address, that server; otherwise the first one found on
 * this computer. With one model listed, that model (whatever is loaded now); with several, the one picked
 * in Settings.
 */
export async function resolveLocalModel(input: {
  baseUrl: string | null;
  model: string;
  apiKey?: string | null;
}): Promise<{ baseUrl: string; model: string }> {
  let server: LocalModelServer | null;
  if (input.baseUrl) {
    server = await listServerModels(input.baseUrl, input.apiKey);
    if (!server) {
      throw new AIError(
        "unavailable",
        `No model server answered at ${input.baseUrl}. Is it running? (Settings → AI → Local model → Advanced)`,
      );
    }
  } else {
    if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), servers: await detectLocalServers() };
    server = cached.servers[0] ?? null;
    if (!server) {
      cached = null;
      throw new AIError(
        "unavailable",
        "No local model server was found on this computer. Start your model server, or give its address in Settings → AI → Local model → Advanced.",
      );
    }
  }
  const ids = server.models.map((m) => m.id);
  if (ids.length === 1) return { baseUrl: server.baseUrl, model: ids[0] };
  if (input.model && ids.includes(input.model)) return { baseUrl: server.baseUrl, model: input.model };
  if (!ids.length) throw new AIError("unavailable", `The model server at ${server.baseUrl} lists no models.`);
  throw new AIError(
    "not_configured",
    input.model
      ? `The local model “${input.model}” is not available any more. Pick one in Settings → AI.`
      : "Your model server lists several models. Pick the one to use in Settings → AI.",
  );
}
