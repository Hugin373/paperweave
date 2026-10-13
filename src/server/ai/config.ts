import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  AI_EFFORTS,
  type AiChoice,
  type AiConfigDto,
  type AiEffort,
  type AiEffortOption,
  type AiModelOption,
  type AiProviderKind,
  type AiProviderSettingsDto,
  DEFAULT_LOCAL_MODEL_SETTINGS,
  type LocalModelSettings,
} from "@/lib/types";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { db } from "@/server/db/client";
import { aiConfigs, aiProviderSettings } from "@/server/db/schema";
import { env } from "@/server/env";
import { badRequest } from "@/server/http";
import { assertPublicUrl, UnsafeUrlError } from "@/server/net/safe-fetch";
import { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "./providers/anthropic";
import { CLAUDE_CODE_DEFAULT_MODEL, ClaudeCodeProvider, CODEX_DEFAULT_MODEL, CodexProvider } from "./providers/cli";
import { MockProvider } from "./providers/mock";
import { resolveLocalModel } from "./local-detect";
import { OpenAICompatibleProvider } from "./providers/openai";
import { AIError, complete, type AIProvider, type ProviderConfig } from "./types";

type ConfigRow = typeof aiConfigs.$inferSelect;
type SettingsRow = typeof aiProviderSettings.$inferSelect;

/** Providers that run a CLI signed in to a subscription on the server machine. */
export const SUBSCRIPTION_PROVIDERS: readonly AiProviderKind[] = ["claude_code", "codex"];
const isSubscription = (p: AiProviderKind) => SUBSCRIPTION_PROVIDERS.includes(p);

export const PROVIDER_DEFAULT_MODEL: Record<AiProviderKind, string> = {
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  openai: "gpt-5",
  openai_compatible: "",
  ollama: "llama3.1",
  local: "",
  claude_code: CLAUDE_CODE_DEFAULT_MODEL,
  codex: CODEX_DEFAULT_MODEL,
  mock: "mock-1",
};

export function toConfigDto(
  row: ConfigRow | null,
  savedRows: SettingsRow[] = [],
  modelOptions: AiConfigDto["modelOptions"] = {},
): AiConfigDto {
  const saved: Partial<Record<AiProviderKind, AiProviderSettingsDto>> = {};
  for (const r of savedRows) {
    saved[r.provider] = {
      model: r.model,
      effort: r.effort,
      baseUrl: r.baseUrl,
      hasApiKey: !!r.apiKeyEncrypted,
      apiKeyLast4: r.apiKeyLast4,
      local: r.localSettings ?? null,
    };
  }
  return {
    configured: !!row,
    enabled: row?.enabled ?? false,
    provider: row?.provider ?? null,
    model: row?.model ?? null,
    effort: row?.effort ?? null,
    baseUrl: row?.baseUrl ?? null,
    hasApiKey: !!row?.apiKeyEncrypted,
    apiKeyLast4: row?.apiKeyLast4 ?? null,
    local: row?.localSettings ?? null,
    mockAvailable: env().AI_ENABLE_MOCK_PROVIDER,
    // A local model lives on a private address, which this server may forbid.
    localAvailable: env().AI_ALLOW_PRIVATE_ENDPOINTS,
    subscriptionAvailable: env().AI_ENABLE_SUBSCRIPTION_CLI,
    saved,
    connected: savedRows.filter(isUsable).map((r) => r.provider),
    modelOptions,
  };
}

export async function getAiConfigRow(workspaceId: string): Promise<ConfigRow | null> {
  const [row] = await db.select().from(aiConfigs).where(eq(aiConfigs.workspaceId, workspaceId));
  return row ?? null;
}

/** Whether remembered settings are complete enough to use (and allowed on this server). */
function isUsable(s: Pick<SettingsRow, "provider" | "apiKeyEncrypted" | "baseUrl">): boolean {
  switch (s.provider) {
    case "claude_code":
    case "codex":
      return env().AI_ENABLE_SUBSCRIPTION_CLI;
    case "mock":
      return env().AI_ENABLE_MOCK_PROVIDER;
    case "anthropic":
    case "openai":
      return !!s.apiKeyEncrypted || !!s.baseUrl;
    case "openai_compatible":
      return !!s.baseUrl;
    case "ollama":
      return true;
    case "local":
      return env().AI_ALLOW_PRIVATE_ENDPOINTS;
  }
}

/** Models the signed-in Codex account offers, from the CLI's local model cache (best effort). */
async function codexModels(): Promise<AiModelOption[]> {
  const home = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  try {
    const data = JSON.parse(await readFile(path.join(home, "models_cache.json"), "utf8")) as {
      models?: {
        slug?: unknown;
        display_name?: unknown;
        description?: unknown;
        visibility?: unknown;
        default_reasoning_level?: unknown;
        supported_reasoning_levels?: { effort?: unknown; description?: unknown }[];
      }[];
    };
    const isEffort = (v: unknown): v is AiEffort => AI_EFFORTS.includes(v as AiEffort);
    return (data.models ?? [])
      .filter((m) => typeof m.slug === "string" && m.visibility !== "hide")
      .map((m) => ({
        value: m.slug as string,
        label: typeof m.display_name === "string" ? m.display_name : (m.slug as string),
        description: typeof m.description === "string" ? m.description.slice(0, 120) : undefined,
        // Only the levels Paperweave can pass through (e.g. "ultra", which delegates to sub-agents, is left out).
        efforts: (m.supported_reasoning_levels ?? [])
          .filter((l) => isEffort(l.effort))
          .map((l): AiEffortOption => ({
            value: l.effort as AiEffort,
            description: typeof l.description === "string" ? l.description.slice(0, 100) : undefined,
          })),
        defaultEffort: isEffort(m.default_reasoning_level) ? m.default_reasoning_level : undefined,
      }))
      .slice(0, 20);
  } catch {
    return [];
  }
}

/** The workspace's AI configuration as shown in settings (never includes keys). */
export async function getAiConfig(workspaceId: string): Promise<AiConfigDto> {
  const [row, saved, codex] = await Promise.all([
    getAiConfigRow(workspaceId),
    db.select().from(aiProviderSettings).where(eq(aiProviderSettings.workspaceId, workspaceId)),
    env().AI_ENABLE_SUBSCRIPTION_CLI ? codexModels() : Promise.resolve([]),
  ]);
  return toConfigDto(row, saved, codex.length ? { codex } : {});
}

export interface AiConfigInput {
  provider: AiProviderKind;
  model: string;
  baseUrl?: string | null;
  /** undefined keeps the stored key; null or "" removes it. */
  apiKey?: string | null;
  enabled?: boolean;
  /** null or undefined: the provider's default. */
  effort?: AiEffort | null;
  /** Local models only. */
  local?: LocalModelSettings | null;
}

async function validateBaseUrl(url: string | null | undefined) {
  if (!url) return;
  if (env().AI_ALLOW_PRIVATE_ENDPOINTS) {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      throw badRequest("The base URL is not a valid http(s) URL.");
    }
    return;
  }
  try {
    await assertPublicUrl(url);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      throw badRequest(`${err.message} This server does not allow AI endpoints on private networks.`);
    }
    throw err;
  }
}

