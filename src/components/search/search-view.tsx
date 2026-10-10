"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  BellRing,
  ArrowRight,
  Clock,
  Fingerprint,
  Library,
  Search,
  SlidersHorizontal,
  Sparkles,
  Telescope,
  Wand2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AiOutput } from "@/components/ai/ai";
import { useSaveSearch } from "@/components/alerts/alerts-view";
import { PaperCard } from "@/components/papers/paper-card";
import { ReadAction } from "@/components/papers/read-action";
import { SaveControl } from "@/components/papers/save-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api, errorMessage, qs, streamText } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatAuthors } from "@/lib/format";
import { useAiConfig, useAiEnabled } from "@/lib/hooks";
import { detectIdentifier, identifierLabel } from "@/lib/identifiers";
import { looksLikeQuestion } from "@/lib/query";
import type { LibraryResponse, PaperSummary, SearchResponse } from "@/lib/types";
import { countFilters, EMPTY_FILTERS, SearchFilters, type SearchFilterValues } from "./filters";
import { Onboarding } from "./onboarding";
import { useStartResearch } from "@/components/research/use-research";
import { ModelPicker } from "@/components/ai/model-picker";

const PAGE = 20;
const SOURCES = [
  { id: "general", label: "All fields", hint: "Semantic Scholar and OpenAlex" },
  { id: "biomedical", label: "Biomedical", hint: "Europe PMC: PubMed, PubMed Central, medRxiv and bioRxiv" },
  { id: "openreview", label: "ML venues", hint: "OpenReview: ICLR, NeurIPS, ICML, TMLR and workshops" },
] as const;
type Source = (typeof SOURCES)[number]["id"];

const PROVIDER_NAME: Record<string, string> = {
  semantic_scholar: "Semantic Scholar",
  openalex: "OpenAlex",
  europepmc: "Europe PMC",
  openreview: "OpenReview",
};

const MODES = [
  { id: "all", label: "Everything" },
  { id: "title", label: "Title" },
  { id: "author", label: "Author" },
] as const;

const EXAMPLES = [
  "How well do current vision-language models understand 3D spatial relationships?",
  "monocular metric depth estimation",
  "arXiv:1706.03762",
  "10.1038/nature14539",
  "amyloid PET Centiloid",
];

function filtersFromParams(p: URLSearchParams): SearchFilterValues {
  return {
    yearFrom: p.get("yearFrom") ?? "",
    yearTo: p.get("yearTo") ?? "",
    oa: p.get("oa") === "true",
    minCitations: p.get("minCitations") ?? "",
    venue: p.get("venue") ?? "",
    type: p.get("type") ?? "",
  };
}

function RecentPapers() {
  const { data } = useQuery({
    queryKey: ["library", "recent"],
    queryFn: () => api<LibraryResponse>(`/api/library${qs({ sort: "updated_desc", limit: 5 })}`),
  });
  if (!data?.items.length) return null;
  return (
    <section aria-labelledby="recent-title">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="recent-title" className="text-sm font-semibold text-muted">
          Recently active in your library
        </h2>
        <Link href="/library" className="text-sm text-accent-text hover:underline">
          Open library
        </Link>
      </div>
      <div className="space-y-2">
        {data.items.map((p) => (
          <PaperCard key={p.id} paper={p} dense actions={<SaveControl paperId={p.id} library={p.library} />} />
        ))}
      </div>
    </section>
  );
}

const SORTS = [
  { id: "relevance", label: "Relevance" },
  { id: "newest", label: "Newest first" },
  { id: "citations", label: "Most cited" },
] as const;
type Sort = (typeof SORTS)[number]["id"];

function resultActions(paper: PaperSummary) {
  return (
    <>
      <SaveControl paperId={paper.id} library={paper.library} />
      <ReadAction
        paperId={paper.id}
        hasFile={false}
        pdfAvailable={paper.pdfAvailable}
        freeReadUrl={paper.freeReadUrl}
        pdfUrl={paper.openAccessPdfUrl}
      />
      <Button size="sm" variant="ghost" asChild>
        <Link href={`/papers/${paper.id}`}>
          Open
          <ArrowRight />
        </Link>
      </Button>
    </>
  );
}

