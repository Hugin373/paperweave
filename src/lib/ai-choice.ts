"use client";

import { useCallback } from "react";
import { AI_CHOICE_KEY } from "./api";
import { AI_EFFORTS, type AiChoice, type AiConfigDto } from "./types";
import { usePersistentState } from "./use-persistent-state";

function parse(raw: string): AiChoice | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AiChoice>;
    if (typeof v.provider !== "string" || typeof v.model !== "string") return null;
    const effort = v.effort && AI_EFFORTS.includes(v.effort) ? v.effort : null;
    return { provider: v.provider, model: v.model, effort };
  } catch {
    return null;
  }
}

/**
 * The AI model picked while working (null = the workspace default from Settings). It is remembered in
 * this browser and sent with every AI request, so switching it in one place applies everywhere.
 */
export function useAiChoice(config: AiConfigDto | undefined) {
  const [raw, setRaw] = usePersistentState<string>(AI_CHOICE_KEY, "");
  const stored = parse(raw);
  // A choice whose provider is no longer connected falls back to the default.
  const choice = stored && config && config.connected.includes(stored.provider) ? stored : null;
  const setChoice = useCallback((next: AiChoice | null) => setRaw(next ? JSON.stringify(next) : ""), [setRaw]);
  return { choice, stale: !!stored && !!config && !choice, setChoice };
}
