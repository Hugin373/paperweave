"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, Lightbulb, NotebookPen, Plus, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { KnowledgeTabs } from "@/components/notes/knowledge-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api, qs } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import type { ConceptSummary } from "@/lib/types";
import { NewConceptDialog } from "./new-concept-dialog";

export function ConceptsList({ openNew }: { openNew?: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState(!!openNew);
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 250);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["concepts", "list", debounced],
    queryFn: () => api<ConceptSummary[]>(`/api/concepts${qs({ q: debounced })}`),
    placeholderData: (prev) => prev,
  });

  const setDialog = (o: boolean) => {
    setCreating(o);
    if (!o && openNew) router.replace("/concepts");
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Concepts</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus />
          New concept
        </Button>
      </div>
      <KnowledgeTabs active="concepts" />
      <div className="relative mt-4">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
          aria-hidden
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter concepts…"
          aria-label="Filter concepts"
          className="pl-9"
        />
      </div>

      <div className="mt-4">
        {error && <ErrorState error={error} onRetry={() => refetch()} />}
        {isLoading && (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        )}
        {data &&
          !data.length &&
          (debounced ? (
            <EmptyState icon={Search} title="No matching concepts" description="Try another search, or create it." />
          ) : (
            <EmptyState
              icon={Lightbulb}
              title="No concepts yet"
              description="Concepts are lightweight knowledge nodes like ‘metric depth’, ‘epipolar geometry’ or ‘Centiloid’. Link them to papers and mention them in notes to see how ideas connect."
              action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus />
                  Create a concept
                </Button>
              }
            />
          ))}
        {data && data.length > 0 && (
          <ul className="stagger grid gap-3 sm:grid-cols-2">
            {data.map((c) => (
              <li
                key={c.id}
                className="relative rounded-xl border border-border bg-surface p-4 shadow-xs transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md"
              >
                <div className="flex items-start gap-2">
                  <Lightbulb className="mt-0.5 size-4 shrink-0 text-[var(--node-concept)]" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/concepts/${c.id}`}
                      className="font-medium after:absolute after:inset-0 hover:text-accent-text"
                    >
                      {c.name}
                    </Link>
                    {c.aliases.length > 0 && (
                      <p className="truncate text-[12px] text-subtle">also: {c.aliases.join(", ")}</p>
                    )}
                    {c.description && <p className="mt-1 line-clamp-2 text-[13px] text-muted">{c.description}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-muted">
                      <span className="inline-flex items-center gap-1">
                        <FileText className="size-3.5" aria-hidden />
                        {c.paperCount} {c.paperCount === 1 ? "paper" : "papers"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <NotebookPen className="size-3.5" aria-hidden />
                        {c.noteCount} {c.noteCount === 1 ? "note" : "notes"}
                      </span>
                      {c.origin === "ai_suggestion" && (
                        <Badge tone="ai">
                          <Sparkles aria-hidden />
                          AI-suggested
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <NewConceptDialog open={creating} onOpenChange={setDialog} />
    </div>
  );
}
