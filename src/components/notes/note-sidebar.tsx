"use client";

import { Clock, FileText, Link2, Link2Off, Plus, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { relativeTime } from "@/lib/format";
import type { NoteDetail } from "@/lib/types";
import { TargetPicker } from "./target-picker";
import { TypeIcon } from "./type-icon";

export function SidePanel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-3.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-subtle uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Property({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-start gap-2 py-1 text-sm">
      <span className="flex w-28 shrink-0 items-center gap-1.5 pt-1 text-muted">
        <Icon className="size-4" aria-hidden />
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 pt-0.5">{children}</div>
    </div>
  );
}

function Chip({ type, href, label }: { type: "paper" | "concept" | "note"; href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[13px] hover:bg-surface-3"
    >
      <TypeIcon type={type} />
      <span className="truncate">{label}</span>
    </Link>
  );
}

/**
 * Notion-style properties under the title: the paper this note belongs to, what it links to,
 * and when it was last edited.
 */
export function NoteProperties({
  note,
  canChange,
  onChangePaper,
}: {
  note: NoteDetail;
  canChange: boolean;
  onChangePaper: (paperId: string | null) => void;
}) {
  const { papers, concepts, notes } = note.links;
  const linked = concepts.length + papers.length + notes.length;
  return (
    <section aria-label="Note properties" className="mb-2 border-b border-border pb-3">
      <Property icon={FileText} label="Paper">
        {note.paper ? (
          <>
            <Chip type="paper" href={`/papers/${note.paper.id}`} label={note.paper.title} />
            {canChange && (
              <button
                type="button"
                onClick={() => onChangePaper(null)}
                className="inline-flex items-center gap-1 rounded px-1 text-[12.5px] text-subtle hover:bg-surface-2 hover:text-text"
                aria-label="Detach from paper (make standalone)"
                title="Make standalone"
              >
                <Link2Off className="size-3.5" aria-hidden />
              </button>
            )}
          </>
        ) : canChange ? (
          <TargetPicker
            types={["paper"]}
            placeholder="Search your library…"
            emptyHint="No matching papers in your library."
            onSelect={(t) => onChangePaper(t.id)}
            trigger={
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] text-subtle hover:bg-surface-2 hover:text-text"
              >
                <Plus className="size-3.5" aria-hidden />
                Attach to a paper
              </button>
            }
          />
        ) : (
          <span className="text-[13px] text-subtle">Standalone note</span>
        )}
      </Property>
      <Property icon={Link2} label="Links">
        {linked ? (
          <>
            {concepts.map((c) => (
              <Chip key={c.id} type="concept" href={`/concepts/${c.id}`} label={c.name} />
            ))}
            {papers.map((p) => (
              <Chip key={p.id} type="paper" href={`/papers/${p.id}`} label={p.title} />
            ))}
            {notes.map((n) => (
              <Chip key={n.id} type="note" href={`/notes/${n.id}`} label={n.title} />
            ))}
          </>
        ) : (
          <span className="text-[13px] text-subtle">
            Type <kbd className="rounded border border-border bg-surface-2 px-1 text-[12px]">[[</kbd> in the note to
            link papers, concepts and notes
          </span>
        )}
      </Property>
      <Property icon={Clock} label="Edited">
        <span className="text-[13px] text-muted">{relativeTime(note.updatedAt)}</span>
      </Property>
    </section>
  );
}

/** Notes that link to this one, shown at the bottom of the page. */
export function Backlinks({ note }: { note: NoteDetail }) {
  return (
    <section aria-label="Backlinks" className="mt-10 border-t border-border pt-4">
      <h2 className="mb-2 text-[13px] font-medium text-muted">
        {note.backlinks.length
          ? `${note.backlinks.length} backlink${note.backlinks.length > 1 ? "s" : ""}`
          : "No backlinks yet"}
      </h2>
      {note.backlinks.length ? (
        <ul className="space-y-0.5">
          {note.backlinks.map((b) => (
            <li key={b.id}>
              <Link
                href={`/notes/${b.id}`}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-surface-2"
              >
                <TypeIcon type="note" />
                <span className="min-w-0 flex-1 truncate">{b.title}</span>
                <span className="text-[12px] text-subtle">{relativeTime(b.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-subtle">When other notes link to this one with [[…]], they appear here.</p>
      )}
    </section>
  );
}
