"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookMarked,
  BookmarkPlus,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  CircleSlash,
  FolderTree,
  Copy,
  CornerDownRight,
  CornerUpLeft,
  Lightbulb,
  Library,
  ListOrdered,
  Loader2,
  MoreHorizontal,
  NotebookPen,
  PenLine,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  TrendingUp,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AiLabel } from "@/components/ai/ai";
import { ModelPicker } from "@/components/ai/model-picker";
import { CapabilitiesButton } from "./capabilities";
import { PROVIDER_SHORT } from "@/lib/ai-models";
import { SaveControl } from "@/components/papers/save-control";
import { useBulk } from "@/lib/mutations";
import {
  CITATION_GROUP,
  linkCitations,
  rankSources,
  sortCited,
  type CitedSource,
  type SourceOrder,
} from "@/lib/research-sources";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { PageLoading } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/states";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/format";
import { useAiEnabled } from "@/lib/hooks";
import type {
  PaperSummary,
  ResearchMessageDto,
  ResearchMode,
  ResearchSource,
  ResearchStep,
  ResearchStepKind,
  ResearchThreadDto,
  SourcePriority,
  SourceRanking,
} from "@/lib/types";
import { SOURCE_PRIORITIES } from "@/lib/types";
import { ChangesCard } from "./changes-card";
import { MODE_INFO, ResearchComposer, ScopeChip, useAutoApply } from "./research-composer";
import { useResearchThread } from "./use-research";

const STEP_ICON: Record<ResearchStepKind, LucideIcon> = {
  plan: Lightbulb,
  workspace: FolderTree,
  change: Wand2,
  search: Search,
  references: CornerUpLeft,
  citations: CornerDownRight,
  read: BookOpen,
  library: Library,
  note: NotebookPen,
  write: PenLine,
  rank: ListOrdered,
  playbook: BookMarked,
  trend: TrendingUp,
};

function citedKeys(markdown: string) {
  const out: string[] = [];
  for (const m of markdown.matchAll(CITATION_GROUP)) {
    for (const k of m[1].split(/\s*[,;]\s*/)) if (!out.includes(k)) out.push(k);
  }
  return out;
}

function sourceHref(s: ResearchSource) {
  return s.type === "paper" ? `/papers/${s.id}` : `/notes/${s.id}`;
}

/** "Vaswani 2017" for papers, "Your note" for notes. */
function chipLabel(s: ResearchSource) {
  if (s.type === "note") return "Your note";
  const first = s.authors
    ?.split(",")[0]
    ?.replace(/ et al\.$/, "")
    .trim();
  const surname = first?.split(/\s+/).at(-1);
  return [surname, s.year].filter(Boolean).join(" ") || s.key;
}

function CitationChip({ source }: { source: ResearchSource }) {
  return (
    <Link
      href={sourceHref(source)}
      title={`${source.title}${source.year ? ` (${source.year})` : ""}`}
      className={cn(
        "cite-chip ml-1 inline-flex items-center rounded-md px-1.5 align-baseline text-[11.5px] leading-[1.6] font-medium whitespace-nowrap",
        source.type === "paper" ? "bg-accent-soft hover:bg-accent/20" : "cite-note bg-warning-soft hover:brightness-95",
      )}
    >
      {chipLabel(source)}
    </Link>
  );
}

