"use client";

import { useQueries } from "@tanstack/react-query";
import { CheckCircle2, CircleHelp, CircleSlash, Loader2, MessagesSquare, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AiNotConfigured } from "@/components/ai/ai";
import { CapabilitiesList } from "./capabilities";
import { Skeleton } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/states";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useAiConfig, useCollections } from "@/lib/hooks";
import type { PaperDetail, ResearchMode, ResearchStatus } from "@/lib/types";
import { useQueryClient } from "@tanstack/react-query";
import { ModelPicker } from "@/components/ai/model-picker";
import { ResearchComposer, ScopeChip } from "./research-composer";
import { useResearchThreads, useStartResearch } from "./use-research";

const EXAMPLES: { text: string; mode: ResearchMode }[] = [
  { text: "What have I read about attention mechanisms, and what did I note?", mode: "chat" },
  {
    text: "Find 5 key papers on monocular depth estimation, save them to a new collection and link shared concepts",
    mode: "search",
  },
  { text: "What are the open problems in retrieval-augmented generation?", mode: "deep" },
];

export const STATUS_ICON: Record<ResearchStatus, { icon: typeof CheckCircle2; label: string; className: string }> = {
  running: { icon: Loader2, label: "Researching", className: "animate-spin text-ai" },
  done: { icon: CheckCircle2, label: "Done", className: "text-success" },
  error: { icon: TriangleAlert, label: "Failed", className: "text-danger" },
  cancelled: { icon: CircleSlash, label: "Stopped", className: "text-subtle" },
};

export function ResearchHome({
  initialQuestion,
  initialPaperIds,
  initialCollectionId,
}: {
  initialQuestion: string;
  initialPaperIds: string[];
  initialCollectionId: string | null;
}) {
  const ai = useAiConfig();
  const aiEnabled = !!ai.data?.configured && !!ai.data.enabled;
  const start = useStartResearch();
  const threads = useResearchThreads();
  const qc = useQueryClient();
  const { data: collections } = useCollections();
  const [paperIds, setPaperIds] = useState(initialPaperIds);
  const [collectionId, setCollectionId] = useState(initialCollectionId);
  const [composerKey, setComposerKey] = useState(0);
  const [prefill, setPrefill] = useState(initialQuestion);
  const [prefillMode, setPrefillMode] = useState<ResearchMode>(initialQuestion ? "search" : "chat");

  const scopePapers = useQueries({
    queries: paperIds.map((id) => ({
      queryKey: ["paper", id],
      queryFn: () => api<PaperDetail>(`/api/papers/${id}`),
    })),
  });
  const collection = collections?.find((c) => c.id === collectionId);
  const hasScope = paperIds.length > 0 || !!collectionId;

  const remove = async (id: string) => {
    try {
      await api(`/api/research/${id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["research", "list"] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl bg-ai-soft text-ai">
          <MessagesSquare className="size-6" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
        <p className="mx-auto mt-1.5 max-w-xl text-sm text-muted">
          Ask about your research, or ask it to organize your workspace — save papers, build collections, link concepts,
          write notes. Turn on <strong className="font-medium text-text">Literature search</strong> to find new papers,
          or <strong className="font-medium text-text">Deep research</strong> for a cited report.
        </p>
      </div>

      {ai.isLoading ? (
        <Skeleton className="h-36 rounded-2xl" />
      ) : aiEnabled ? (
        <ResearchComposer
          key={composerKey}
          large
          autoFocus
          label="Message"
          placeholder={
            hasScope
              ? "Ask about these papers, e.g. Compare their methods — or: link shared concepts"
              : "Ask anything, or tell me what to organize…"
          }
          initialText={prefill}
          defaultMode={prefillMode}
          pending={start.isPending}
          onSubmit={(question, mode, autoApply) =>
            start.mutateAsync({ question, mode, autoApply, scope: { paperIds, collectionId } })
          }
          chips={
            hasScope ? (
              <>
                <span className="self-center text-[12.5px] text-muted">About:</span>
                {paperIds.map((id, i) => (
                  <ScopeChip
                    key={id}
                    kind="paper"
                    label={scopePapers[i]?.data?.title ?? "Loading…"}
                    onRemove={() => setPaperIds((ids) => ids.filter((x) => x !== id))}
                  />
                ))}
                {collectionId && (
                  <ScopeChip
                    kind="collection"
                    label={collection ? `Collection: ${collection.name}` : "Collection"}
                    onRemove={() => setCollectionId(null)}
                  />
                )}
              </>
            ) : undefined
          }
          footer={<ModelPicker />}
        />
      ) : (
        <AiNotConfigured />
      )}

      {aiEnabled && !hasScope && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {EXAMPLES.map((q) => (
            <button
              key={q.text}
              type="button"
              onClick={() => {
                setPrefill(q.text);
                setPrefillMode(q.mode);
                setComposerKey((k) => k + 1);
              }}
              className="rounded-full border border-border bg-surface px-3 py-1.5 text-left text-[12.5px] text-muted hover:border-border-strong hover:text-text"
            >
              {q.text}
            </button>
          ))}
        </div>
      )}

      {aiEnabled && (
        <details className="group mt-6 rounded-xl border border-border bg-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13.5px] font-medium select-none">
            <CircleHelp className="size-4 text-ai" aria-hidden />
            What can the Assistant do?
            <span className="ml-auto text-[12px] font-normal text-subtle group-open:hidden">Show</span>
            <span className="ml-auto hidden text-[12px] font-normal text-subtle group-open:inline">Hide</span>
          </summary>
          <div className="border-t border-border px-4 py-4">
            <CapabilitiesList
              onPick={(text, mode) => {
                setPrefill(text);
                setPrefillMode(mode);
                setComposerKey((k) => k + 1);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          </div>
        </details>
      )}

      <section className="mt-10" aria-labelledby="recent-research">
        <h2 id="recent-research" className="mb-2 text-xs font-medium tracking-wide text-subtle uppercase">
          Conversations
        </h2>
        {threads.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : threads.error ? (
          <ErrorState error={threads.error} onRetry={() => threads.refetch()} />
        ) : !threads.data?.length ? (
          <p className="text-sm text-muted">Nothing yet. Your conversations are kept here.</p>
        ) : (
          <ul className="stagger divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
            {threads.data.map((t) => {
              const s = STATUS_ICON[t.status];
              return (
                <li key={t.id} className="group flex items-center gap-3 px-3.5 py-2.5 hover:bg-surface-2/60">
                  <s.icon className={`size-4 shrink-0 ${s.className}`} aria-label={s.label} />
                  <Link
                    href={`/research/${t.id}`}
                    className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                  >
                    {t.title}
                  </Link>
                  <span className="shrink-0 text-[12px] text-subtle">{relativeTime(t.updatedAt)}</span>
                  <button
                    type="button"
                    onClick={() => void remove(t.id)}
                    className="rounded p-1 text-subtle opacity-0 group-hover:opacity-100 hover:bg-danger-soft hover:text-danger focus:opacity-100"
                    aria-label={`Delete “${t.title}”`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
