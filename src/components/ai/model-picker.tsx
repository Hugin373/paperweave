"use client";

import { Check, ChevronDown, Gauge, Settings, Sparkles } from "lucide-react";
import Link from "next/link";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu";
import { useAiChoice } from "@/lib/ai-choice";
import {
  EFFORT_HINT,
  EFFORT_LABEL,
  effortsFor,
  blankModelLabel,
  modelLabel,
  optionsFor,
  PROVIDERS,
  PROVIDER_SHORT,
} from "@/lib/ai-models";
import { cn } from "@/lib/cn";
import { useAiConfig } from "@/lib/hooks";
import type { AiChoice, AiConfigDto, AiEffort, AiModelOption, AiProviderKind } from "@/lib/types";

/** Models listed for a connected provider, including a custom saved model. */
function pickerModels(provider: AiProviderKind, config: AiConfigDto): AiModelOption[] {
  const options = optionsFor(provider, config);
  const saved = config.saved[provider]?.model;
  if (saved !== undefined && !options.some((o) => o.value === saved)) {
    return [...options, { value: saved, label: saved || blankModelLabel(provider) }];
  }
  return options;
}

function describe(c: AiChoice, config: AiConfigDto, withProvider: boolean) {
  return [
    withProvider && PROVIDER_SHORT[c.provider],
    modelLabel(c.provider, c.model, config),
    c.effort && EFFORT_LABEL[c.effort],
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Compact picker for the AI model and effort used by AI features, next to where they are used.
 * "Default" follows Settings → AI; any other pick is remembered in this browser and applies to every
 * AI feature until changed.
 */
export function ModelPicker({ className, align = "start" }: { className?: string; align?: "start" | "end" }) {
  const { data: config } = useAiConfig();
  const { choice, setChoice } = useAiChoice(config);
  if (!config?.configured || !config.enabled || !config.provider) return null;

  const defaults: AiChoice = { provider: config.provider, model: config.model ?? "", effort: config.effort };
  const current = choice ?? defaults;
  const providers = PROVIDERS.map((p) => p.id).filter((id) => config.connected.includes(id));
  const manyProviders = providers.length > 1;
  const efforts = effortsFor(current.provider, current.model, optionsFor(current.provider, config));

  const pickModel = (provider: AiProviderKind, model: string) => {
    const supported = effortsFor(provider, model, optionsFor(provider, config));
    const effort: AiEffort | null = supported.some((e) => e.value === current.effort) ? current.effort : null;
    const next = { provider, model, effort };
    const isDefault =
      next.provider === defaults.provider && next.model === defaults.model && next.effort === defaults.effort;
    setChoice(isDefault ? null : next);
  };

  const pickEffort = (effort: AiEffort | null) => {
    const next = { ...current, effort };
    const isDefault =
      next.provider === defaults.provider && next.model === defaults.model && next.effort === defaults.effort;
    setChoice(isDefault ? null : next);
  };

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`AI model: ${describe(current, config, true)}${choice ? "" : " (default)"}`}
          title="AI model and effort for AI features"
          className={cn(
            "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-muted hover:bg-surface-2 hover:text-text data-[state=open]:bg-surface-2",
            className,
          )}
        >
          <Sparkles className="size-3.5 shrink-0 text-ai" aria-hidden />
          <span className="truncate">{describe(current, config, manyProviders)}</span>
          {!choice && <span className="shrink-0 text-subtle">· default</span>}
          <ChevronDown className="size-3.5 shrink-0 text-subtle" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align={align} className="max-h-[min(32rem,70vh)] w-80 overflow-y-auto">
        <MenuItem onSelect={() => setChoice(null)} className="items-start">
          <Check className={cn("mt-0.5", choice && "invisible")} aria-hidden />
          <span className="min-w-0">
            <span className="block">Default from Settings</span>
            <span className="block truncate text-[12px] text-subtle">{describe(defaults, config, true)}</span>
          </span>
        </MenuItem>
        {efforts.length > 0 && (
          <>
            <MenuSub>
              <MenuSubTrigger>
                <Gauge className="size-4 text-muted" aria-hidden />
                Effort
                <span className="ml-auto text-[12px] text-subtle">
                  {current.effort ? EFFORT_LABEL[current.effort] : "Default"}
                </span>
              </MenuSubTrigger>
              <MenuSubContent className="w-72">
                <MenuItem onSelect={() => pickEffort(null)}>
                  <Check className={cn(current.effort && "invisible")} aria-hidden />
                  Default
                </MenuItem>
                {efforts.map((e) => (
                  <MenuItem key={e.value} onSelect={() => pickEffort(e.value)} className="items-start">
                    <Check className={cn("mt-0.5", current.effort !== e.value && "invisible")} aria-hidden />
                    <span>
                      <span className="block">{EFFORT_LABEL[e.value]}</span>
                      <span className="block text-[12px] leading-snug text-subtle">
                        {e.description ?? EFFORT_HINT[e.value]}
                      </span>
                    </span>
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
          </>
        )}
        {providers.map((p) => (
          <div key={p} role="group" aria-label={PROVIDERS.find((x) => x.id === p)?.label}>
            <MenuSeparator />
            <MenuLabel>{PROVIDERS.find((x) => x.id === p)?.label}</MenuLabel>
            {pickerModels(p, config).map((o) => {
              const selected = !!choice && choice.provider === p && choice.model === o.value;
              return (
                <MenuItem key={o.value || "default"} onSelect={() => pickModel(p, o.value)} className="items-start">
                  <Check className={cn("mt-0.5", !selected && "invisible")} aria-hidden />
                  <span className="min-w-0">
                    <span className="block">{o.label}</span>
                    {o.description && (
                      <span className="block text-[12px] leading-snug text-subtle">{o.description}</span>
                    )}
                  </span>
                </MenuItem>
              );
            })}
          </div>
        ))}
        <MenuSeparator />
        <MenuItem asChild>
          <Link href="/settings?tab=ai">
            <Settings />
            Connect providers and set the default…
          </Link>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