function validateInput(input: AiConfigInput) {
  if (input.provider === "mock" && !env().AI_ENABLE_MOCK_PROVIDER) {
    throw badRequest("The mock provider is not enabled on this server.");
  }
  if (input.provider === "local" && !env().AI_ALLOW_PRIVATE_ENDPOINTS) {
    throw badRequest("This server does not allow connecting to local models.");
  }
  if (isSubscription(input.provider) && !env().AI_ENABLE_SUBSCRIPTION_CLI) {
    throw badRequest("Subscription providers (Claude Code, Codex) are not enabled on this server.");
  }
  // Codex picks its own default model when none is given.
  // Codex picks its own default model; a local model with no name follows whatever its server runs.
  if (!input.model.trim() && input.provider !== "codex" && input.provider !== "local") {
    throw badRequest("Please enter a model name.");
  }
  if (input.provider === "openai_compatible" && !input.baseUrl) {
    throw badRequest("OpenAI-compatible endpoints need a base URL.");
  }
}

export async function saveAiConfig(workspaceId: string, userId: string, input: AiConfigInput): Promise<ConfigRow> {
  validateInput(input);
  const subscription = isSubscription(input.provider);
  if (!subscription) await validateBaseUrl(input.baseUrl);
  // A stored key is kept per provider, so switching back and forth does not require re-entering it.
  const [remembered] = await db
    .select()
    .from(aiProviderSettings)
    .where(and(eq(aiProviderSettings.workspaceId, workspaceId), eq(aiProviderSettings.provider, input.provider)));
  const existing = await getAiConfigRow(workspaceId);
  const current = remembered ?? (existing?.provider === input.provider ? existing : null);
  let apiKeyEncrypted = current?.apiKeyEncrypted ?? null;
  let apiKeyLast4 = current?.apiKeyLast4 ?? null;
  if (subscription) {
    // Subscription CLIs use their own sign-in; never store a key for them.
    apiKeyEncrypted = null;
    apiKeyLast4 = null;
  } else if (input.apiKey !== undefined) {
    const key = input.apiKey?.trim() ?? "";
    apiKeyEncrypted = key ? encryptSecret(key) : null;
    apiKeyLast4 = key ? key.slice(-4) : null;
  }
  if ((input.provider === "anthropic" || input.provider === "openai") && !apiKeyEncrypted && !input.baseUrl) {
    throw badRequest("Please enter an API key for this provider.");
  }
  const settings = {
    workspaceId,
    provider: input.provider,
    model: input.model.trim(),
    effort: input.effort ?? null,
    baseUrl: subscription ? null : input.baseUrl?.trim() || null,
    apiKeyEncrypted,
    apiKeyLast4,
    localSettings: input.provider === "local" ? (input.local ?? DEFAULT_LOCAL_MODEL_SETTINGS) : null,
  };
  const values = { ...settings, enabled: input.enabled ?? true, updatedBy: userId };
  return db.transaction(async (tx) => {
    await tx
      .insert(aiProviderSettings)
      .values(settings)
      .onConflictDoUpdate({
        target: [aiProviderSettings.workspaceId, aiProviderSettings.provider],
        set: { ...settings, updatedAt: new Date() },
      });
    const [row] = await tx
      .insert(aiConfigs)
      .values(values)
      .onConflictDoUpdate({ target: aiConfigs.workspaceId, set: { ...values, updatedAt: new Date() } })
      .returning();
    return row;
  });
}

