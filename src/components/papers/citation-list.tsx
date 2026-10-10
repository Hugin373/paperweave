"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, Quote, Sparkles, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { AiOutput } from "@/components/ai/ai";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api, errorMessage, qs, streamText } from "@/lib/api";
import { useAiEnabled } from "@/lib/hooks";
import type { CitationListItem, CitationListResponse } from "@/lib/types";
import { PaperCard } from "./paper-card";
import { SaveControl } from "./save-control";

type Sort = "source" | "citations" | "newest" | "oldest";

function ContextQuotes({ contexts }: { contexts: string[] }) {
  const [open, setOpen] = useState(false);
  if (!contexts.length) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-text"
        aria-expanded={open}
      >
        <Quote className="size-3.5" aria-hidden />
        {contexts.length} citation context{contexts.length > 1 ? "s" : ""}
        <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1.5">
          {contexts.map((c, i) => (
            <li key={i} className="border-l-2 border-border-strong pl-2.5 text-[13px] text-text/80 italic">
              “{c}”
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExplainRelation({ citingId, citedId }: { citingId: string; citedId: string }) {
  const [state, setState] = useState({ text: "", loading: false, error: null as string | null, open: false });
  const run = async () => {
    setState({ text: "", loading: true, error: null, open: true });
    try {
      await streamText("/api/ai/citation", { citingId, citedId }, (text) => setState((s) => ({ ...s, text })));
      setState((s) => ({ ...s, loading: false }));
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(err) }));
    }
  };
  return (
    <div className="mt-2">
      {!state.open && (
        <Button size="sm" variant="ai" onClick={run}>
          <Sparkles />
          Explain this relationship
        </Button>
      )}
      <AiOutput text={state.text} loading={state.loading} error={state.error} />
    </div>
  );
}

/** References (papers this paper cites) or citations (papers citing it), from scholarly data. */
export function CitationList({ paperId, direction }: { paperId: string; direction: "references" | "citations" }) {
  const aiEnabled = useAiEnabled();
  const [sort, setSort] = useState<Sort>(direction === "citations" ? "citations" : "source");
  const [filter, setFilter] = useState("");

  const query = useInfiniteQuery({
    queryKey: ["citations", paperId, direction],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api<CitationListResponse>(`/api/papers/${paperId}/${direction}${qs({ offset: pageParam })}`, { signal }),
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
    staleTime: 10 * 60_000,
  });

  const pages = useMemo(() => query.data?.pages ?? [], [query.data]);
  const total = pages[0]?.total ?? null;
  const items = useMemo(() => {
    const all = pages.flatMap((p) => p.items);
    const term = filter.trim().toLowerCase();
    const filtered = term
      ? all.filter((i) =>
          `${i.paper?.title ?? i.rawTitle ?? ""} ${(i.paper?.authors ?? []).join(" ")} ${i.paper?.venue ?? ""}`
            .toLowerCase()
            .includes(term),
        )
      : all;
    const year = (i: CitationListItem) => i.paper?.year ?? (sort === "newest" ? -Infinity : Infinity);
    const sorted = [...filtered];
    if (sort === "citations") sorted.sort((a, b) => (b.paper?.citationCount ?? -1) - (a.paper?.citationCount ?? -1));
    if (sort === "newest") sorted.sort((a, b) => year(b) - year(a));
    if (sort === "oldest") sorted.sort((a, b) => year(a) - year(b));
    return sorted;
  }, [pages, filter, sort]);

  if (query.isLoading) {
    return (
      <div className="space-y-2" aria-busy>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (query.isError)
    return <ErrorState title={`Could not load ${direction}`} error={query.error} onRetry={() => query.refetch()} />;
  if (!items.length && !filter) {
    return (
      <EmptyState
        icon={Quote}
        title={direction === "references" ? "No references available" : "No citations found yet"}
        description={
          direction === "references"
            ? "The scholarly sources don't list references for this paper."
            : "No indexed papers cite this paper yet, or the sources don't have citation data for it."
        }
      />
    );
  }

  const label = direction === "references" ? "references" : "citing papers";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-muted">
          {total !== null ? `${total.toLocaleString()} ${label}` : `${items.length} ${label}`}
          {pages[0]?.provider && (
            <span className="text-subtle">
              {" "}
              · from {pages[0].provider === "semantic_scholar" ? "Semantic Scholar" : "OpenAlex"}
            </span>
          )}
        </p>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter loaded…"
          aria-label={`Filter ${label}`}
          className="h-8 w-44"
        />
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort" className="h-8 w-40">
          <option value="source">Source order</option>
          <option value="citations">Most cited</option>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </Select>
      </div>
      <ul className="space-y-2">
        {items.map((item, i) =>
          item.paper ? (
            <li key={item.paper.id}>
              <PaperCard
                paper={item.paper}
                dense
                actions={<SaveControl paperId={item.paper.id} library={item.paper.library} />}
                highlight={
                  (item.isInfluential || item.intents.length > 0) && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {item.isInfluential && (
                        <Badge tone="warning" title="Marked as an influential citation by Semantic Scholar">
                          <Star aria-hidden />
                          Influential
                        </Badge>
                      )}
                      {item.intents.map((intent) => (
                        <Badge key={intent} tone="outline">
                          {intent === "methodology"
                            ? "Uses method"
                            : intent === "background"
                              ? "Background"
                              : intent === "result"
                                ? "Compares results"
                                : intent}
                        </Badge>
                      ))}
                    </div>
                  )
                }
                footer={
                  <>
                    <ContextQuotes contexts={item.contexts} />
                    {aiEnabled && (
                      <ExplainRelation
                        citingId={direction === "references" ? paperId : item.paper.id}
                        citedId={direction === "references" ? item.paper.id : paperId}
                      />
                    )}
                  </>
                }
              />
            </li>
          ) : (
            <li key={`raw-${i}`} className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted">
              {item.rawTitle}
              <span className="ml-2 text-xs text-subtle">(not resolved in scholarly sources)</span>
            </li>
          ),
        )}
      </ul>
      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
