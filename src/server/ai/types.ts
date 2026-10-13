import type { AiEffort, AiProviderKind, LocalModelSettings } from "@/lib/types";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** An image sent along with the last user message (e.g. a rendered PDF page). */
export interface ImageInput {
  mediaType: "image/png" | "image/jpeg";
  /** Base64-encoded bytes. */
  data: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  /** Images attached to the last user message; providers that cannot take images fail with "bad_request". */
  images?: ImageInput[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Receives short progress notes (e.g. "Thinking") from providers that report them. */
  onProgress?: (status: string) => void;
}

/**
 * The single interface the rest of the application uses for AI. Adapters translate it to a
 * specific vendor API; nothing outside src/server/ai knows which vendor is configured.
 */
export interface AIProvider {
  readonly kind: AiProviderKind;
  readonly model: string;
  /** Streams the assistant's text output. */
  stream(req: CompletionRequest): AsyncIterable<string>;
  /** Local models: how much context they get and whether they read images (others: full context, images). */
  readonly local?: LocalModelSettings;
}

/** Whether a provider is a local model set to low context. */
export const lowContext = (provider: Pick<AIProvider, "local">) => provider.local?.context === "low";

/** Whether a provider can be sent images (local models only when the user said so). */
export const readsImages = (provider: Pick<AIProvider, "local">) => provider.local?.images ?? true;

export type AIErrorKind =
  "not_configured" | "auth" | "rate_limited" | "unavailable" | "timeout" | "refused" | "bad_request";

export class AIError extends Error {
  constructor(
    readonly kind: AIErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AIError";
  }
}

export interface ProviderConfig {
  kind: AiProviderKind;
  model: string;
  /** Reasoning effort; null/undefined uses the provider's default. */
  effort?: AiEffort | null;
  baseUrl: string | null;
  apiKey: string | null;
  timeoutMs: number;
  fetch: typeof fetch;
  /** Local models only. */
  local?: LocalModelSettings | null;
}

/** Collects a stream into a string. */
export async function complete(provider: AIProvider, req: CompletionRequest): Promise<string> {
  let out = "";
  for await (const chunk of provider.stream(req)) out += chunk;
  return out;
}
