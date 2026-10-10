/**
 * Client-safe metadata about AI providers, their models and effort levels — shared by the settings page
 * and the model picker shown next to AI features.
 */
import {
  AI_EFFORTS,
  type AiConfigDto,
  type AiEffort,
  type AiEffortOption,
  type AiModelOption,
  type AiProviderKind,
} from "./types";

export const EFFORT_LABEL: Record<AiEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const EFFORT_HINT: Record<AiEffort, string> = {
  low: "fastest, light reasoning",
  medium: "balanced",
  high: "deeper reasoning for hard questions",
  xhigh: "very deep reasoning, slower",
  max: "deepest reasoning; slowest and uses the most",
};

/** Providers whose models can be told how long to think. */
export const EFFORT_PROVIDERS: AiProviderKind[] = ["claude_code", "codex", "anthropic", "openai"];

/** Effort levels to offer for a provider and model (Codex reports them per model). */
export function effortsFor(provider: AiProviderKind, model: string, options: AiModelOption[]): AiEffortOption[] {
  if (!EFFORT_PROVIDERS.includes(provider)) return [];
  // The Claude API rejects effort on Haiku models.
  if (provider === "anthropic" && /haiku/i.test(model)) return [];
  const known = options.find((o) => o.value === model)?.efforts;
  return known?.length ? known : AI_EFFORTS.map((value) => ({ value }));
}

export const PROVIDERS: {
  id: AiProviderKind;
  label: string;
  help: string;
  model: string;
  needsKey: boolean;
  baseUrl: "none" | "optional" | "required";
  baseUrlPlaceholder?: string;
  /** Runs a CLI signed in to a subscription (no API key). */
  subscription?: boolean;
  models?: AiModelOption[];
  modelHint?: string;
}[] = [
  {
    id: "claude_code",
    label: "Claude subscription (via Claude Code)",
    help: "Uses the Claude Code CLI signed in on the machine running Paperweave, so requests count against your Claude Pro/Max plan. No API key needed.",
    model: "sonnet",
    needsKey: false,
    baseUrl: "none",
    subscription: true,
    models: [
      { value: "sonnet", label: "Sonnet", description: "balanced speed and quality (recommended)" },
      { value: "opus", label: "Opus", description: "deepest reasoning; slower and uses more of your plan" },
      { value: "fable", label: "Fable", description: "Claude Fable" },
      { value: "haiku", label: "Haiku", description: "fastest and lightest" },
    ],
    modelHint: "Always the latest version of the chosen model that your Claude plan includes.",
  },
  {
    id: "codex",
    label: "ChatGPT subscription (via Codex)",
    help: "Uses the Codex CLI signed in with your ChatGPT account on the machine running Paperweave, so requests count against your ChatGPT plan. No API key needed.",
    model: "",
    needsKey: false,
    baseUrl: "none",
    subscription: true,
    models: [{ value: "", label: "Codex default", description: "the model Codex picks for your plan" }],
    modelHint: "The models your ChatGPT plan offers in Codex.",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    help: "Use an API key from console.anthropic.com.",
    model: "claude-opus-5-5",
    models: [
      { value: "claude-opus-5-5", label: "Claude Opus 5.5", description: "deepest reasoning" },
      { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", description: "balanced speed and quality" },
      { value: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", description: "fastest and lowest cost" },
    ],
    needsKey: true,
    baseUrl: "optional",
    baseUrlPlaceholder: "https://api.anthropic.com",
  },
  {
    id: "openai",
    label: "OpenAI",
    help: "Use an API key from platform.openai.com. Any OpenAI model works, including Codex models.",
    model: "gpt-5",
    needsKey: true,
    baseUrl: "optional",
    baseUrlPlaceholder: "https://api.openai.com/v1",
  },
  {
    id: "openai_compatible",
    label: "OpenAI-compatible API",
    help: "Any server implementing the OpenAI Chat Completions API: vLLM, LM Studio, llama.cpp server, OpenRouter, Together, Groq…",
    model: "",
    needsKey: false,
    baseUrl: "required",
    baseUrlPlaceholder: "http://localhost:1234/v1",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    help: "Runs models on your own machine. The server must be able to reach the Ollama endpoint.",
    model: "llama3.1",
    needsKey: false,
    baseUrl: "optional",
    baseUrlPlaceholder: "http://localhost:11434",
  },
  {
    id: "mock",
    label: "Mock (testing only)",
    help: "A deterministic fake provider for automated tests and demos. Its answers are not real.",
    model: "mock-1",
    needsKey: false,
    baseUrl: "none",
  },
];

/** Short provider names for compact UI (the model picker, answer labels). */
export const PROVIDER_SHORT: Record<AiProviderKind, string> = {
  claude_code: "Claude",
  codex: "ChatGPT",
  anthropic: "Claude API",
  openai: "OpenAI",
  openai_compatible: "Custom API",
  ollama: "Ollama",
  mock: "Mock",
};

/** Models to offer for a provider: built-in choices plus those the server discovered (e.g. Codex). */
export function optionsFor(provider: AiProviderKind, config: AiConfigDto): AiModelOption[] {
  const builtIn = PROVIDERS.find((p) => p.id === provider)?.models ?? [];
  const discovered = config.modelOptions[provider] ?? [];
  const seen = new Set(builtIn.map((o) => o.value));
  return [...builtIn, ...discovered.filter((o) => !seen.has(o.value))];
}

/** Display name of a model, e.g. "Opus" or "GPT-6-Luna" (falls back to the raw id). */
export function modelLabel(provider: AiProviderKind, model: string, config: AiConfigDto): string {
  return optionsFor(provider, config).find((o) => o.value === model)?.label ?? (model || "Default model");
}