/** Turns AI off for the workspace and forgets the active provider's settings (including its key). */
export async function deleteAiConfig(workspaceId: string) {
  const existing = await getAiConfigRow(workspaceId);
  await db.transaction(async (tx) => {
    if (existing) {
      await tx
        .delete(aiProviderSettings)
        .where(
          and(eq(aiProviderSettings.workspaceId, workspaceId), eq(aiProviderSettings.provider, existing.provider)),
        );
    }
    await tx.delete(aiConfigs).where(eq(aiConfigs.workspaceId, workspaceId));
  });
}

/** fetch() that refuses private-network destinations unless the server allows them. */
function guardedFetch(): typeof fetch {
  if (env().AI_ALLOW_PRIVATE_ENDPOINTS) return fetch;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    await assertPublicUrl(url);
    return fetch(input, { ...init, redirect: "error" });
  };
}

export function buildProvider(cfg: Omit<ProviderConfig, "fetch" | "timeoutMs">): AIProvider {
  const full: ProviderConfig = { ...cfg, timeoutMs: env().AI_TIMEOUT_SECONDS * 1000, fetch: guardedFetch() };
  switch (cfg.kind) {
    case "anthropic":
      return new AnthropicProvider(full);
    case "openai":
    case "openai_compatible":
    case "ollama":
    case "local":
      return new OpenAICompatibleProvider(full);
    case "claude_code":
    case "codex": {
      if (!env().AI_ENABLE_SUBSCRIPTION_CLI) {
        throw new AIError(
          "not_configured",
          "Subscription providers are disabled on this server. Choose an API provider in Settings → AI.",
        );
      }
      return cfg.kind === "claude_code"
        ? new ClaudeCodeProvider({ ...full, bin: env().AI_CLAUDE_CODE_PATH })
        : new CodexProvider({ ...full, bin: env().AI_CODEX_PATH });
    }
    case "mock":
      if (!env().AI_ENABLE_MOCK_PROVIDER) throw new AIError("not_configured", "The mock provider is disabled.");
      return new MockProvider(cfg.model);
  }
}

/** The workspace's configured provider, or an AIError("not_configured"). */
/**
 * The provider to use for a request: the workspace default, or — when the user picked another model
 * while working — that choice, using the chosen provider's remembered settings (key, base URL).
 */
export async function providerForWorkspace(workspaceId: string, choice?: AiChoice | null): Promise<AIProvider> {
  const row = await getAiConfigRow(workspaceId);
  if (!row || !row.enabled) {
    throw new AIError("not_configured", "AI is not set up. Connect a provider in Settings → AI to use this.");
  }
  let settings: Pick<SettingsRow, "provider" | "model" | "effort" | "baseUrl" | "apiKeyEncrypted" | "localSettings"> =
    row;
  if (choice) {
    const [remembered] = await db
      .select()
      .from(aiProviderSettings)
      .where(and(eq(aiProviderSettings.workspaceId, workspaceId), eq(aiProviderSettings.provider, choice.provider)));
    const base = remembered ?? (row.provider === choice.provider ? row : null);
    if (!base || !isUsable(base)) {
      throw new AIError(
        "not_configured",
        "The AI model you picked is not set up any more. Choose another one, or connect it in Settings → AI.",
      );
    }
    if (!choice.model.trim() && choice.provider !== "codex" && choice.provider !== "local") {
      throw badRequest("Please choose a model.");
    }
    settings = { ...base, model: choice.model.trim(), effort: choice.effort };
  }
  let apiKey: string | null = null;
  if (settings.apiKeyEncrypted) {
    try {
      apiKey = decryptSecret(settings.apiKeyEncrypted);
    } catch {
      throw new AIError("auth", "The stored API key could not be read. Please enter it again in Settings → AI.");
    }
  }
  // A local model is found when needed: the server running now, and the model it runs (or the one picked).
  const target =
    settings.provider === "local"
      ? await resolveLocalModel({ baseUrl: settings.baseUrl, model: settings.model, apiKey })
      : { baseUrl: settings.baseUrl, model: settings.model };
  return buildProvider({
    kind: settings.provider,
    model: target.model,
    effort: settings.effort,
    baseUrl: target.baseUrl,
    apiKey,
    local: settings.localSettings,
  });
}

/** Sends a tiny request to verify the configuration works. */
export async function testProvider(provider: AIProvider): Promise<string> {
  const out = await complete(provider, {
    system: "You are a connectivity check. Reply with the single word OK.",
    messages: [{ role: "user", content: "Reply with OK." }],
    maxTokens: 1024,
    signal: AbortSignal.timeout(60_000),
  });
  return out.trim().slice(0, 200);
}
