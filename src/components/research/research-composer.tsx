"use client";

import { ArrowUp, Compass, FolderOpen, Globe, MessagesSquare, Square, Telescope, Wand2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import type { ResearchMode } from "@/lib/types";
import { usePersistentState } from "@/lib/use-persistent-state";

export const MODE_INFO: Record<ResearchMode, { label: string; hint: string; icon: typeof Telescope }> = {
  chat: {
    label: "Chat",
    hint: "Uses your library, notes, highlights and concepts.",
    icon: MessagesSquare,
  },
  search: {
    label: "Literature search",
    hint: "Also searches the scholarly literature (Semantic Scholar, OpenAlex) and follows citations.",
    icon: Globe,
  },
  deep: {
    label: "Deep research",
    hint: "Searches in several rounds, follows citations and reads key papers, then writes a cited report. Takes a few minutes.",
    icon: Telescope,
  },
  field: {
    label: "Field analysis",
    hint: "Maps a whole field: publication trends, the main sub-areas, current gaps and possible research directions. Takes longer than deep research.",
    icon: Compass,
  },
};

function ToolToggle({
  on,
  onChange,
  icon: Icon,
  label,
  hint,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  icon: typeof Telescope;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={hint}>
      <button
        type="button"
        aria-pressed={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors disabled:opacity-60",
          on
            ? "border-ai/30 bg-ai-soft text-ai"
            : "border-border text-muted hover:border-border-strong hover:text-text",
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {label}
      </button>
    </Tooltip>
  );
}

/** The assistant's per-message tools: literature search, and deep research or field analysis (which imply search). */
export function ModeToggles({ value, onChange }: { value: ResearchMode; onChange: (m: ResearchMode) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Assistant tools">
      <ToolToggle
        on={value !== "chat"}
        disabled={value === "deep" || value === "field"}
        onChange={(on) => onChange(on ? "search" : "chat")}
        icon={MODE_INFO.search.icon}
        label={MODE_INFO.search.label}
        hint={MODE_INFO.search.hint}
      />
      <ToolToggle
        on={value === "deep"}
        onChange={(on) => onChange(on ? "deep" : "search")}
        icon={MODE_INFO.deep.icon}
        label={MODE_INFO.deep.label}
        hint={MODE_INFO.deep.hint}
      />
      <ToolToggle
        on={value === "field"}
        onChange={(on) => onChange(on ? "field" : "search")}
        icon={MODE_INFO.field.icon}
        label={MODE_INFO.field.label}
        hint={MODE_INFO.field.hint}
      />
    </div>
  );
}

/** Whether proposed workspace changes are applied right away (remembered in this browser). */
export function useAutoApply() {
  const [value, set] = usePersistentState("pw-assistant-auto-apply", "off", ["on", "off"] as const);
  return [value === "on", (on: boolean) => set(on ? "on" : "off")] as const;
}

/** Removable chip showing what the research is pointed at. */
export function ScopeChip({
  label,
  kind,
  onRemove,
}: {
  label: string;
  kind: "paper" | "collection";
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 py-0.5 pr-1 pl-2.5 text-[12.5px]">
      {kind === "collection" && <FolderOpen className="size-3.5 shrink-0 text-muted" aria-hidden />}
      <span className="truncate" title={label}>
        {label}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="rounded-full p-0.5 text-subtle hover:bg-surface-3 hover:text-text"
          aria-label={`Remove ${label}`}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

/**
 * Question box with a mode toggle. Enter sends, Shift+Enter adds a line. While research runs,
 * the send button becomes a stop button.
 */
export function ResearchComposer({
  onSubmit,
  onStop,
  running,
  pending,
  disabled,
  defaultMode,
  initialText = "",
  placeholder,
  label,
  chips,
  footer,
  autoFocus,
  large,
}: {
  /** Rejecting keeps the text in the box. */
  onSubmit: (question: string, mode: ResearchMode, autoApply: boolean) => Promise<unknown>;
  onStop?: () => void;
  running?: boolean;
  pending?: boolean;
  disabled?: boolean;
  defaultMode: ResearchMode;
  initialText?: string;
  placeholder: string;
  label: string;
  chips?: ReactNode;
  footer?: ReactNode;
  autoFocus?: boolean;
  large?: boolean;
}) {
  const [text, setText] = useState(initialText);
  const [mode, setMode] = useState<ResearchMode>(defaultMode);
  const [autoApply, setAutoApply] = useAutoApply();
  const canSend = text.trim().length >= 3 && !running && !pending && !disabled;

  const send = async () => {
    if (!canSend) return;
    try {
      await onSubmit(text.trim(), mode, autoApply);
      setText("");
    } catch {
      /* the caller reports the error; keep the text so it can be retried */
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      className="rounded-2xl border border-border bg-surface shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20"
    >
      {chips && <div className="flex flex-wrap gap-1.5 px-3 pt-3">{chips}</div>}
      <label className="sr-only" htmlFor={`composer-${label}`}>
        {label}
      </label>
      <textarea
        id={`composer-${label}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        rows={large ? 3 : 1}
        maxLength={4000}
        className={cn(
          "block field-sizing-content max-h-60 w-full resize-none bg-transparent px-4 pt-3 text-[15px] leading-relaxed outline-none placeholder:text-subtle focus-visible:outline-none disabled:opacity-60",
          large ? "min-h-24" : "min-h-11",
        )}
      />
      <div className="flex flex-wrap items-center gap-2 px-3 pt-1 pb-3">
        <ModeToggles value={mode} onChange={setMode} />
        <ToolToggle
          on={autoApply}
          onChange={setAutoApply}
          icon={Wand2}
          label="Auto-apply"
          hint="Apply workspace changes (saving papers, collections, tags, concepts, notes) right away instead of asking first. You can always undo them."
        />
        <div className="min-w-0 flex-1">{footer}</div>
        {running && onStop ? (
          <Button type="button" variant="secondary" size="sm" onClick={onStop} aria-label="Stop">
            <Square className="fill-current" />
            Stop
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            size={large ? "md" : "icon"}
            disabled={!canSend}
            loading={pending}
            aria-label={large ? undefined : "Send"}
          >
            {!pending && <ArrowUp />}
            {large && (mode === "deep" || mode === "field" ? "Start research" : "Send")}
          </Button>
        )}
      </div>
    </form>
  );
}
