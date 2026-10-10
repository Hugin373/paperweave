import Anthropic from "@anthropic-ai/sdk";
import type { AiEffort } from "@/lib/types";
import { AIError, type AIProvider, type CompletionRequest, type ProviderConfig } from "../types";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Models that accept server-side refusal fallbacks in the "default" routing mode. When one of
 * these declines a request, the API re-runs it on Anthropic's recommended fallback model.
 */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export function mapAnthropicError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AIError("auth", "Anthropic rejected the API key. Check it in Settings → AI.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AIError("rate_limited", "Anthropic is rate limiting requests. Please try again shortly.");
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new AIError("bad_request", "The configured Anthropic model was not found. Check the model name.");
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AIError("bad_request", `Anthropic rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new AIError("timeout", "The AI provider took too long to respond.");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AIError("unavailable", "Could not reach Anthropic.");
  }
  if (err instanceof Anthropic.APIError) {
    return new AIError("unavailable", `Anthropic returned an error (${err.status ?? "unknown"}).`);
  }
  return new AIError("unavailable", "The AI provider failed unexpectedly.");
}

export class AnthropicProvider implements AIProvider {
  readonly kind = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly useFallbacks: boolean;
  private readonly effort: AiEffort | null;

  constructor(cfg: ProviderConfig) {
    this.model = cfg.model || ANTHROPIC_DEFAULT_MODEL;
    this.client = new Anthropic({
      apiKey: cfg.apiKey ?? undefined,
      baseURL: cfg.baseUrl ?? undefined,
      timeout: cfg.timeoutMs,
      maxRetries: 1,
      fetch: cfg.fetch,
    });
    // Server-side fallbacks are a Claude API feature; skip them behind custom gateways.
    this.useFallbacks = !cfg.baseUrl && FALLBACK_MODELS.has(this.model);
    // Haiku models reject the effort parameter.
    this.effort = cfg.effort && !/haiku/i.test(this.model) ? cfg.effort : null;
  }

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    const params = {
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: withImages(req),
      ...(this.effort ? { output_config: { effort: this.effort } } : {}),
    };
    try {
      const stream = this.useFallbacks
        ? this.client.beta.messages.stream(
            { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
            { signal: req.signal },
          )
        : this.client.messages.stream(params, { signal: req.signal });
      let produced = false;
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          produced = true;
          yield event.delta.text;
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        throw new AIError(
          "refused",
          produced
            ? "The model stopped this response partway. Try rephrasing the request."
            : "The model declined this request. Try rephrasing it.",
        );
      }
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }
}

/** The messages, with any images attached to the last user message as image blocks. */
function withImages(req: CompletionRequest): Anthropic.MessageParam[] {
  if (!req.images?.length) return req.messages;
  return req.messages.map((m, i) =>
    i === req.messages.length - 1 && m.role === "user"
      ? {
          role: "user",
          content: [
            ...req.images!.map((img) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
            })),
            { type: "text" as const, text: m.content },
          ],
        }
      : m,
  );
}
