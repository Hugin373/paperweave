import { headers } from "next/headers";
import { z } from "zod";
import { AI_EFFORTS, type AiChoice } from "@/lib/types";
import { badRequest, errorResponse, rateLimit, type RequestContext } from "@/server/http";
import { providerForWorkspace } from "./config";
import { aiErrorResponse } from "./stream";
import { AIError, type AIProvider } from "./types";

/** Header carrying the model the user picked while working (URI-encoded JSON); absent = workspace default. */
export const AI_CHOICE_HEADER = "x-paperweave-ai";

const choiceSchema = z.object({
  provider: z.enum(["openai", "anthropic", "openai_compatible", "local", "ollama", "claude_code", "codex", "mock"]),
  model: z.string().max(200),
  effort: z.enum(AI_EFFORTS).nullable(),
});

/** The model choice sent with the current request, if any. */
export async function requestAiChoice(): Promise<AiChoice | null> {
  const raw = (await headers()).get(AI_CHOICE_HEADER);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    throw badRequest("The selected AI model could not be read.");
  }
  const result = choiceSchema.safeParse(parsed);
  if (!result.success) throw badRequest("The selected AI model is not valid.");
  return result.data;
}

/** Runs an AI route: rate limiting, provider resolution and AI-specific error responses. */
export async function withProvider(
  ctx: RequestContext,
  fn: (provider: AIProvider) => Promise<Response | unknown>,
  opts: { useChoice?: boolean } = {},
): Promise<Response> {
  try {
    rateLimit(`ai:${ctx.userId}`, 30);
    const choice = opts.useChoice === false ? null : await requestAiChoice();
    const provider = await providerForWorkspace(ctx.workspaceId, choice);
    const out = await fn(provider);
    return out instanceof Response ? out : Response.json(out);
  } catch (err) {
    if (err instanceof AIError) return aiErrorResponse(err);
    return errorResponse(err);
  }
}
