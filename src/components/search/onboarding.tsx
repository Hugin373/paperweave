"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useMe } from "@/lib/hooks";

/** Lightweight getting-started checklist; steps tick themselves off as the user works. */
export function Onboarding() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => api("/api/me", { method: "PATCH", body: { onboardingDismissed: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  if (!me || me.onboardingDismissed) return null;
  const s = me.stats;
  const steps = [
    { label: "Search for a paper or research topic", done: s.papers > 0, href: null },
    { label: "Save interesting papers to your library", done: s.papers > 0, href: "/library" },
    { label: "Explore references and citations of a paper", done: s.papers > 0, href: null },
    { label: "Read a PDF and highlight passages", done: s.highlights > 0, href: "/library" },
    { label: "Write a note", done: s.notes > 0, href: "/notes/new" },
    { label: "Create a concept and link papers to it", done: s.concepts > 0, href: "/concepts?new=1" },
    { label: "Explore your knowledge graph", done: s.papers + s.notes + s.concepts > 2, href: "/graph" },
    { label: "Optional: connect an AI provider", done: me.ai.configured, href: "/settings?tab=ai" },
  ];
  const completed = steps.filter((x) => x.done).length;
  return (
    <section
      aria-labelledby="onboarding-title"
      className="relative rounded-xl border border-border bg-surface p-5 shadow-xs"
    >
      <button
        type="button"
        onClick={() => dismiss.mutate()}
        className="absolute top-3 right-3 rounded-md p-1 text-subtle hover:bg-surface-2 hover:text-text"
        aria-label="Dismiss getting started"
      >
        <X className="size-4" />
      </button>
      <h2 id="onboarding-title" className="font-semibold">
        Getting started
      </h2>
      <p className="mt-0.5 text-sm text-muted">
        The research loop: find papers → save → explore lineage → read → take notes → connect ideas. {completed}/
        {steps.length} done.
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${(completed / steps.length) * 100}%` }}
        />
      </div>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2">
        {steps.map((step, i) => (
          <li key={step.label} className="flex items-center gap-2.5 text-sm">
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                step.done ? "border-success bg-success text-white" : "border-border-strong text-muted",
              )}
              aria-hidden
            >
              {step.done ? <Check className="size-3" /> : i + 1}
            </span>
            {step.href && !step.done ? (
              <Link href={step.href} className="hover:text-accent-text hover:underline">
                {step.label}
              </Link>
            ) : (
              <span className={cn(step.done && "text-muted line-through decoration-border-strong")}>{step.label}</span>
            )}
          </li>
        ))}
      </ol>
      {completed === steps.length && (
        <Button size="sm" variant="secondary" className="mt-4" onClick={() => dismiss.mutate()}>
          Done — hide this
        </Button>
      )}
    </section>
  );
}
