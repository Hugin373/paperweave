import OpenAI from "openai";
import { DEFAULT_LOCAL_MODEL_SETTINGS, type AiEffort, type AiProviderKind, type LocalModelSettings } from "@/lib/types";
import { AIError, type AIProvider, type CompletionRequest, type ProviderConfig } from "../types";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

function baseUrlFor(cfg: ProviderConfig): string | undefined {
  if (cfg.kind === "ollama") {
    // Ollama serves an OpenAI-compatible API under /v1.
    const base = (cfg.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
    return base.endsWith("/v1") ? base : `${base}/v1`;
  }
  return cfg.baseUrl ?? undefined;
}

function mapError(err: unknown, vendor: string): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new AIError("auth", `${vendor} rejected the API key. Check it in Settings → AI.`);
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new AIError("rate_limited", `${vendor} is rate limiting requests. Please try again shortly.`);
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new AIError("bad_request", `The model was not found at ${vendor}. Check the model name and base URL.`);
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new AIError("bad_request", `${vendor} rejected the request: ${err.message}`);
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new AIError("timeout", "The AI provider took too long to respond.");
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new AIError(
      "unavailable",
      `Could not reach ${vendor.replace(/^The /, "the ")}. Is the ${vendor === VENDOR.local ? "model server" : "endpoint"} running and reachable from the server?`,
    );
  }
  if (err instanceof OpenAI.APIError) {
    return new AIError("unavailable", `${vendor} returned an error (${err.status ?? "unknown"}).`);
  }
  return new AIError("unavailable", "The AI provider failed unexpectedly.");
}

const VENDOR: Record<string, string> = {
  openai: "OpenAI",
  openai_compatible: "The AI endpoint",
  ollama: "Ollama",
  local: "The local model",
};

/** OpenAI, any OpenAI-compatible API, local models (through the same API), and Ollama. */
export class OpenAICompatibleProvider implements AIProvider {
  readonly kind: AiProviderKind;
  readonly model: string;
  readonly local?: LocalModelSettings;
  private readonly client: OpenAI;
  private readonly effort: AiEffort | null;

  constructor(cfg: ProviderConfig) {
    this.kind = cfg.kind;
    this.model = cfg.model;
    this.effort = cfg.effort ?? null;
    if (cfg.kind === "local") this.local = cfg.local ?? DEFAULT_LOCAL_MODEL_SETTINGS;
    this.client = new OpenAI({
      // Local servers usually ignore the key, but the SDK requires a value.
      apiKey: cfg.apiKey ?? (cfg.kind === "openai" ? undefined : "not-needed"),
      baseURL: baseUrlFor(cfg),
      timeout: cfg.timeoutMs,
      maxRetries: 1,
      fetch: cfg.fetch,
    });
  }

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    if (this.kind === "openai") {
      yield* this.streamResponses(req);
      return;
    }
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          stream: true,
          messages: [{ role: "system", content: req.system }, ...chatMessages(req)],
        },
        { signal: req.signal },
      );
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) yield text;
      }
    } catch (err) {
      throw mapError(err, VENDOR[this.kind] ?? "The AI provider");
    }
  }

  /**
   * OpenAI's Responses API, which serves every current OpenAI model — including those that are not
   * available through Chat Completions (e.g. Codex models).
   */
  private async *streamResponses(req: CompletionRequest): AsyncIterable<string> {
    try {
      const stream = await this.client.responses.create(
        {
          model: this.model,
          stream: true,
          instructions: req.system,
          input: responsesInput(req),
          ...(req.maxTokens ? { max_output_tokens: req.maxTokens } : {}),
          store: false,
          ...(this.effort ? { reasoning: { effort: this.effort } } : {}),
        },
        { signal: req.signal },
      );
      let produced = false;
      let refused = false;
      for await (const event of stream) {
        if (event.type === "response.output_text.delta" && event.delta) {
          produced = true;
          yield event.delta;
        } else if (event.type === "response.refusal.delta") {
          refused = true;
        } else if (event.type === "error") {
          throw new AIError("unavailable", `OpenAI returned an error: ${event.message}`);
        } else if (event.type === "response.failed") {
          throw new AIError(
            "unavailable",
            `OpenAI could not complete the request: ${event.response.error?.message ?? "unknown error"}`,
          );
        }
      }
      if (!produced && refused) throw new AIError("refused", "The model declined this request.");
    } catch (err) {
      throw mapError(err, "OpenAI");
    }
  }
}

const dataUrl = (img: NonNullable<CompletionRequest["images"]>[number]) => `data:${img.mediaType};base64,${img.data}`;
const isLastUser = (req: CompletionRequest, i: number) =>
  i === req.messages.length - 1 && req.messages[i].role === "user";

/** Chat Completions messages, with images on the last user message (OpenAI-compatible servers, Ollama). */
function chatMessages(req: CompletionRequest): OpenAI.ChatCompletionMessageParam[] {
  return req.messages.map((m, i) =>
    req.images?.length && isLastUser(req, i)
      ? {
          role: "user" as const,
          content: [
            { type: "text" as const, text: m.content },
            ...req.images.map((img) => ({ type: "image_url" as const, image_url: { url: dataUrl(img) } })),
          ],
        }
      : m,
  );
}

/** Responses API input, with images on the last user message. */
function responsesInput(req: CompletionRequest): OpenAI.Responses.ResponseInput {
  return req.messages.map((m, i) =>
    req.images?.length && isLastUser(req, i)
      ? {
          role: "user" as const,
          content: [
            { type: "input_text" as const, text: m.content },
            ...req.images.map((img) => ({
              type: "input_image" as const,
              image_url: dataUrl(img),
              detail: "auto" as const,
            })),
          ],
        }
      : { role: m.role, content: m.content },
  );
}
