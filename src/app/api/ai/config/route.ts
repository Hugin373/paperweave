import { z } from "zod";
import { AI_EFFORTS } from "@/lib/types";
import { deleteAiConfig, getAiConfig, saveAiConfig } from "@/server/ai/config";
import { assertCanWrite, handler, parseBody, requireContext } from "@/server/http";

const configSchema = z.object({
  provider: z.enum(["openai", "anthropic", "openai_compatible", "local", "ollama", "claude_code", "codex", "mock"]),
  model: z.string().trim().max(200),
  baseUrl: z.string().trim().max(500).nullable().optional(),
  apiKey: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  effort: z.enum(AI_EFFORTS).nullable().optional(),
  local: z
    .object({ context: z.enum(["full", "low"]), images: z.boolean() })
    .nullable()
    .optional(),
});

/** The workspace's AI configuration. API keys are never returned. */
export const GET = handler(async () => {
  const ctx = await requireContext();
  return getAiConfig(ctx.workspaceId);
});

export const PUT = handler(async (req) => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  const body = await parseBody(req, configSchema);
  await saveAiConfig(ctx.workspaceId, ctx.userId, body);
  return getAiConfig(ctx.workspaceId);
});

export const DELETE = handler(async () => {
  const ctx = await requireContext();
  assertCanWrite(ctx);
  await deleteAiConfig(ctx.workspaceId);
  return getAiConfig(ctx.workspaceId);
});
