"use client";

import { Highlighter, NotebookPen, Sparkles, StickyNote, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AiNotConfigured } from "@/components/ai/ai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { relativeTime } from "@/lib/format";
import type { HighlightDto, NoteSummary } from "@/lib/types";
import { HIGHLIGHT_COLORS, type HighlightColor } from "./geometry";
import { ReaderAssistant, type ReaderAiRequest } from "./reader-assistant";
import { ReaderNotes, type QuoteRequest } from "./reader-notes";
import { ColorSwatch } from "./selection-popover";

export type SidebarTab = "highlights" | "notes" | "ai";

function HighlightItem({
  h,
  selected,
  onJump,
  onUpdate,
  onDelete,
}: {
  h: HighlightDto;
  selected: boolean;
  /** Absent for a highlight whose text is not in this version of the PDF. */
  onJump?: () => void;
  onUpdate: (patch: { color?: HighlightColor; comment?: string }) => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(h.comment);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const startEdit = () => {
    setDraft(h.comment);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== h.comment) onUpdate({ comment: draft.trim() });
  };

  return (
    <li
      ref={ref}
      className="rounded-lg border border-border bg-surface p-2.5 text-[13px] transition-colors"
      style={
        selected
          ? {
              borderColor: `var(--hl-${h.kind === "note" ? "yellow" : h.color}-strong)`,
              boxShadow: `0 0 0 1px var(--hl-${h.kind === "note" ? "yellow" : h.color}-strong)`,
            }
          : undefined
      }
    >
      <button
        type="button"
        onClick={onJump}
        disabled={!onJump}
        className="block w-full text-left disabled:cursor-default"
        aria-label={onJump ? `Go to highlight on page ${h.pageNumber}` : "Highlight not found in this version"}
      >
        {h.kind === "note" ? (
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-warning">
            <StickyNote className="size-3.5" aria-hidden />
            Page note
          </span>
        ) : (
          <span
            className="line-clamp-4 rounded-sm px-1 leading-relaxed text-text"
            style={{ background: `var(--hl-${h.color})` }}
          >
            {h.selectedText}
          </span>
        )}
      </button>
      {editing ? (
        <div className="mt-2 space-y-1.5">
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            aria-label="Annotation"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
              if (e.key === "Escape") {
                setDraft(h.comment);
                setEditing(false);
              }
            }}
          />
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(h.comment);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={commit}>
              Save
            </Button>
          </div>
        </div>
      ) : h.comment ? (
        <button
          type="button"
          onClick={startEdit}
          className="mt-2 block w-full rounded-md bg-surface-2 px-2 py-1.5 text-left whitespace-pre-wrap text-text/90 hover:bg-surface-3"
          aria-label="Edit annotation"
        >
          {h.comment}
        </button>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5">
        <span className="text-[11.5px] text-subtle">
          p. {h.pageNumber} · {relativeTime(h.createdAt)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {h.kind === "highlight" &&
            HIGHLIGHT_COLORS.map((c) => (
              <ColorSwatch
                key={c}
                color={c}
                size="sm"
                active={c === h.color}
                onClick={() => c !== h.color && onUpdate({ color: c })}
              />
            ))}
          {!editing && !h.comment && (
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[12px]" onClick={startEdit}>
              Comment
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="danger-ghost"
            onClick={onDelete}
            aria-label="Delete highlight"
            className="size-6"
          >
            <Trash2 className="!size-3.5" />
          </Button>
        </div>
      </div>
    </li>
  );
}

export function ReaderSidebar({
  paperId,
  tab,
  onTabChange,
  highlights,
  selectedId,
  onJump,
  onUpdate,
  onDelete,
  notes,
  paperTitle,
  quote,
  aiEnabled,
  page,
  aiRequest,
  onJumpToPage,
}: {
  paperId: string;
  tab: SidebarTab;
  onTabChange: (t: SidebarTab) => void;
  highlights: HighlightDto[];
  selectedId: string | null;
  onJump: (h: HighlightDto) => void;
  onUpdate: (id: string, patch: { color?: HighlightColor; comment?: string }) => void;
  onDelete: (id: string) => void;
  notes: NoteSummary[];
  paperTitle: string;
  quote: QuoteRequest | null;
  aiEnabled: boolean;
  /** The page on screen, given to the assistant with each question. */
  page: number | null;
  /** A passage sent from the PDF to the assistant. */
  aiRequest: ReaderAiRequest | null;
  /** Scrolls the PDF to a page (page links in the assistant's answers). */
  onJumpToPage?: (page: number) => void;
}) {
  const placed = highlights.filter((h) => !h.lost);
  const lost = highlights.filter((h) => h.lost);
  const pages = [...new Set(placed.map((h) => h.pageNumber))].sort((a, b) => a - b);
  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as SidebarTab)} className="flex h-full min-h-0 flex-col">
      <TabsList className="shrink-0 px-2">
        <TabsTrigger value="highlights">
          <Highlighter aria-hidden />
          Highlights{highlights.length ? ` (${highlights.length})` : ""}
        </TabsTrigger>
        <TabsTrigger value="notes">
          <NotebookPen aria-hidden />
          Notes
        </TabsTrigger>
        <TabsTrigger value="ai">
          <Sparkles aria-hidden />
          AI
        </TabsTrigger>
      </TabsList>

      <TabsContent value="highlights" className="min-h-0 flex-1 overflow-y-auto p-3">
        {!highlights.length ? (
          <EmptyState
            icon={Highlighter}
            title="No highlights yet"
            description="Select text in the PDF to highlight it or add an annotation. Use “Add note” to pin a note anywhere on a page."
            className="py-8"
          />
        ) : (
          <div className="space-y-4">
            {pages.map((p) => (
              <section key={p} aria-label={`Page ${p}`}>
                <h3 className="mb-1.5 text-[11.5px] font-medium tracking-wide text-subtle uppercase">Page {p}</h3>
                <ul className="space-y-2">
                  {placed
                    .filter((h) => h.pageNumber === p)
                    .map((h) => (
                      <HighlightItem
                        key={h.id}
                        h={h}
                        selected={h.id === selectedId}
                        onJump={() => onJump(h)}
                        onUpdate={(patch) => onUpdate(h.id, patch)}
                        onDelete={() => onDelete(h.id)}
                      />
                    ))}
                </ul>
              </section>
            ))}
            {lost.length > 0 && (
              <section aria-label="Highlights not found in this version">
                <h3 className="mb-1 text-[11.5px] font-medium tracking-wide text-subtle uppercase">
                  Not found in this version
                </h3>
                <p className="mb-1.5 text-[12px] text-muted">
                  Their text was changed or removed in a newer version of the PDF. Their text and comments are kept.
                </p>
                <ul className="space-y-2">
                  {lost.map((h) => (
                    <HighlightItem
                      key={h.id}
                      h={h}
                      selected={h.id === selectedId}
                      onUpdate={(patch) => onUpdate(h.id, patch)}
                      onDelete={() => onDelete(h.id)}
                    />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </TabsContent>

      {/* Kept mounted so switching tabs never interrupts autosave or loses the cursor. */}
      <TabsContent value="notes" forceMount className="min-h-0 flex-1 overflow-y-auto p-3 data-[state=inactive]:hidden">
        <ReaderNotes paperId={paperId} paperTitle={paperTitle} notes={notes} quote={quote} />
      </TabsContent>

      <TabsContent value="ai" className="flex min-h-0 flex-1 flex-col">
        {!aiEnabled ? (
          <div className="p-3">
            <AiNotConfigured />
          </div>
        ) : (
          <ReaderAssistant paperId={paperId} page={page} request={aiRequest} onJumpToPage={onJumpToPage} />
        )}
      </TabsContent>
    </Tabs>
  );
}
