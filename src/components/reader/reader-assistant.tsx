"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, History, Plus, Quote, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ModelPicker } from "@/components/ai/model-picker";
import { AssistantTurn, groupTurns } from "@/components/research/research-thread";
import { ResearchComposer, MODE_INFO, useAutoApply } from "@/components/research/research-composer";
import { useResearchThread } from "@/components/research/use-research";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { ReaderContext, ResearchMode, ResearchThreadSummary } from "@/lib/types";

/** A passage the user selected in the PDF and sent to the assistant ("Explain" or "Ask…"). */
export interface ReaderAiRequest {
  text: string;
  page: number;
  /** The user's question; without one the passage is explained. */
  question?: string;
  nonce: number;
}

const EXPLAIN = "Explain this passage: what it says, the terms it uses, and why it matters in the paper.";

const SUGGESTIONS = [
  "Walk me through this paper section by section",
  "Explain what is on this page",
  "What are the main results, and how strong is the evidence?",
  "What are the limitations the authors admit, and any they do not?",
];

/**
 * The assistant inside the reader: a normal assistant conversation about this paper, told which page
 * is on screen and what is selected, so "this section" and "this figure" mean what the user sees.
 * Conversations started here are listed with the others in the Assistant.
 */
export function ReaderAssistant({
  paperId,
  page,
  request,
  onJumpToPage,
}: {
  paperId: string;
  /** Scrolls the PDF to a page: page links to this paper open in place. */
  onJumpToPage?: (page: number) => void;
  /** The page on screen. */
  page: number | null;
  /** The latest passage sent from the PDF (handled once per nonce). */
  request: ReaderAiRequest | null;
}) {
  const qc = useQueryClient();
  const [autoApply] = useAutoApply();
  const threads = useQuery({
    queryKey: ["research", "list", "reader", paperId],
    queryFn: () => api<ResearchThreadSummary[]>(`/api/research?origin=reader&paperId=${paperId}`),
  });
  // null: the latest conversation; "new": a fresh one (created by the first question).
  const [chosen, setChosen] = useState<string | null>(null);
  const threadId = chosen === "new" ? null : (chosen ?? threads.data?.[0]?.id ?? null);
  const thread = useResearchThread(threadId ?? "");
  const [selection, setSelection] = useState<{ text: string; page: number } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: async (input: { question: string; mode: ResearchMode; autoApply: boolean; context: ReaderContext }) => {
      if (threadId) {
        await api(`/api/research/${threadId}/messages`, { body: input });
        return threadId;
      }
      const { threadId: created } = await api<{ threadId: string }>("/api/research", {
        body: { ...input, origin: "reader" },
      });
      return created;
    },
    onSuccess: async (id) => {
      setChosen(id);
      setSelection(null);
      await qc.invalidateQueries({ queryKey: ["research"] });
    },
    onError: (err) => toast.error(errorMessage(err, "The question could not be sent.")),
  });
  const stop = useMutation({
    mutationFn: () => api(`/api/research/${threadId}/cancel`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["research"] }),
  });

  const ask = (question: string, mode: ResearchMode, auto: boolean, picked = selection) =>
    send.mutateAsync({
      question,
      mode,
      autoApply: auto,
      context: { paperId, page: picked?.page ?? page, selection: picked?.text ?? null },
    });

  // "Explain" / "Ask…" on a selection in the PDF: explained (or asked) right away in this chat.
  const handled = useRef(0);
  useEffect(() => {
    if (!request || handled.current === request.nonce) return;
    handled.current = request.nonce;
    const picked = { text: request.text, page: request.page };
    void ask(request.question?.trim() || EXPLAIN, "chat", autoApply, picked).catch(() => setSelection(picked));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per request
  }, [request]);

  const messages = thread.data?.messages ?? [];
  const running = messages.some((m) => m.status === "running");
  const count = messages.length;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted" title={thread.data?.title}>
          {threadId ? (thread.data?.title ?? "Conversation") : "New conversation about this paper"}
        </span>
        <ModelPicker align="end" />
        {(threads.data?.length ?? 0) > 0 && (
          <Menu>
            <Tooltip content="Earlier conversations about this paper">
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Earlier conversations">
                  <History />
                </Button>
              </MenuTrigger>
            </Tooltip>
            <MenuContent align="end" className="max-w-72">
              {threads.data!.slice(0, 12).map((t) => (
                <MenuItem key={t.id} onSelect={() => setChosen(t.id)}>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="shrink-0 text-[11.5px] text-subtle">{relativeTime(t.updatedAt)}</span>
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        <Tooltip content="New conversation">
          <Button size="icon-sm" variant="ghost" aria-label="New conversation" onClick={() => setChosen("new")}>
            <Plus />
          </Button>
        </Tooltip>
        {threadId && (
          <Tooltip content="Open in Assistant">
            <Button size="icon-sm" variant="ghost" asChild aria-label="Open in Assistant">
              <Link href={`/research/${threadId}`}>
                <ExternalLink />
              </Link>
            </Button>
          </Tooltip>
        )}
      </div>

      <div className="appear min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {thread.isLoading ? (
          <Spinner label="Loading conversation…" />
        ) : !messages.length ? (
          <div className="space-y-3">
            <p className="text-[13px] text-muted">
              Ask anything about this paper. The assistant sees the page you are on and any text you select, reads the
              rest of the paper when it needs to, and can search your library or the literature.
            </p>
            <div className="flex flex-col items-start gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={send.isPending}
                  onClick={() => void ask(s, "chat", autoApply).catch(() => {})}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:border-border-strong hover:text-text"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          groupTurns(messages).map((t, i) => (
            <div key={t.user?.id ?? t.assistant?.id ?? i} className="space-y-3">
              {t.user && (
                <div className="ml-6 rounded-2xl rounded-br-md bg-surface-3/70 px-3 py-2 text-[13.5px] whitespace-pre-wrap">
                  {t.user.context?.selection && (
                    <blockquote className="mb-1.5 border-l-2 border-border-strong pl-2 text-[12.5px] text-muted italic">
                      <span className="line-clamp-3">{t.user.context.selection}</span>
                    </blockquote>
                  )}
                  {t.user.content}
                  <span className="mt-1 block text-right text-[11px] text-subtle">
                    {[t.user.context?.page ? `p. ${t.user.context.page}` : null, MODE_INFO[t.user.mode].label]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              )}
              {t.assistant && thread.data && (
                <AssistantTurn
                  thread={thread.data}
                  message={t.assistant}
                  onOpenPage={(id, n) => {
                    if (id !== paperId || !onJumpToPage) return false;
                    onJumpToPage(n);
                    return true;
                  }}
                  question={t.user?.content ?? ""}
                  retrying={send.isPending}
                  onRetry={() =>
                    t.user &&
                    void ask(
                      t.user.content,
                      t.user.mode,
                      autoApply,
                      t.user.context?.selection
                        ? { text: t.user.context.selection, page: t.user.context.page ?? page ?? 1 }
                        : null,
                    ).catch(() => {})
                  }
                />
              )}
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <ResearchComposer
          label="Message about this paper"
          placeholder={running ? "Working…" : "Ask about this paper, this page or the selected text…"}
          defaultMode="chat"
          running={running}
          pending={send.isPending}
          onStop={() => stop.mutate()}
          onSubmit={(question, mode, auto) => ask(question, mode, auto)}
          chips={
            <>
              {page && (
                <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[12px] text-muted">
                  Page {page}
                </span>
              )}
              {selection && (
                <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pr-1 pl-2 text-[12px] text-muted">
                  <Quote className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{selection.text}</span>
                  <button
                    type="button"
                    onClick={() => setSelection(null)}
                    className="rounded-full p-0.5 hover:bg-surface-3 hover:text-text"
                    aria-label="Remove the selected text"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              )}
            </>
          }
        />
      </div>
    </div>
  );
}
