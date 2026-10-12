"use client";

import { CircleHelp, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ASSISTANT_CANNOT, ASSISTANT_CAPABILITIES } from "@/lib/assistant-capabilities";
import type { ResearchMode as Mode } from "@/lib/types";

/**
 * Everything the assistant can do, with example requests. `onPick` makes the examples clickable (they fill
 * the message box).
 */
export function CapabilitiesList({ onPick }: { onPick?: (text: string, mode: Mode) => void }) {
  return (
    <div className="space-y-5">
      <p className="flex items-start gap-2 rounded-lg bg-surface-2/70 px-3 py-2 text-[13px] text-muted">
        <Undo2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          Changes to your workspace are proposals: you review them and apply them (or turn on Auto-apply), and every
          applied change can be undone.
        </span>
      </p>
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {ASSISTANT_CAPABILITIES.map((c) => (
          <section key={c.title}>
            <h3 className="text-[13.5px] font-semibold">
              {c.title}
              {c.note && <span className="ml-1.5 text-[12px] font-normal text-subtle">({c.note})</span>}
            </h3>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[13px] text-text/85 marker:text-subtle">
              {c.items.map((i) => (
                <li key={i.text}>{i.text}</li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {c.examples.map((e) =>
                onPick ? (
                  <button
                    key={e.text}
                    type="button"
                    onClick={() => onPick(e.text, e.mode ?? "chat")}
                    className="rounded-full border border-border bg-surface px-2.5 py-1 text-left text-[12px] text-muted hover:border-border-strong hover:text-text"
                  >
                    {e.text}
                  </button>
                ) : (
                  <span
                    key={e.text}
                    className="rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] text-muted"
                  >
                    “{e.text}”
                  </span>
                ),
              )}
            </div>
          </section>
        ))}
      </div>
      <section>
        <h3 className="text-[13.5px] font-semibold">Only you can</h3>
        <ul className="mt-1.5 space-y-1 text-[13px] text-text/85">
          {ASSISTANT_CANNOT.map((c) => (
            <li key={c.what}>
              {c.what} <span className="text-subtle">— {c.where}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-[12.5px] text-subtle">
          If you ask for one of these, the assistant tells you where to do it.
        </p>
      </section>
    </div>
  );
}

/** A "What can it do?" button that opens the list (for the conversation page). */
export function CapabilitiesButton() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <CircleHelp />
          What can it do?
        </Button>
      </DialogTrigger>
      <DialogContent title="What can the Assistant do?" wide>
        <div className="max-h-[70vh] overflow-y-auto pr-1">
          <CapabilitiesList />
        </div>
      </DialogContent>
    </Dialog>
  );
}
