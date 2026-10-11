"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BellOff,
  BellRing,
  BookCheck,
  BookX,
  BookmarkPlus,
  Check,
  CircleAlert,
  FileDown,
  FilePenLine,
  Highlighter,
  FolderMinus,
  FolderPlus,
  Lightbulb,
  ListChecks,
  Link2,
  Loader2,
  Merge,
  NotebookPen,
  PencilLine,
  Tag,
  TagsIcon,
  Trash2,
  Unlink,
  Waypoints,
  Undo2,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useInvalidateLibrary } from "@/lib/mutations";
import { DESTRUCTIVE_CHANGE_KINDS } from "@/lib/types";
import type {
  ChangeKind,
  ChangeSet,
  PaperSummary,
  ProposedChange,
  ResearchMessageDto,
  SourcePriority,
} from "@/lib/types";

const KIND_ICON: Record<ChangeKind, LucideIcon> = {
  save_papers: BookmarkPlus,
  create_collection: FolderPlus,
  add_to_collection: FolderPlus,
  tag_papers: Tag,
  create_concept: Lightbulb,
  link_concept: Lightbulb,
  create_note: NotebookPen,
  attach_pdfs: FileDown,
  set_status: BookCheck,
  remove_from_collection: FolderMinus,
  unlink_concept: Unlink,
  relate_concepts: Waypoints,
  append_to_note: NotebookPen,
  link_note: Link2,
  merge_concepts: Merge,
  rename_concept: PencilLine,
  edit_note: FilePenLine,
  add_highlight: Highlighter,
  save_search: BellRing,
  start_screening: ListChecks,
  edit_collection: PencilLine,
  delete_collection: Trash2,
  untag_papers: TagsIcon,
  rename_tag: PencilLine,
  delete_tag: Trash2,
  edit_concept: PencilLine,
  delete_concept: Trash2,
  remove_from_library: BookX,
  stop_following: BellOff,
};

/** Kinds whose name can be edited before applying (for a rename: the new name). */
const NAMED: ChangeKind[] = [
  "create_collection",
  "create_concept",
  "create_note",
  "rename_concept",
  "edit_collection",
  "rename_tag",
];

/** A proposed note edit, block by block: what goes and what comes, for review before applying. */
function NoteEdits({ edits }: { edits: NonNullable<ProposedChange["edits"]> }) {
  const where = (e: (typeof edits)[number]) =>
    e.op === "insert" ? (e.block === 0 ? "New at the start" : `New after block ${e.block}`) : `Block ${e.block}`;
  return (
    <ol className="mt-1.5 space-y-1.5">
      {edits.map((e, i) => (
        <li key={i} className="rounded-md border border-border text-[12.5px]">
          <p className="border-b border-border px-2 py-0.5 text-[11.5px] text-subtle">
            {where(e)}
            {e.op === "delete" ? " · removed" : e.op === "replace" ? " · changed" : ""}
          </p>
          {e.before !== undefined && (
            <p className="bg-danger-soft/60 px-2 py-1 whitespace-pre-wrap text-text/80 line-through decoration-danger/50">
              {e.before || "(empty)"}
            </p>
          )}
          {e.after !== undefined && <p className="bg-success-soft/60 px-2 py-1 whitespace-pre-wrap">{e.after}</p>}
        </li>
      ))}
    </ol>
  );
}

function resultLink(c: ProposedChange): { href: string; label: string } | null {
  const r = c.result;
  if (c.status !== "applied" || !r) return null;
  if (r.collectionId) return { href: `/library?collection=${r.collectionId}`, label: "Open collection" };
  if (r.conceptId) return { href: `/concepts/${r.conceptId}`, label: "Open concept" };
  if (r.noteId) return { href: `/notes/${r.noteId}`, label: "Open note" };
  if (r.savedSearchId) return { href: "/alerts", label: "Open New papers" };
  if (r.screeningId) return { href: `/screening/${r.screeningId}`, label: "Open screening" };
  if (r.highlightId && c.paperIds[0]) {
    return { href: `/papers/${c.paperIds[0]}/read?highlight=${r.highlightId}`, label: "Open in reader" };
  }
  if (c.kind === "save_papers") return { href: "/library", label: "Open library" };
  return null;
}