function elapsed(m: ResearchMessageDto) {
  const s = Math.max(1, Math.round((new Date(m.updatedAt).getTime() - new Date(m.createdAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function StepRow({ step }: { step: ResearchStep }) {
  const Icon = STEP_ICON[step.kind];
  return (
    <li className="flex gap-2.5">
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
          step.status === "error" ? "bg-danger-soft text-danger" : "bg-surface-2 text-muted",
        )}
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="flex flex-wrap items-center gap-x-2 text-[13px]">
          <span className={cn(step.kind === "plan" ? "font-medium" : "text-text")}>{step.label}</span>
          {step.status === "running" && <Loader2 className="size-3.5 animate-spin text-ai" aria-label="In progress" />}
          {step.status === "done" && step.count != null && step.kind !== "plan" && (
            <span className="text-[12px] text-subtle">
              {step.count === 0 ? "nothing found" : `${formatCount(step.count)} found`}
            </span>
          )}
        </p>
        {step.detail && (
          <p className={cn("mt-0.5 text-[12.5px]", step.status === "error" ? "text-danger" : "text-muted")}>
            {step.detail}
          </p>
        )}
      </div>
    </li>
  );
}

/** The live research timeline; collapses into a one-line summary when the research is finished. */
function Activity({ message }: { message: ResearchMessageDto }) {
  const running = message.status === "running";
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? running;
  const actions = message.steps.filter((s) => s.kind !== "plan" && s.kind !== "write" && s.kind !== "rank").length;
  const counts = `${actions} step${actions === 1 ? "" : "s"} · ${message.sources.length} sources`;
  const summary =
    message.status === "running"
      ? `${message.mode === "deep" || message.mode === "field" ? "Researching" : "Working"}… ${counts} so far`
      : message.status === "done"
        ? `${message.mode === "deep" || message.mode === "field" ? "Researched" : "Worked"} for ${elapsed(message)} · ${counts}`
        : `${message.status === "error" ? "Failed" : "Stopped"} after ${elapsed(message)} · ${counts}`;
  if (!message.steps.length) {
    return running ? (
      <p className="flex items-center gap-2 text-[13px] text-muted">
        <Loader2 className="size-4 animate-spin text-ai" aria-hidden />
        Starting…
      </p>
    ) : null;
  }
  return (
    <div className="rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px] font-medium"
      >
        {running ? (
          <Loader2 className="size-4 animate-spin text-ai" aria-hidden />
        ) : message.status === "done" ? (
          <Check className="size-4 text-success" aria-hidden />
        ) : message.status === "error" ? (
          <CircleAlert className="size-4 text-danger" aria-hidden />
        ) : (
          <CircleSlash className="size-4 text-subtle" aria-hidden />
        )}
        <span className="flex-1">{summary}</span>
        <ChevronDown className={cn("size-4 text-subtle transition-transform", expanded && "rotate-180")} aria-hidden />
      </button>
      {expanded && (
        <ol
          className="appear space-y-2.5 border-t border-border px-3.5 py-3"
          aria-label="Research steps"
          aria-live="polite"
        >
          {message.steps.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </ol>
      )}
    </div>
  );
}

function SourceItem({
  source,
  paper,
  rank,
  note,
}: {
  source: ResearchSource;
  paper?: PaperSummary;
  /** Reading-order number for "Start here" papers. */
  rank?: number;
  /** Why it is listed: the report's reason, or how the report uses it. */
  note?: ReactNode;
}) {
  const meta = [source.authors, source.year, source.venue].filter(Boolean).join(" · ");
  return (
    <li className="flex items-start gap-3 py-2.5">
      {rank ? (
        <span
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-text"
          aria-label={`Read ${rank}${rank === 1 ? "st" : rank === 2 ? "nd" : rank === 3 ? "rd" : "th"}`}
        >
          {rank}
        </span>
      ) : (
        <span className="mt-0.5 w-8 shrink-0 text-[12px] font-medium text-subtle">{source.key}</span>
      )}
      <div className="min-w-0 flex-1">
        <Link href={sourceHref(source)} className="text-[13.5px] font-medium hover:underline">
          {source.title}
        </Link>
        <p className="mt-0.5 text-[12px] text-muted">
          {source.type === "note" ? "Your note" : meta}
          {source.citationCount != null && ` · ${formatCount(source.citationCount)} citations`}
        </p>
        {note && <p className="mt-1 text-[12.5px] text-text/80">{note}</p>}
      </div>
      {paper && !paper.isUserPaper && <SaveControl paperId={paper.id} library={paper.library} />}
    </li>
  );
}

/** "cited 4× · in Overview, Adapting SAM to 3D +1" */
function usageNote(c: CitedSource) {
  const shown = c.sections.slice(0, 2).join(", ");
  const more = c.sections.length > 2 ? ` +${c.sections.length - 2}` : "";
  return (
    <span className="text-muted">
      Cited {c.mentions}×{shown && ` · in ${shown}${more}`}
    </span>
  );
}

function SaveAll({ ids, papers }: { ids: string[]; papers: Record<string, PaperSummary> }) {
  const bulk = useBulk();
  const unsaved = ids.filter((id) => papers[id] && !papers[id].library && !papers[id].isUserPaper);
  if (!unsaved.length) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={bulk.isPending}
      onClick={() =>
        bulk.mutate(
          { action: "save", paperIds: unsaved },
          { onSuccess: () => toast.success(`Saved ${unsaved.length} paper${unsaved.length === 1 ? "" : "s"}`) },
        )
      }
    >
      <BookmarkPlus />
      Save {unsaved.length === 1 ? "it" : `all ${unsaved.length}`}
    </Button>
  );
}

/** Cited sources shown before "Show all" (long reports cite dozens). */
const CITED_SHOWN = 8;

const SOURCE_ORDERS: { id: SourceOrder; label: string }[] = [
  { id: "relevance", label: "By priority" },
  { id: "newest", label: "Newest" },
  { id: "citations", label: "Most cited" },
];

const PRIORITY_LABEL: Record<SourcePriority, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

function rankedBy(r: SourceRanking) {
  return [r.provider && PROVIDER_SHORT[r.provider], r.model].filter(Boolean).join(" · ");
}

/** Asks the AI to rank (or re-rank) an answer's sources. */
function useRankSources(threadId: string, messageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(`/api/research/${threadId}/messages/${messageId}/rank`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["research"] }),
    onError: (err) => toast.error(errorMessage(err, "Could not rank the sources.")),
  });
}

