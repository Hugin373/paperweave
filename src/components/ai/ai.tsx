"use client";

import { BookOpenText, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Markdown } from "@/components/ui/markdown";
import { Spinner } from "@/components/ui/spinner";
import { describeBasis } from "@/lib/ai-basis";
import { cn } from "@/lib/cn";
import type { AiBasis } from "@/lib/types";

/** Visual label that marks content as AI-generated (never mixed with scholarly metadata). */
export function AiLabel({ model, className }: { model?: string | null; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11.5px] font-medium text-ai", className)}>
      <Sparkles className="size-3" aria-hidden />
      AI-generated{model ? ` · ${model}` : ""} — verify against the paper
    </span>
  );
}

/** What an AI answer was based on (full text, the matching pages, or only the abstract). */
export function AiBasisLine({ basis, className }: { basis: AiBasis; className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-[12px] text-subtle", className)}>
      <BookOpenText className="mt-px size-3.5 shrink-0" aria-hidden />
      {describeBasis(basis)}
    </p>
  );
}

/** A spinner with the provider's latest progress note and the time elapsed. */
export function AiWorking({ status, startedAt }: { status?: string | null; startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const seconds = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : null;
  const label = `${status ?? "Thinking"}…${seconds !== null && seconds >= 2 ? ` ${seconds}s` : ""}`;
  return <Spinner label={label} />;
}

export function AiOutput({
  text,
  loading,
  error,
  model,
  actions,
  basis,
  status,
  startedAt,
  className,
}: {
  text: string;
  loading?: boolean;
  error?: string | null;
  model?: string | null;
  actions?: ReactNode;
  /** What the answer was based on, shown under it. */
  basis?: AiBasis | null;
  /** Progress note while waiting for the first words. */
  status?: string | null;
  /** When the request started, for the elapsed time while waiting. */
  startedAt?: number;
  className?: string;
}) {
  if (!text && !loading && !error) return null;
  return (
    <div
      className={cn("animate-fade-in rounded-xl border border-ai/20 bg-ai-soft/40 p-3.5", className)}
      aria-live="polite"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <AiLabel model={model} />
        {actions}
      </div>
      {text && <Markdown>{text}</Markdown>}
      {loading && !text && <AiWorking status={status} startedAt={startedAt} />}
      {error && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {basis && <AiBasisLine basis={basis} className="mt-2.5 border-t border-ai/15 pt-2" />}
    </div>
  );
}

/** Shown instead of AI actions when no provider is configured. Never blocks core features. */
export function AiNotConfigured({ compact }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border border-dashed border-border text-muted",
        compact ? "p-2.5 text-[12.5px]" : "p-3.5 text-sm",
      )}
    >
      <Sparkles className="mt-0.5 size-4 shrink-0 text-ai" aria-hidden />
      <p>
        AI is optional.{" "}
        <Link href="/settings?tab=ai" className="font-medium text-accent-text hover:underline">
          Connect a provider
        </Link>{" "}
        if you want explanations and AI assistance.
      </p>
    </div>
  );
}
