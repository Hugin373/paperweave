"use client";

import { MessageSquarePlus, Sparkles, MessageCircleQuestion, NotebookPen, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import type { HighlightRect } from "@/lib/types";
import { HIGHLIGHT_COLORS, type HighlightColor } from "./geometry";

export interface PendingSelection {
  pageNumber: number;
  rects: HighlightRect[];
  text: string;
  prefix: string;
  suffix: string;
  /** Position inside the scroll container's content box (px). */
  left: number;
  top: number;
}

export function ColorSwatch({
  color,
  onClick,
  active,
  size = "md",
}: {
  color: HighlightColor;
  onClick: () => void;
  active?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${color} highlight`}
      aria-pressed={active}
      className={cn(
        "rounded-full border border-black/10 transition-transform hover:scale-110",
        size === "md" ? "size-6" : "size-4",
        active && "ring-2 ring-accent ring-offset-1 ring-offset-surface",
      )}
      style={{ background: `linear-gradient(var(--hl-${color}), var(--hl-${color})), #fff` }}
    />
  );
}

/**
 * A floating panel centred on (left, top) inside the scroll container, kept within its visible width
 * (it wraps onto more rows when the viewer is narrow, e.g. with a wide sidebar).
 */
function Shell({
  left,
  top,
  children,
  label,
}: {
  left: number;
  top: number;
  children: React.ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.offsetParent as HTMLElement | null;
    if (!el || !box) return;
    const margin = 8;
    const min = box.scrollLeft + margin;
    const max = box.scrollLeft + box.clientWidth - margin - el.offsetWidth;
    el.style.left = `${Math.max(min, Math.min(max, left - el.offsetWidth / 2))}px`;
  });
  return (
    <div
      ref={ref}
      data-reader-popover
      role="dialog"
      aria-label={label}
      className="absolute z-30 w-max max-w-[min(40rem,calc(100%-1rem))] rounded-xl border border-border bg-surface p-2 shadow-xl"
      style={{ left: Math.max(8, left - 180), top }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/** Actions for a text selection: highlight colors, comment, and (optionally) AI. */
export function SelectionPopover({
  selection,
  aiEnabled,
  onHighlight,
  onAi,
  onQuote,
  onClose,
}: {
  selection: PendingSelection;
  aiEnabled: boolean;
  onHighlight: (color: HighlightColor, comment?: string) => Promise<void>;
  onAi: (question?: string) => void;
  /** Adds the selected passage to the paper note open in the sidebar. */
  onQuote?: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"menu" | "comment" | "ask">("menu");
  const [comment, setComment] = useState("");
  const [color, setColor] = useState<HighlightColor>("yellow");
  const [question, setQuestion] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (c: HighlightColor, text?: string) => {
    setSaving(true);
    try {
      await onHighlight(c, text);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Shell left={selection.left} top={selection.top} label="Selection actions">
      {mode === "menu" && (
        <div className="flex flex-wrap items-center gap-1.5">
          {aiEnabled && (
            <>
              <Button size="sm" variant="ai" onClick={() => onAi()}>
                <Sparkles />
                Explain
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("ask")} aria-label="Ask AI about the selection">
                <MessageCircleQuestion />
                Ask…
              </Button>
              <div className="mx-0.5 h-6 w-px bg-border" aria-hidden />
            </>
          )}
          <div className="flex items-center gap-1.5 px-1" role="group" aria-label="Highlight color">
            {HIGHLIGHT_COLORS.map((c) => (
              <ColorSwatch key={c} color={c} onClick={() => void save(c)} />
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setMode("comment")} disabled={saving}>
            <MessageSquarePlus />
            Comment
          </Button>
          {onQuote && (
            <Button size="sm" variant="ghost" onClick={onQuote} disabled={saving}>
              <NotebookPen />
              Add to note
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close" className="ml-auto">
            <X />
          </Button>
        </div>
      )}
      {mode === "comment" && (
        <form
          className="w-72 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save(color, comment.trim());
          }}
        >
          <p className="line-clamp-2 border-l-2 border-border pl-2 text-[12.5px] text-muted italic">{selection.text}</p>
          <Textarea
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Your annotation…"
            rows={3}
            aria-label="Annotation"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save(color, comment.trim());
              }
            }}
          />
          <div className="flex items-center justify-between">
            <div className="flex gap-1.5" role="group" aria-label="Highlight color">
              {HIGHLIGHT_COLORS.map((c) => (
                <ColorSwatch key={c} color={c} size="sm" active={c === color} onClick={() => setColor(c)} />
              ))}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setMode("menu")}>
                Back
              </Button>
              <Button size="sm" variant="primary" type="submit" loading={saving}>
                Save
              </Button>
            </div>
          </div>
        </form>
      )}
      {mode === "ask" && (
        <form
          className="flex w-80 items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) onAi(question.trim());
          }}
        >
          <Input
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this passage…"
            aria-label="Question about the selected passage"
            className="h-8"
          />
          <Button size="sm" variant="ai" type="submit" disabled={!question.trim()}>
            Ask
          </Button>
        </form>
      )}
    </Shell>
  );
}

/** Comment box for a new page note placed by clicking on the page. */
export function NoteDraftPopover({
  left,
  top,
  onSave,
  onCancel,
}: {
  left: number;
  top: number;
  onSave: (comment: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Shell left={left} top={top} label="New page note">
      <form
        className="w-72 space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setSaving(true);
          try {
            await onSave(text.trim());
          } finally {
            setSaving(false);
          }
        }}
      >
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="Write a note for this spot…"
          aria-label="Page note"
        />
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" loading={saving} disabled={!text.trim()}>
            Add note
          </Button>
        </div>
      </form>
    </Shell>
  );
}