function Sources({
  threadId,
  message,
  papers,
}: {
  threadId: string;
  message: ResearchMessageDto;
  papers: Record<string, PaperSummary>;
}) {
  const [showAll, setShowAll] = useState(false);
  const [allCited, setAllCited] = useState(false);
  const [order, setOrder] = useState<SourceOrder>("relevance");
  const rank = useRankSources(threadId, message.id);
  const heuristic = rankSources(message.content, message.sources);
  const byKey = new Map(message.sources.map((s) => [s.key, s]));
  const usage = new Map(heuristic.cited.map((c) => [c.source.key, c]));
  const ranking = message.ranking;
  if (!heuristic.startHere.length && !heuristic.cited.length && !heuristic.others.length) return null;

  const paperOf = (s: ResearchSource) => (s.type === "paper" ? papers[s.id] : undefined);
  const heading = "text-xs font-medium tracking-wide text-subtle uppercase";
  const citedPaperCount = new Set(
    [...heuristic.startHere.map((s) => s.source), ...heuristic.cited.map((c) => c.source)]
      .filter((s) => s.type === "paper")
      .map((s) => s.key),
  ).size;
  // Only research results (replies that searched the literature) are ranked, as on the server.
  const researched = message.steps.some(
    (s) => s.kind === "search" || s.kind === "references" || s.kind === "citations",
  );
  const canRank = message.status === "done" && researched && !message.changes && citedPaperCount >= 3;

  // With the AI's ranking: its reading order, then its priorities; otherwise the citation-count order.
  const start = ranking
    ? ranking.start.flatMap((s) => {
        const source = byKey.get(s.key);
        return source ? [{ source, reason: s.why }] : [];
      })
    : heuristic.startHere;
  const startKeys = new Set(start.map((s) => s.source.key));
  const ranked = ranking
    ? ranking.priority.flatMap((p) => {
        const source = byKey.get(p.key);
        return source && !startKeys.has(p.key) ? [{ source, level: p.level, why: p.why }] : [];
      })
    : [];
  const rankedKeys = new Set([...startKeys, ...ranked.map((r) => r.source.key)]);
  // Cited sources the ranking does not cover (e.g. the user's own notes), or everything without a ranking.
  const unranked = heuristic.cited.filter((c) => !rankedKeys.has(c.source.key));
  const others = heuristic.others.filter((s) => !rankedKeys.has(s.key));

  const mediumCount = ranked.filter((r) => r.level === "medium").length;
  const lowCount = ranked.filter((r) => r.level === "low").length;
  const hiddenRanked = Math.max(0, mediumCount - CITED_SHOWN) + lowCount;

  const rankButton = canRank && (
    <Tooltip content={ranking ? "Rank these sources again with the AI" : "Let the AI rank these sources by priority"}>
      <Button size="sm" variant="ghost" loading={rank.isPending} onClick={() => rank.mutate()}>
        <ListOrdered />
        {ranking ? "Re-rank" : "Rank with AI"}
      </Button>
    </Tooltip>
  );
  const orderSelect = (
    <select
      value={order}
      onChange={(e) => setOrder(e.target.value as SourceOrder)}
      aria-label="Sort cited sources"
      className="rounded-md bg-transparent py-0.5 text-[12px] text-muted hover:text-text"
    >
      {SOURCE_ORDERS.map((o) => (
        <option key={o.id} value={o.id}>
          {o.id === "relevance" && !ranking ? "Most relied on" : o.label}
        </option>
      ))}
    </select>
  );
  const why = (text: string | null, key: string) => {
    const u = usage.get(key);
    return text ?? (u ? usageNote(u) : null);
  };

  // Sorted by year or citation count, the ranked and unranked sources form one list.
  const flat =
    order === "relevance"
      ? null
      : sortCited(
          [
            ...ranked.map((r) => usage.get(r.source.key) ?? { source: r.source, mentions: 0, sections: [], first: 0 }),
            ...unranked,
          ],
          order,
        );

  return (
    <section aria-label="Sources" className="rounded-xl border border-border bg-surface px-3.5 py-1">
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5">
        <span className="text-[11.5px] text-subtle">
          {ranking ? `Ranked by AI${rankedBy(ranking) ? ` (${rankedBy(ranking)})` : ""}: a judgment, so check it` : ""}
        </span>
        <div className="flex items-center gap-1">{rankButton}</div>
      </div>
      {start.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className={heading}>Start here</h3>
            <SaveAll ids={start.filter((s) => s.source.type === "paper").map((s) => s.source.id)} papers={papers} />
          </div>
          <ol className="stagger divide-y divide-border" aria-label="Suggested reading order">
            {start.map((s, i) => (
              <SourceItem key={s.source.key} source={s.source} paper={paperOf(s.source)} rank={i + 1} note={s.reason} />
            ))}
          </ol>
        </div>
      )}
      {(ranked.length > 0 || unranked.length > 0) && (
        <div className={cn(start.length > 0 && "border-t border-border")}>
          <div className="flex items-center justify-between gap-2 pt-1.5">
            <h3 className={cn(heading, "py-1")}>{start.length ? "Also cited" : "Cited sources"}</h3>
            {orderSelect}
          </div>
          {flat ? (
            <ul className="divide-y divide-border">
              {flat.slice(0, allCited ? undefined : CITED_SHOWN).map((c) => (
                <SourceItem
                  key={c.source.key}
                  source={c.source}
                  paper={paperOf(c.source)}
                  note={why(ranked.find((r) => r.source.key === c.source.key)?.why ?? null, c.source.key)}
                />
              ))}
            </ul>
          ) : (
            <>
              {SOURCE_PRIORITIES.map((level) => {
                const items = ranked.filter((r) => r.level === level);
                if (!items.length) return null;
                // Folded: low priority is hidden and a long medium list shows its first few.
                const folded = level === "low" && !allCited;
                const visible = level === "medium" && !allCited ? items.slice(0, CITED_SHOWN) : items;
                return (
                  <div key={level}>
                    <h4 className="flex items-center gap-1.5 pt-2 text-[12px] font-medium text-muted">
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          level === "high" ? "bg-accent" : level === "medium" ? "bg-warning" : "bg-border-strong",
                        )}
                        aria-hidden
                      />
                      {PRIORITY_LABEL[level]} · {items.length}
                    </h4>
                    {!folded && (
                      <ul className="divide-y divide-border">
                        {visible.map((r) => (
                          <SourceItem
                            key={r.source.key}
                            source={r.source}
                            paper={paperOf(r.source)}
                            note={why(r.why, r.source.key)}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
              {unranked.length > 0 && (
                <ul className="divide-y divide-border">
                  {unranked.slice(0, ranking || allCited ? undefined : CITED_SHOWN).map((c) => (
                    <SourceItem key={c.source.key} source={c.source} paper={paperOf(c.source)} note={usageNote(c)} />
                  ))}
                </ul>
              )}
            </>
          )}
          {(ranking ? hiddenRanked > 0 || (flat?.length ?? 0) > CITED_SHOWN : unranked.length > CITED_SHOWN) && (
            <button
              type="button"
              onClick={() => setAllCited((v) => !v)}
              aria-expanded={allCited}
              className="flex w-full items-center gap-1.5 border-t border-border py-2.5 text-left text-[12.5px] text-muted hover:text-text"
            >
              <ChevronDown className={cn("size-3.5 transition-transform", allCited && "rotate-180")} aria-hidden />
              {allCited
                ? "Show fewer"
                : ranking && !flat
                  ? `Show ${hiddenRanked} more (${[
                      mediumCount > CITED_SHOWN ? `${mediumCount - CITED_SHOWN} medium` : "",
                      lowCount ? `${lowCount} low priority` : "",
                    ]
                      .filter(Boolean)
                      .join(", ")})`
                  : `Show all ${flat?.length ?? unranked.length} cited sources`}
            </button>
          )}
        </div>
      )}
      {others.length > 0 && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="flex w-full items-center gap-1.5 py-2.5 text-left text-[12.5px] text-muted hover:text-text"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} aria-hidden />
            {others.length} more source{others.length === 1 ? "" : "s"} consulted
          </button>
          {showAll && (
            <ul className="divide-y divide-border border-t border-border">
              {others.map((s) => (
                <SourceItem key={s.key} source={s} paper={paperOf(s)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function AssistantTurn({
  thread,
  message,
  question,
  onRetry,
  retrying,
  onOpenPage,
}: {
  thread: ResearchThreadDto;
  message: ResearchMessageDto;
  question: string;
  onRetry: () => void;
  retrying: boolean;
  /** Opens a cited page in place (the reader); returns false to follow the link instead. */
  onOpenPage?: (paperId: string, page: number) => boolean;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const byKey = new Map(message.sources.map((s) => [s.key, s]));
  const qc = useQueryClient();
  const saveNote = useMutation({
    mutationFn: () =>
      api<{ noteId: string; paperId: string | null; paperTitle: string | null }>(
        `/api/research/${thread.id}/messages/${message.id}/note`,
        { method: "POST" },
      ),
    onSuccess: ({ noteId, paperId, paperTitle }) => {
      // Pages showing notes (the paper's Notes tab, the notes list) must not show what they cached before.
      void qc.invalidateQueries({ queryKey: ["paper"] });
      void qc.invalidateQueries({ queryKey: ["notes"] });
      const short = paperTitle && paperTitle.length > 60 ? `${paperTitle.slice(0, 57)}…` : paperTitle;
      toast.success(
        paperId ? `Saved as a note on “${short}”, with its sources linked` : "Saved as a note, linked to its sources",
        { action: { label: "Open note", onClick: () => router.push(`/notes/${noteId}`) } },
      );
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const copy = async () => {
    const cited = citedKeys(message.content)
      .map((k) => byKey.get(k))
      .filter((s): s is ResearchSource => !!s);
    const refs = cited.map((s) => `[${s.key}] ${s.title}${s.year ? ` (${s.year})` : ""}`).join("\n");
    await navigator.clipboard.writeText(`${message.content.trim()}${refs ? `\n\nSources\n${refs}` : ""}\n`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const renderLink = (href: string, children: ReactNode) => {
    const page = /^#page-(P\d+)-(\d+)$/.exec(href);
    if (page) {
      const source = byKey.get(page[1]);
      if (!source || source.type !== "paper") return <span>{children}</span>;
      const n = Number(page[2]);
      return (
        <Link
          href={`/papers/${source.id}/read?page=${n}`}
          onClick={(e) => {
            if (onOpenPage?.(source.id, n)) e.preventDefault();
          }}
          className="text-[0.92em] text-accent-text underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          title={`Open page ${n} of “${source.title}”`}
        >
          {children}
        </Link>
      );
    }
    if (!href.startsWith("#cite-")) return undefined;
    const source = byKey.get(href.slice(6));
    return source ? <CitationChip source={source} /> : <span>[{children}]</span>;
  };

  return (
    <div className="space-y-3">
      <Activity message={message} />
      {message.content && (
        <article className="rounded-xl border border-ai/20 bg-ai-soft/30 px-4 py-3.5" aria-live="polite">
          <AiLabel
            model={[message.provider && PROVIDER_SHORT[message.provider], message.model].filter(Boolean).join(" · ")}
            className="mb-2"
          />
          <Markdown className="text-[14.5px] leading-relaxed" renderLink={renderLink}>
            {linkCitations(message.content)}
          </Markdown>
        </article>
      )}
      {message.changes && <ChangesCard threadId={thread.id} message={message} papers={thread.papers} />}
      {message.status === "error" && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-3"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <p className="flex-1 text-sm">{message.error ?? "The assistant could not answer."}</p>
          <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
            <RotateCcw />
            Try again
          </Button>
        </div>
      )}
      {message.status === "cancelled" && (
        <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-muted">
          <span className="flex-1">Stopped.</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={onRetry}
            loading={retrying}
            aria-label={`Run “${question}” again`}
          >
            <RotateCcw />
            Run again
          </Button>
        </div>
      )}
      {message.status === "done" && (
        <>
          <Sources threadId={thread.id} message={message} papers={thread.papers} />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => void copy()}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => saveNote.mutate()} loading={saveNote.isPending}>
              <NotebookPen />
              Save as note
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function ThreadTitle({ thread }: { thread: ResearchThreadDto }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(thread.title);

  const rename = async () => {
    setEditing(false);
    if (!title.trim() || title.trim() === thread.title) return setTitle(thread.title);
    try {
      await api(`/api/research/${thread.id}`, { method: "PATCH", body: { title: title.trim() } });
      await qc.invalidateQueries({ queryKey: ["research"] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    try {
      await api(`/api/research/${thread.id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["research", "list"] });
      router.push("/research");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Tooltip content="All conversations">
        <Button asChild size="icon" variant="ghost" aria-label="All conversations">
          <Link href="/research">
            <ArrowLeft />
          </Link>
        </Button>
      </Tooltip>
      {editing ? (
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void rename();
            if (e.key === "Escape") {
              setTitle(thread.title);
              setEditing(false);
            }
          }}
          aria-label="Conversation title"
          maxLength={200}
          className="min-w-0 flex-1 rounded-md bg-surface-2 px-2 py-1 text-lg font-semibold outline-none"
        />
      ) : (
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight" title={thread.title}>
          {thread.title}
        </h1>
      )}
      <Menu>
        <MenuTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="Conversation options">
            <MoreHorizontal />
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => setEditing(true)}>
            <Pencil />
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={() => void remove()}>
            <Trash2 />
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

/** Pairs each user message with the assistant reply that follows it. */
export function groupTurns(messages: ResearchMessageDto[]) {
  const turns: { user?: ResearchMessageDto; assistant?: ResearchMessageDto }[] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push({ user: m });
    else if (turns.length && !turns.at(-1)!.assistant) turns.at(-1)!.assistant = m;
    else turns.push({ assistant: m });
  }
  return turns;
}

export function ResearchThread({ id }: { id: string }) {
  const { data: thread, isLoading, error, refetch } = useResearchThread(id);
  const qc = useQueryClient();
  const aiEnabled = useAiEnabled();
  const [autoApply] = useAutoApply();
  const ask = useMutation({
    mutationFn: (input: { question: string; mode: ResearchMode; autoApply: boolean }) =>
      api<{ messageId: string }>(`/api/research/${id}/messages`, { body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["research"] }),
    onError: (err) => toast.error(errorMessage(err, "The question could not be sent.")),
  });
  const stop = useMutation({
    mutationFn: () => api(`/api/research/${id}/cancel`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["research"] }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading) return <PageLoading label="Loading conversation…" />;
  if (error || !thread) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState title="This conversation could not be opened" error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  const running = thread.messages.some((m) => m.status === "running");
  const turns = groupTurns(thread.messages);

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-8.5rem)] max-w-3xl flex-col">
      <ThreadTitle key={thread.title} thread={thread} />
      {(thread.scopePapers.length > 0 || thread.scopeCollection) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-10">
          <span className="text-[12.5px] text-muted">About:</span>
          {thread.scopePapers.map((p) => (
            <Link key={p.id} href={`/papers/${p.id}`}>
              <ScopeChip kind="paper" label={p.title} />
            </Link>
          ))}
          {thread.scopeCollection && (
            <Link href={`/library?collection=${thread.scopeCollection.id}`}>
              <ScopeChip kind="collection" label={`Collection: ${thread.scopeCollection.name}`} />
            </Link>
          )}
        </div>
      )}

      <div className="appear flex-1 space-y-8 py-6">
        {turns.map((t, i) => (
          <div key={t.user?.id ?? t.assistant?.id ?? i} className="space-y-4">
            {t.user && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-3/70 px-4 py-2.5 text-[14.5px] whitespace-pre-wrap">
                  {t.user.content}
                  <span className="mt-1 block text-right text-[11px] text-subtle">{MODE_INFO[t.user.mode].label}</span>
                </div>
              </div>
            )}
            {t.assistant && (
              <AssistantTurn
                thread={thread}
                message={t.assistant}
                question={t.user?.content ?? ""}
                retrying={ask.isPending}
                onRetry={() => t.user && ask.mutate({ question: t.user.content, mode: t.user.mode, autoApply })}
              />
            )}
          </div>
        ))}
      </div>

      <div className="sticky bottom-0 bg-gradient-to-t from-bg via-bg to-bg/0 pt-4 pb-4">
        <ResearchComposer
          label="Follow-up message"
          placeholder={running ? "Working…" : "Reply, ask a follow-up, or tell me what to organize…"}
          defaultMode="chat"
          running={running}
          pending={ask.isPending}
          disabled={!aiEnabled}
          onStop={() => stop.mutate()}
          onSubmit={(question, mode, auto) => ask.mutateAsync({ question, mode, autoApply: auto })}
          footer={
            <>
              <ModelPicker />
              <CapabilitiesButton />
            </>
          }
        />
      </div>
    </div>
  );
}