export function SearchView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const aiEnabled = useAiEnabled();
  // Until the AI settings are known, the AI actions are not shown (a click could pick the wrong path).
  const aiKnown = useAiConfig().isSuccess;
  const startResearch = useStartResearch();

  const q = params.get("q") ?? "";
  const saveSearch = useSaveSearch();
  const underReview = params.get("review") === "1";
  const mode = (params.get("mode") ?? "all") as (typeof MODES)[number]["id"];
  const exact = params.get("exact") === "true";
  const sortParam = params.get("sort");
  const sortParam2: Sort = SORTS.some((x) => x.id === sortParam) ? (sortParam as Sort) : "relevance";
  const sourceParam = params.get("source");
  const source: Source = SOURCES.some((x) => x.id === sourceParam) ? (sourceParam as Source) : "general";
  // OpenReview has no citation counts.
  const sort: Sort = source === "openreview" && sortParam2 === "citations" ? "relevance" : sortParam2;
  const aiRewrite = params.get("ai") ? { original: params.get("ai")!, explanation: params.get("aiNote") ?? "" } : null;
  const filters = useMemo(() => filtersFromParams(params), [params]);

  const [input, setInput] = useState(q);
  const [showFilters, setShowFilters] = useState(countFilters(filters) > 0);
  const [draftFilters, setDraftFilters] = useState(filters);
  const [rewriting, setRewriting] = useState(false);
  const [summary, setSummary] = useState({ text: "", loading: false, error: null as string | null });

  useEffect(() => setInput(q), [q]);
  useEffect(() => setDraftFilters(filters), [filters]);

  const navigate = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    router.push(`${pathname}?${next.toString()}`);
  };

  const submit = (value = input, extra: Record<string, string | null> = {}) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSummary({ text: "", loading: false, error: null });
    navigate({ q: trimmed, exact: null, ai: null, aiNote: null, ...extra });
  };

  const applyFilters = () => {
    navigate({
      yearFrom: draftFilters.yearFrom || null,
      yearTo: draftFilters.yearTo || null,
      oa: draftFilters.oa ? "true" : null,
      minCitations: draftFilters.minCitations || null,
      venue: draftFilters.venue || null,
      type: draftFilters.type || null,
    });
  };

  const results = useInfiniteQuery({
    queryKey: ["search", q, mode, exact, filters, sort, source, source === "openreview" && underReview],
    enabled: !!q,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api<SearchResponse>(
        `/api/search/papers${qs({
          q,
          mode,
          exact: exact || undefined,
          offset: pageParam,
          limit: PAGE,
          yearFrom: filters.yearFrom,
          yearTo: filters.yearTo,
          oa: filters.oa || undefined,
          minCitations: filters.minCitations,
          venue: filters.venue,
          type: filters.type,
          sort: sort === "relevance" ? undefined : sort,
          source: source === "general" ? undefined : source,
          underReview: source === "openreview" && underReview ? "true" : undefined,
        })}`,
        { signal },
      ),
    getNextPageParam: (last) => {
      if (last.provider === "identifier") return undefined;
      const next = last.offset + last.limit;
      const hasMore = last.items.length >= Math.min(last.limit, 10) && (last.total === null || next < last.total);
      return hasMore && next < 1000 ? next : undefined;
    },
    staleTime: 5 * 60_000,
  });

  const first = results.data?.pages[0];
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (results.data?.pages ?? [])
      .flatMap((p) => p.items)
      .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  }, [results.data]);

  // An identifier that resolves to exactly one paper opens it directly.
  useEffect(() => {
    if (first?.provider === "identifier" && first.items.length === 1 && params.get("stay") !== "1") {
      router.replace(`/papers/${first.items[0].id}`);
    }
  }, [first, params, router]);

  const identifier = detectIdentifier(input);
  const isQuestion = !identifier && looksLikeQuestion(input);

  const rewriteWithAi = async () => {
    setRewriting(true);
    try {
      const out = await api<{ query: string; explanation: string }>("/api/ai/search/rewrite", {
        body: { question: input.trim() },
      });
      submit(out.query, { ai: input.trim(), aiNote: out.explanation, exact: "true" });
    } catch (err) {
      toast.error(errorMessage(err, "The AI provider could not rewrite the query."));
    } finally {
      setRewriting(false);
    }
  };

  const summarize = async () => {
    setSummary({ text: "", loading: true, error: null });
    try {
      await streamText(
        "/api/ai/search/summary",
        { question: aiRewrite?.original ?? q, paperIds: items.slice(0, 10).map((p) => p.id) },
        (text) => setSummary((s) => ({ ...s, text })),
      );
      setSummary((s) => ({ ...s, loading: false }));
    } catch (err) {
      setSummary((s) => ({ ...s, loading: false, error: errorMessage(err) }));
    }
  };

  const activeFilters = countFilters(filters);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="sr-only">Search scholarly literature</h1>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-subtle"
              aria-hidden
            />
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search papers by topic, question, title, author, DOI or arXiv link…"
              aria-label="Search scholarly literature"
              className="h-13 rounded-xl pr-28 pl-12 text-base shadow-sm"
              autoFocus={!q}
            />
            <Button
              type="submit"
              variant="primary"
              className="absolute top-1/2 right-2 -translate-y-1/2"
              disabled={!input.trim()}
            >
              Search
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Source"
              title={SOURCES.find((x) => x.id === source)?.hint}
              value={source}
              onChange={(e) => {
                const next = e.target.value === "general" ? null : e.target.value;
                if (q) navigate({ source: next });
                else router.push(`${pathname}${qs({ source: next ?? undefined })}`);
              }}
              className="h-8 w-auto py-0 text-[13px] font-medium"
            >
              {SOURCES.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </Select>
            {source === "openreview" && (
              <label
                className="flex items-center gap-1.5 text-[13px] text-muted"
                title="Papers still under double-blind review are anonymous, and their PDFs need an OpenReview login. Paperweave links the arXiv version when one exists."
              >
                <input
                  type="checkbox"
                  checked={underReview}
                  onChange={(e) => navigate({ review: e.target.checked ? "1" : null })}
                  className="accent-[var(--accent)]"
                />
                Include papers under review
              </label>
            )}
            <div
              className="inline-flex rounded-lg border border-border bg-surface p-0.5"
              role="radiogroup"
              aria-label="Search in"
            >
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  onClick={() =>
                    q
                      ? navigate({ mode: m.id === "all" ? null : m.id })
                      : router.push(`${pathname}${qs({ mode: m.id === "all" ? undefined : m.id })}`)
                  }
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[13px] font-medium",
                    mode === m.id ? "bg-surface-3 text-text" : "text-muted hover:text-text",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <Button size="sm" variant="ghost" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
              <SlidersHorizontal />
              Filters
              {activeFilters > 0 && <Badge tone="accent">{activeFilters}</Badge>}
            </Button>
            {identifier && (
              <Badge tone="accent">
                <Fingerprint aria-hidden />
                {identifierLabel(identifier.kind)} recognized — opens the paper directly
              </Badge>
            )}
            {isQuestion && aiEnabled && (
              <Button size="sm" variant="ai" onClick={rewriteWithAi} loading={rewriting}>
                <Wand2 />
                Turn question into a search with AI
              </Button>
            )}
            {aiKnown && !identifier && input.trim().length >= 3 && (
              <Button
                size="sm"
                variant="ai"
                loading={startResearch.isPending}
                onClick={() =>
                  aiEnabled
                    ? startResearch.mutate({ question: input.trim(), mode: "deep" })
                    : router.push(`/research${qs({ q: input.trim() })}`)
                }
              >
                <Telescope />
                Deep research with AI
              </Button>
            )}
            {aiEnabled && input.trim().length >= 3 && !identifier && <ModelPicker />}
          </div>
        </form>
        {showFilters && (
          <div className="mt-3 space-y-2">
            <SearchFilters value={draftFilters} onChange={setDraftFilters} />
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraftFilters(EMPTY_FILTERS);
                  navigate({ yearFrom: null, yearTo: null, oa: null, minCitations: null, venue: null, type: null });
                }}
              >
                Clear
              </Button>
              <Button size="sm" variant="primary" onClick={applyFilters}>
                Apply filters
              </Button>
            </div>
          </div>
        )}
      </div>

      {!q && (
        <>
          <Onboarding />
          <section aria-labelledby="examples-title" className="rounded-xl border border-border bg-surface p-5">
            <h2 id="examples-title" className="text-sm font-semibold">
              Start with a topic, a question, or a paper you know
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => {
                    setInput(ex);
                    submit(ex);
                  }}
                  className="rounded-full border border-border bg-surface-2/60 px-3 py-1.5 text-left text-[13px] text-muted hover:border-border-strong hover:text-text"
                >
                  {ex}
                </button>
              ))}
            </div>
          </section>
          <RecentPapers />
        </>
      )}

      {q && (
        <section aria-live="polite" aria-busy={results.isLoading} className="space-y-4">
          {aiRewrite && (
            <div className="flex flex-wrap items-start gap-2 rounded-lg border border-ai/20 bg-ai-soft/40 px-3 py-2 text-sm">
              <Sparkles className="mt-0.5 size-4 text-ai" aria-hidden />
              <p className="flex-1">
                <span className="font-medium text-ai">AI rewrote your question</span> as “{q}”.{" "}
                {aiRewrite.explanation && <span className="text-muted">{aiRewrite.explanation} </span>}
                <button
                  type="button"
                  className="text-accent-text hover:underline"
                  onClick={() => submit(aiRewrite.original)}
                >
                  Search the original instead
                </button>
              </p>
            </div>
          )}
          {first?.interpretedQuery && !aiRewrite && (
            <p className="text-sm text-muted">
              Searching for <span className="font-medium text-text">“{first.interpretedQuery}”</span> (key terms from
              your question).{" "}
              <button
                type="button"
                className="text-accent-text hover:underline"
                onClick={() => navigate({ exact: "true" })}
              >
                Search your exact wording instead
              </button>
            </p>
          )}

          {results.isLoading && (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-2 rounded-xl border border-border bg-surface p-4">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ))}
            </div>
          )}

          {results.isError && (
            <ErrorState title="Search failed" error={results.error} onRetry={() => results.refetch()} />
          )}

          {first && !results.isLoading && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted">
                {first.provider === "identifier"
                  ? items.length
                    ? "Paper found by identifier"
                    : "No paper found for that identifier"
                  : first.total !== null
                    ? `${first.total.toLocaleString()} results`
                    : `${items.length} results`}
                {first.provider !== "identifier" && (
                  <span className="text-subtle"> · via {PROVIDER_NAME[first.provider] ?? first.provider}</span>
                )}
                {sort === "newest" && source === "general" && first.provider !== "identifier" && (
                  <span className="block text-[12.5px] text-subtle">
                    The most relevant papers{" "}
                    {filters.yearFrom || filters.yearTo
                      ? "in the selected years"
                      : `since ${new Date().getFullYear() - 1}`}
                    , newest first. Set a year filter to look further back.
                  </span>
                )}
              </p>
              {first.provider !== "identifier" && mode !== "author" && (
                <label className="flex items-center gap-1.5 text-[13px] text-muted">
                  Sort
                  <Select
                    aria-label="Sort results"
                    value={sort}
                    onChange={(e) => navigate({ sort: e.target.value === "relevance" ? null : e.target.value })}
                    className="h-8 w-auto py-0 text-[13px]"
                  >
                    {SORTS.filter((o) => source !== "openreview" || o.id !== "citations").map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {first.provider !== "identifier" && mode !== "author" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => saveSearch.mutate({ query: q, source })}
                  loading={saveSearch.isPending}
                  title="Run this search every day and show papers it finds later under New papers"
                >
                  <BellRing />
                  Save search
                </Button>
              )}
              {aiEnabled && items.length > 1 && (
                <Button size="sm" variant="ai" onClick={summarize} loading={summary.loading}>
                  <Sparkles />
                  Summarize these results
                </Button>
              )}
            </div>
          )}

          <AiOutput text={summary.text} loading={summary.loading} error={summary.error} />

          {first && !items.length && !results.isLoading && (
            <EmptyState
              icon={Search}
              title="No papers found"
              description={
                first.provider === "identifier"
                  ? "None of our scholarly sources know this identifier. Check it for typos, or add the paper manually by importing a BibTeX entry in Settings → Import."
                  : "Try fewer or more general terms, a different search mode, or remove filters."
              }
            />
          )}

          {!!first?.latestPreprints?.length && (
            <section
              aria-labelledby="latest-preprints"
              className="space-y-2 rounded-xl border border-accent/25 bg-accent-soft/30 p-3"
            >
              <div>
                <h2 id="latest-preprints" className="flex items-center gap-1.5 text-sm font-semibold">
                  <Clock className="size-4 text-accent" aria-hidden />
                  Just posted on arXiv
                </h2>
                <p className="text-[12.5px] text-muted">
                  The newest matching preprints. Recent ones may not be in the scholarly databases yet.
                </p>
              </div>
              <ul className="stagger divide-y divide-border rounded-lg border border-border bg-surface">
                {first.latestPreprints.map((paper) => (
                  <li key={paper.id} className="flex items-start gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <Link href={`/papers/${paper.id}`} className="text-[13.5px] font-medium hover:underline">
                        {paper.title}
                      </Link>
                      <p className="truncate text-[12px] text-muted">
                        {[formatAuthors(paper.authors), paper.year].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <SaveControl paperId={paper.id} library={paper.library} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="space-y-3">
            {items.map((paper) => (
              <PaperCard key={paper.id} paper={paper} actions={resultActions(paper)} />
            ))}
          </div>

          {results.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => results.fetchNextPage()} loading={results.isFetchingNextPage}>
                Load more results
              </Button>
            </div>
          )}
          {items.length > 0 && (
            <p className="flex items-center justify-center gap-1.5 pt-2 text-xs text-subtle">
              <Library className="size-3.5" aria-hidden />
              Saved papers appear in your library with references, citations, notes and PDFs.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
