"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, ChevronDown, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PaperCard } from "@/components/papers/paper-card";
import { ReadAction } from "@/components/papers/read-action";
import { SaveControl } from "@/components/papers/save-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { AlertSource, SavedSearchDto, SavedSearchResults } from "@/lib/types";

export const ALERT_SOURCE_LABEL: Record<AlertSource, string> = {
  general: "All fields",
  biomedical: "Biomedical (PubMed)",
  openreview: "ML venues (OpenReview)",
  arxiv: "arXiv, newest preprints",
};

/** The saved searches and the new-paper count shown in the navigation. */
export function useAlerts() {
  return useQuery({
    queryKey: ["alerts"],
    queryFn: () => api<{ searches: SavedSearchDto[]; unseen: number }>("/api/alerts"),
    refetchInterval: 15 * 60_000,
  });
}

/** Saves a search so it runs every day (from the search page or this page). */
export function useSaveSearch() {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (body: { query: string; source: AlertSource }) =>
      api<{ id: string; created: boolean }>("/api/alerts", { body }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["alerts"] });
      toast.success(
        r.created
          ? "Search saved. It runs every day; new papers appear under New papers."
          : "This search is already saved.",
        { action: { label: "Open", onClick: () => router.push("/alerts") } },
      );
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

function Results({ search }: { search: SavedSearchDto }) {
  const qc = useQueryClient();
  const results = useQuery({
    queryKey: ["alerts", search.id],
    queryFn: () => api<SavedSearchResults>(`/api/alerts/${search.id}`),
  });
  // Opening the list counts as having seen its new papers (they stay marked until the next visit).
  const marked = useRef(false);
  useEffect(() => {
    if (!results.data || marked.current || !search.newCount) return;
    marked.current = true;
    void api(`/api/alerts/${search.id}/seen`, { method: "POST" }).then(() =>
      qc.invalidateQueries({ queryKey: ["alerts"], exact: true }),
    );
  }, [results.data, search.id, search.newCount, qc]);

  if (results.isPending) return <Skeleton className="h-24" />;
  if (results.isError) return <ErrorState error={results.error} onRetry={() => results.refetch()} />;
  const papers = results.data.papers;
  if (!papers.length) {
    return (
      <p className="px-1 py-3 text-sm text-muted">
        {search.lastRunAt ? "Nothing found yet." : "The first run is in progress; check back in a moment."}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {papers.map((p) => (
        <PaperCard
          key={p.id}
          paper={p}
          dense
          highlight={p.isNew ? <Badge tone="accent">New · {relativeTime(p.foundAt)}</Badge> : undefined}
          actions={
            <>
              <SaveControl paperId={p.id} library={p.library} />
              <ReadAction
                paperId={p.id}
                hasFile={false}
                pdfAvailable={p.pdfAvailable}
                freeReadUrl={p.freeReadUrl}
                pdfUrl={p.openAccessPdfUrl}
              />
              <Button size="sm" variant="ghost" asChild>
                <Link href={`/papers/${p.id}`}>Open</Link>
              </Button>
            </>
          }
        />
      ))}
    </div>
  );
}

function SearchRow({ search }: { search: SavedSearchDto }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(search.newCount > 0);
  const check = useMutation({
    mutationFn: () => api<{ found: number; new: number }>(`/api/alerts/${search.id}/check`, { method: "POST" }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["alerts"] });
      toast.success(
        r.new ? `${r.new} new paper${r.new === 1 ? "" : "s"} found.` : "No new papers since the last check.",
      );
      setOpen(true);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/alerts/${search.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <li className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-muted" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted" />
          )}
          <span className="min-w-0">
            <span className="block truncate text-[14.5px] font-medium">{search.query}</span>
            <span className="block text-[12px] text-subtle">
              {ALERT_SOURCE_LABEL[search.source]} · {search.total} found ·{" "}
              {search.lastRunAt ? `checked ${relativeTime(search.lastRunAt)}` : "first run pending"}
              {search.lastError ? ` · last check failed: ${search.lastError}` : ""}
            </span>
          </span>
          {search.newCount > 0 && <Badge tone="accent">{search.newCount} new</Badge>}
        </button>
        <Button size="sm" variant="ghost" onClick={() => check.mutate()} loading={check.isPending}>
          <RefreshCw />
          Check now
        </Button>
        <Button
          size="icon-sm"
          variant="danger-ghost"
          aria-label={`Delete saved search “${search.query}”`}
          onClick={() => confirm(`Stop following “${search.query}”?`) && remove.mutate()}
        >
          <Trash2 />
        </Button>
      </div>
      {open && (
        <div className="border-t border-border p-3">
          <Results search={search} />
        </div>
      )}
    </li>
  );
}

/** "New papers": saved searches that run daily, and what they found. */
export function AlertsView() {
  const alerts = useAlerts();
  const save = useSaveSearch();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<AlertSource>("arxiv");

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-1 flex items-center gap-2">
        <BellRing className="size-5 text-accent" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">New papers</h1>
      </div>
      <p className="mb-4 text-sm text-muted">
        Saved searches run every day. Papers they find after you save them show up here as new.
      </p>
      <form
        className="mb-5 flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length < 2) return;
          save.mutate({ query: query.trim(), source }, { onSuccess: () => setQuery("") });
        }}
      >
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Follow a topic, e.g. diffusion models for MRI reconstruction"
          aria-label="Search to follow"
          className="flex-1"
        />
        <Select value={source} onChange={(e) => setSource(e.target.value as AlertSource)} aria-label="Where to search">
          {(Object.keys(ALERT_SOURCE_LABEL) as AlertSource[]).map((s) => (
            <option key={s} value={s}>
              {ALERT_SOURCE_LABEL[s]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={query.trim().length < 2}>
          Follow
        </Button>
      </form>
      {alerts.isPending ? (
        <Skeleton className="h-32" />
      ) : alerts.isError ? (
        <ErrorState error={alerts.error} onRetry={() => alerts.refetch()} />
      ) : !alerts.data.searches.length ? (
        <EmptyState
          icon={BellRing}
          title="No saved searches yet"
          description="Follow a topic above, or use “Save search” on the search page. The assistant can also save searches for you."
        />
      ) : (
        <ul className="space-y-2">
          {alerts.data.searches.map((s) => (
            <SearchRow key={s.id} search={s} />
          ))}
        </ul>
      )}
    </div>
  );
}