const PRIORITY_ORDER: Record<SourcePriority, number> = { high: 0, medium: 1, low: 2 };

/** Concepts in the AI's priority order (most useful first), after the other changes in their order. */
function ordered(items: ProposedChange[]) {
  const concept = (c: ProposedChange) => c.kind === "create_concept" || c.kind === "link_concept";
  const rank = (c: ProposedChange) => PRIORITY_ORDER[c.priority ?? "medium"];
  return [...items.filter((c) => !concept(c)), ...items.filter(concept).sort((a, b) => rank(a) - rank(b))];
}

function PriorityBadge({ priority }: { priority: SourcePriority }) {
  return (
    <span
      className={cn(
        "ml-2 inline-flex items-center rounded-full px-1.5 align-middle text-[11px] leading-[1.6] font-medium",
        priority === "high"
          ? "bg-accent-soft text-accent-text"
          : priority === "medium"
            ? "bg-warning-soft text-warning"
            : "bg-surface-2 text-muted",
      )}
      title="How useful the AI thinks this concept is for connecting your library"
    >
      {priority === "high" ? "Recommended" : priority === "medium" ? "Useful" : "Optional"}
    </span>
  );
}

function PaperList({ ids, papers }: { ids: string[]; papers: Record<string, PaperSummary> }) {
  const [all, setAll] = useState(false);
  const shown = all ? ids : ids.slice(0, 4);
  return (
    <ul className="mt-1 space-y-0.5">
      {shown.map((id) => {
        const p = papers[id];
        return (
          <li key={id} className="truncate text-[12.5px] text-muted">
            <Link href={`/papers/${id}`} className="hover:text-text hover:underline">
              {p ? `${p.title}${p.year ? ` (${p.year})` : ""}` : "Paper"}
            </Link>
          </li>
        );
      })}
      {ids.length > 4 && (
        <li>
          <button type="button" onClick={() => setAll((v) => !v)} className="text-[12px] text-subtle hover:text-text">
            {all ? "Show fewer" : `+ ${ids.length - 4} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * The workspace changes an answer proposed: review (select, rename) and apply them, or undo them
 * once applied — including changes that were applied automatically.
 */
export function ChangesCard({
  threadId,
  message,
  papers,
}: {
  threadId: string;
  message: ResearchMessageDto;
  papers: Record<string, PaperSummary>;
}) {
  const set = message.changes!;
  const qc = useQueryClient();
  const invalidateLibrary = useInvalidateLibrary();
  // Selected by default, except concepts the AI ranked low (proposals may still arrive while the
  // answer is written, so the user's choices are kept as overrides of that default).
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const byId = new Map(set.items.map((c) => [c.id, c]));
  const isSelected = (id: string) => picked[id] ?? byId.get(id)?.priority !== "low";
  const [names, setNames] = useState<Record<string, string>>({});
  const running = message.status === "running";

  const update = useMutation({
    mutationFn: (body: { action: "apply" | "undo" | "dismiss"; itemIds?: string[]; names?: Record<string, string> }) =>
      api<ChangeSet>(`/api/research/${threadId}/messages/${message.id}/changes`, { body }),
    onSuccess: async (next, body) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["research", threadId] }),
        invalidateLibrary(),
        qc.invalidateQueries({ queryKey: ["concepts"] }),
        qc.invalidateQueries({ queryKey: ["notes"] }),
      ]);
      const failed = next.items.filter((c) => c.status === "failed").length;
      if (body.action === "apply") {
        if (failed) toast.warning(`${failed} change${failed === 1 ? "" : "s"} could not be applied.`);
        else toast.success("Changes applied");
      } else if (body.action === "undo") toast.success("Changes undone");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const proposed = set.status === "proposed";
  const count = set.items.filter((c) => isSelected(c.id)).length;
  const title =
    set.status === "proposed"
      ? running
        ? "Preparing changes…"
        : "Proposed changes"
      : set.status === "applied"
        ? set.autoApplied
          ? "Applied automatically"
          : "Applied changes"
        : set.status === "undone"
          ? "Changes undone"
          : "Changes dismissed";

  if (set.status === "dismissed") {
    return <p className="text-[12.5px] text-subtle">Proposed changes were dismissed.</p>;
  }

  return (
    <section aria-label="Workspace changes" className="rounded-xl border border-accent/30 bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        {running ? (
          <Loader2 className="size-4 animate-spin text-accent" aria-hidden />
        ) : (
          <Wand2 className="size-4 text-accent" aria-hidden />
        )}
        <h3 className="flex-1 text-[13.5px] font-semibold">{title}</h3>
        {proposed && !running && <span className="text-[12px] text-subtle">Nothing changes until you apply</span>}
      </header>
      <ul className="divide-y divide-border">
        {ordered(set.items).map((c) => {
          const Icon = KIND_ICON[c.kind];
          const link = resultLink(c);
          const editable = proposed && !running && NAMED.includes(c.kind);
          return (
            <li key={c.id} className={cn("flex gap-3 px-3.5 py-2.5", c.status === "undone" && "opacity-60")}>
              {proposed ? (
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                  checked={isSelected(c.id)}
                  disabled={running}
                  onChange={(e) => setPicked((p) => ({ ...p, [c.id]: e.target.checked }))}
                  aria-label={c.label}
                />
              ) : c.status === "applied" ? (
                <Check className="mt-0.5 size-4 shrink-0 text-success" aria-label="Applied" />
              ) : c.status === "failed" ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />
              ) : (
                <span className="mt-0.5 size-4 shrink-0" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "flex items-start gap-1.5 text-[13.5px]",
                    (c.status === "undone" || c.status === "skipped") && "line-through",
                  )}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      DESTRUCTIVE_CHANGE_KINDS.includes(c.kind) ? "text-danger" : "text-muted",
                    )}
                    aria-hidden
                  />
                  <span>
                    {c.label}
                    {c.priority && <PriorityBadge priority={c.priority} />}
                  </span>
                </p>
                {c.why && <p className="mt-0.5 text-[12.5px] text-text/80">{c.why}</p>}
                {editable && (
                  <input
                    value={names[c.id] ?? c.name ?? ""}
                    onChange={(e) => setNames((n) => ({ ...n, [c.id]: e.target.value }))}
                    aria-label={`Name for: ${c.label}`}
                    maxLength={300}
                    className="mt-1.5 h-7 w-full max-w-sm rounded-md border border-border bg-bg px-2 text-[13px] focus:border-accent focus:outline-none"
                  />
                )}
                {c.description && <p className="mt-0.5 text-[12.5px] text-muted">{c.description}</p>}
                {c.edits?.length ? <NoteEdits edits={c.edits} /> : null}
                {c.paperIds.length > 0 && c.kind !== "create_note" && <PaperList ids={c.paperIds} papers={papers} />}
                {c.error && <p className="mt-1 text-[12.5px] text-danger">{c.error}</p>}
                {c.result?.failedPaperIds?.length ? (
                  <p className="mt-1 text-[12.5px] text-warning">
                    {c.result.failedPaperIds.length} PDF(s) could not be downloaded.
                  </p>
                ) : null}
              </div>
              {link && (
                <Link href={link.href} className="shrink-0 self-start text-[12.5px] text-accent-text hover:underline">
                  {link.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {!running && (proposed || set.status === "applied") && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2.5">
          {proposed ? (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={!count}
                loading={update.isPending && update.variables?.action === "apply"}
                onClick={() =>
                  update.mutate({
                    action: "apply",
                    itemIds: set.items.filter((c) => isSelected(c.id)).map((c) => c.id),
                    names,
                  })
                }
              >
                <Check />
                Apply {count === set.items.length ? (count === 1 ? "change" : `all ${count}`) : `${count} selected`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={update.isPending && update.variables?.action === "dismiss"}
                onClick={() => update.mutate({ action: "dismiss" })}
              >
                Dismiss
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={update.isPending}
              onClick={() => {
                if (confirm("Undo these changes? Collections, concepts and notes created here are deleted.")) {
                  update.mutate({ action: "undo" });
                }
              }}
            >
              <Undo2 />
              Undo
            </Button>
          )}
        </footer>
      )}
    </section>
  );
}
