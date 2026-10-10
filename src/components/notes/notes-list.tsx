"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, NotebookPen, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api, qs } from "@/lib/api";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import type { NoteSummary } from "@/lib/types";
import { KnowledgeTabs } from "./knowledge-tabs";

const KINDS = [
  { key: "all", label: "All" },
  { key: "standalone", label: "Standalone" },
  { key: "paper", label: "Paper notes" },
] as const;

export function NotesList() {
  const [kind, setKind] = useState<(typeof KINDS)[number]["key"]>("all");
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 250);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["notes", kind, debounced],
    queryFn: () => api<NoteSummary[]>(`/api/notes${qs({ kind, q: debounced })}`),
    placeholderData: (prev) => prev,
  });

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Notes</h1>
        <Button variant="primary" asChild>
          <Link href="/notes/new">
            <Plus />
            New note
          </Link>
        </Button>
      </div>
      <KnowledgeTabs active="notes" />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div role="group" aria-label="Filter notes" className="flex rounded-lg border border-border bg-surface p-0.5">
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={kind === k.key}
              onClick={() => setKind(k.key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-[13px] font-medium",
                kind === k.key ? "bg-surface-3/70 text-text" : "text-muted hover:text-text",
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter notes…"
            aria-label="Filter notes"
            className="pl-9"
          />
        </div>
      </div>

      <div className="mt-4">
        {error && <ErrorState error={error} onRetry={() => refetch()} />}
        {isLoading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}
        {data &&
          !data.length &&
          (debounced || kind !== "all" ? (
            <EmptyState icon={Search} title="No matching notes" description="Try a different filter or search term." />
          ) : (
            <EmptyState
              icon={NotebookPen}
              title="Write your first note"
              description={
                <>
                  Notes can stand alone or belong to a paper. Type{" "}
                  <kbd className="rounded border border-border bg-surface-2 px-1">[[</kbd> while writing to link papers,
                  concepts and other notes — links show up as backlinks and in your graph.
                </>
              }
              action={
                <Button variant="primary" asChild>
                  <Link href="/notes/new">
                    <Plus />
                    New note
                  </Link>
                </Button>
              }
            />
          ))}
        {data && data.length > 0 && (
          <ul className="stagger divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
            {data.map((n) => (
              <li key={n.id} className="relative px-4 py-3 hover:bg-surface-2/60">
                <div className="flex items-start gap-3">
                  <NotebookPen className="mt-0.5 size-4 shrink-0 text-[var(--node-note)]" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/notes/${n.id}`}
                      className="font-medium after:absolute after:inset-0 hover:text-accent-text"
                    >
                      {n.title}
                    </Link>
                    {n.excerpt && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{n.excerpt}</p>}
                    {n.paperId && n.paperTitle && (
                      <Link
                        href={`/papers/${n.paperId}`}
                        className="relative z-10 mt-1 inline-flex max-w-full items-center gap-1 text-[12.5px] text-muted hover:text-accent-text"
                      >
                        <FileText className="size-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{n.paperTitle}</span>
                      </Link>
                    )}
                  </div>
                  <span className="shrink-0 text-[12px] text-subtle">{relativeTime(n.updatedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
