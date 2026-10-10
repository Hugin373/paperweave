"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Info, KeyRound, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { PageLoading } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { useAiConfig } from "@/lib/hooks";
import { EFFORT_HINT, EFFORT_LABEL, effortsFor, optionsFor, PROVIDERS } from "@/lib/ai-models";
import type { AiConfigDto, AiEffort, AiProviderKind } from "@/lib/types";

/** Dropdown value that switches the model field to free text. */
const CUSTOM_MODEL = "__custom__";

export function AiSettings() {
  const { data: config, isLoading } = useAiConfig();
  if (isLoading || !config) return <PageLoading />;
  // Re-mount the form whenever the saved configuration changes.
  return (
    <AiSettingsForm
      key={`${config.provider}|${config.model}|${config.effort}|${config.baseUrl}|${config.enabled}`}
      config={config}
    />
  );
}

function AiSettingsForm({ config }: { config: AiConfigDto }) {
  const qc = useQueryClient();
  const defaultProvider: AiProviderKind = config.subscriptionAvailable ? "claude_code" : "anthropic";
  const [provider, setProvider] = useState<AiProviderKind>(config.provider ?? defaultProvider);
  const [model, setModel] = useState(
    config.provider ? (config.model ?? "") : PROVIDERS.find((p) => p.id === defaultProvider)!.model,
  );
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const [enabled, setEnabled] = useState(config.provider ? config.enabled : true);
  const [effort, setEffort] = useState<AiEffort | null>(config.effort);
  const [testResult, setTestResult] = useState<string | null>(null);

  const meta = PROVIDERS.find((p) => p.id === provider)!;
  const available = PROVIDERS.filter(
    (p) =>
      (p.id !== "mock" || config.mockAvailable || config.provider === "mock") &&
      (!p.subscription || config.subscriptionAvailable || config.provider === p.id),
  );
  const remembered = config.saved[provider];
  const keyStored = !!remembered?.hasApiKey;
  const modelOptions = optionsFor(provider, config);
  const effortChoices = effortsFor(provider, model, modelOptions);
  const modelDefaultEffort = modelOptions.find((o) => o.value === model)?.defaultEffort;
  const [customModel, setCustomModel] = useState(
    () => modelOptions.length > 0 && !modelOptions.some((o) => o.value === model),
  );

  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["ai-config"] }), qc.invalidateQueries({ queryKey: ["me"] })]);

  const save = useMutation({
    mutationFn: () =>
      api<AiConfigDto>("/api/ai/config", {
        method: "PUT",
        body: {
          provider,
          model,
          baseUrl: baseUrl.trim() || null,
          enabled,
          effort: effortChoices.some((e) => e.value === effort) ? effort : null,
          ...(keyStored && !replaceKey ? {} : { apiKey: apiKey.trim() || null }),
        },
      }),
    onSuccess: async () => {
      setApiKey("");
      setReplaceKey(false);
      setTestResult(null);
      await refresh();
      toast.success("AI settings saved");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const test = useMutation({
    mutationFn: () => api<{ reply: string; model: string }>("/api/ai/test", { body: {} }),
    onSuccess: (r) => setTestResult(`Connected to ${r.model}. Reply: “${r.reply}”`),
    onError: (err) => {
      setTestResult(null);
      toast.error(errorMessage(err));
    },
  });

  const remove = useMutation({
    mutationFn: () => api("/api/ai/config", { method: "DELETE" }),
    onSuccess: async () => {
      await refresh();
      setApiKey("");
      setTestResult(null);
      toast.success("AI provider removed. Everything else keeps working.");
    },
  });

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-ai" aria-hidden />
        <div className="text-sm">
          <p className="font-medium">AI is optional.</p>
          <p className="mt-1 text-muted">
            Search, citations, reading, notes, concepts and the graph work fully without it. Connect a provider for
            explanations, summaries, question answering and writing help. AI output is always labeled and never
            overwrites paper metadata or your notes.
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-muted">
            <ShieldCheck className="size-4 text-success" aria-hidden />
            Only the paper, selection or note you act on is sent to the provider. Keys are encrypted at rest and never
            shown again.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Status:</span>
        {config?.configured ? (
          <Badge tone={config.enabled ? "success" : "neutral"}>
            {config.enabled ? "Connected" : "Disabled"} · {PROVIDERS.find((p) => p.id === config.provider)?.label}
            {config.model ? ` · ${config.model}` : ""}
            {config.effort ? ` · ${EFFORT_LABEL[config.effort].toLowerCase()} effort` : ""}
          </Badge>
        ) : (
          <Badge>Not configured</Badge>
        )}
      </div>

      <form
        className="space-y-4 rounded-xl border border-border bg-surface p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Provider" htmlFor="ai-provider" hint={meta.help}>
          <Select
            id="ai-provider"
            value={provider}
            onChange={(e) => {
              const next = e.target.value as AiProviderKind;
              const saved = config.saved[next];
              setProvider(next);
              const nextModel = saved ? saved.model : PROVIDERS.find((p) => p.id === next)!.model;
              const nextOptions = optionsFor(next, config);
              setModel(nextModel);
              setEffort(saved?.effort ?? null);
              setCustomModel(nextOptions.length > 0 && !nextOptions.some((o) => o.value === nextModel));
              setBaseUrl(saved?.baseUrl ?? "");
              setTestResult(null);
              setApiKey("");
              setReplaceKey(false);
            }}
          >
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        {meta.subscription && (
          <div className="flex items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 text-[13px]">
            <Terminal className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <div className="space-y-1 text-muted">
              <p>
                Requires{" "}
                {provider === "claude_code" ? (
                  <>
                    <a className="underline" href="https://claude.com/claude-code" target="_blank" rel="noreferrer">
                      Claude Code
                    </a>{" "}
                    installed and signed in (run <code className="text-text">claude</code> once and log in).
                  </>
                ) : (
                  <>
                    the{" "}
                    <a
                      className="underline"
                      href="https://developers.openai.com/codex/cli"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Codex CLI
                    </a>{" "}
                    installed and signed in (<code className="text-text">codex login</code>).
                  </>
                )}{" "}
                Each request starts the CLI, so answers take a few seconds longer to begin. It has no access to your
                files or the web; Paperweave supplies all the material.
              </p>
              <p className="flex items-start gap-1.5">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                For your own computer only: everyone who uses this Paperweave server would use this subscription.
              </p>
            </div>
          </div>
        )}
        <Field
          label="Default model"
          htmlFor="ai-model"
          hint={
            customModel || !modelOptions.length
              ? "The model identifier exactly as the provider expects it."
              : meta.modelHint
          }
        >
          {modelOptions.length > 0 && (
            <Select
              id={customModel ? undefined : "ai-model"}
              aria-label={customModel ? "Model choice" : undefined}
              value={customModel ? CUSTOM_MODEL : model}
              onChange={(e) => {
                if (e.target.value === CUSTOM_MODEL) {
                  setCustomModel(true);
                  setModel("");
                } else {
                  setCustomModel(false);
                  setModel(e.target.value);
                  // Keep the effort only if the new model supports it.
                  if (effort && !effortsFor(provider, e.target.value, modelOptions).some((o) => o.value === effort)) {
                    setEffort(null);
                  }
                }
              }}
            >
              {modelOptions.map((o) => (
                <option key={o.value || "default"} value={o.value}>
                  {o.description ? `${o.label} — ${o.description}` : o.label}
                </option>
              ))}
              <option value={CUSTOM_MODEL}>Other (type a model name)…</option>
            </Select>
          )}
          {(customModel || !modelOptions.length) && (
            <Input
              id="ai-model"
              className={modelOptions.length ? "mt-2" : undefined}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={meta.model || "model-name"}
              autoFocus={customModel}
              required={provider !== "codex"}
            />
          )}
        </Field>
        {effortChoices.length > 0 && (
          <Field
            label="Default effort"
            htmlFor="ai-effort"
            hint="How long the model thinks before answering. Higher effort helps with hard questions and deep research, but is slower and uses more of your plan or budget. While working, you can switch the model and effort with the ✦ picker next to each AI feature."
          >
            <Select
              id="ai-effort"
              value={effort ?? ""}
              onChange={(e) => setEffort((e.target.value || null) as AiEffort | null)}
            >
              <option value="">
                {modelDefaultEffort
                  ? `Default (${EFFORT_LABEL[modelDefaultEffort]} for this model)`
                  : "Default (chosen by the provider)"}
              </option>
              {effortChoices.map((o) => (
                <option key={o.value} value={o.value}>
                  {EFFORT_LABEL[o.value]} — {o.description ?? EFFORT_HINT[o.value]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {meta.baseUrl !== "none" && (
          <Field
            label={meta.baseUrl === "required" ? "Base URL" : "Base URL (optional)"}
            htmlFor="ai-base"
            hint={
              meta.baseUrl === "optional"
                ? "Leave empty to use the provider's default endpoint, or set a gateway/proxy URL."
                : undefined
            }
          >
            <Input
              id="ai-base"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={meta.baseUrlPlaceholder}
              required={meta.baseUrl === "required"}
            />
          </Field>
        )}
        {meta.id !== "mock" && !meta.subscription && (
          <Field label={meta.needsKey ? "API key" : "API key (if required)"} htmlFor="ai-key">
            {keyStored && !replaceKey ? (
              <div className="flex items-center gap-2 text-sm">
                <KeyRound className="size-4 text-muted" aria-hidden />
                <span>Key saved (ends in {remembered?.apiKeyLast4})</span>
                <Button size="sm" variant="ghost" onClick={() => setReplaceKey(true)}>
                  Replace
                </Button>
              </div>
            ) : (
              <Input
                id="ai-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={meta.needsKey ? "sk-…" : "Optional"}
              />
            )}
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable AI features
        </label>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
          {config?.configured && (
            <>
              <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
                Test connection
              </Button>
              <Button variant="danger-ghost" onClick={() => remove.mutate()} loading={remove.isPending}>
                Remove provider
              </Button>
            </>
          )}
        </div>
        {testResult && (
          <p
            className="flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2 text-sm text-success"
            role="status"
          >
            <CheckCircle2 className="size-4" aria-hidden />
            {testResult}
          </p>
        )}
      </form>
    </div>
  );
}
