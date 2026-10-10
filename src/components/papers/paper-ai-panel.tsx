"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { AiBasisLine, AiLabel, AiNotConfigured, AiOutput } from "@/components/ai/ai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { api, errorMessage, streamText } from "@/lib/api";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { useAiEnabled } from "@/lib/hooks";
import type { StreamMeta } from "@/lib/ai-stream";
import type { AiBasis, AiResultDto } from "@/lib/types";
import { ModelPicker } from "@/components/ai/model-picker";

const ANALYSES = [
  { kind: "summary", label: "Summary" },
  { kind: "contributions", label: "Key contributions" },
  { kind: "prerequisites", label: "Prerequisites" },
] as const;

type Turn = { role: "user" | "assistant"; content: string; basis?: AiBasis | null };

/** A request in flight: the text so far, plus what it reads and the provider's latest progress note. */
type Pending = {
  text: string;
  error: string | null;
  basis: AiBasis | null;
  status: string | null;
  startedAt: number;
};

function withMeta<T extends Pending | null>(p: T, m: StreamMeta): T {
  if (!p) return p;
  return { ...p, basis: m.basis ?? p.basis, status: m.status ?? p.status };
}

function AskPaper({ paperId }: { paperId: string }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = async () => {
    const q = question.trim();
    if (!q || (pending && !pending.error)) return;
    setQuestion("");
    setPending({ text: "", error: null, basis: null, status: null, startedAt: Date.now() });
    const history = turns.map(({ role, content }) => ({ role, content }));
    setTurns([...turns, { role: "user", content: q }]);
    let basis: AiBasis | null = null;
    try {
      const answer = await streamText(
        `/api/ai/papers/${paperId}/ask`,
        { question: q, history },
        (text) => setPending((p) => p && { ...p, text }),
        undefined,
        (m) => {
          basis = m.basis ?? basis;
          setPending((p) => withMeta(p, m));
        },
      );
      setTurns((t) => [...t, { role: "assistant", content: answer, basis }]);
      setPending(null);
    } catch (err) {
      setPending((p) => p && { ...p, error: errorMessage(err) });
    }
  };

  return (
    <div className="space-y-3">
      {turns.map((t, i) =>
        t.role === "user" ? (
          <p key={i} className="ml-8 rounded-lg bg-surface-2 px-3 py-2 text-sm">
            {t.content}
          </p>
        ) : (
          <div key={i} className="rounded-lg border border-ai/20 bg-ai-soft/30 p-3">
            <AiLabel />
            <Markdown className="mt-1.5">{t.content}</Markdown>
            {t.basis && <AiBasisLine basis={t.basis} className="mt-2" />}
          </div>
        ),
      )}
      {pending && (
        <AiOutput
          text={pending.text}
          loading={!pending.error}
          error={pending.error}
          basis={pending.basis}
          status={pending.status}
          startedAt={pending.startedAt}
        />
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
        className="flex gap-2"
      >
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
          placeholder="Ask a question about this paper…"
          aria-label="Ask a question about this paper"
          rows={1}
          className="min-h-9 flex-1 resize-none"
        />
        <Button type="submit" variant="ai" disabled={!question.trim() || (!!pending && !pending.error)}>
          Ask
        </Button>
      </form>
    </div>
  );
}

/** Optional AI help for a paper. Everything here is labeled as AI-generated. */
export function PaperAiPanel({ paperId, hasPdfText }: { paperId: string; hasPdfText: boolean }) {
  const enabled = useAiEnabled();
  const qc = useQueryClient();
  const [active, setActive] = useState<string>("summary");
  const [ask, setAsk] = useState(false);
  const [stream, setStream] = useState<(Pending & { kind: string }) | null>(null);

  const stored = useQuery({
    queryKey: ["ai-results", paperId],
    queryFn: () => api<AiResultDto[]>(`/api/ai/papers/${paperId}/analysis`),
    enabled,
  });

  if (!enabled) return <AiNotConfigured compact />;

  const current = stored.data?.find((r) => r.kind === active);
  const generating = stream?.kind === active && !stream.error;

  const generate = async (kind: string) => {
    setStream({ kind, text: "", error: null, basis: null, status: null, startedAt: Date.now() });
    try {
      await streamText(
        `/api/ai/papers/${paperId}/analysis`,
        { kind },
        (text) => setStream((s) => s && { ...s, text }),
        undefined,
        (m) => setStream((s) => withMeta(s, m)),
      );
      await qc.invalidateQueries({ queryKey: ["ai-results", paperId] });
      setStream(null);
    } catch (err) {
      setStream((s) => s && { ...s, error: errorMessage(err) });
    }
  };

  return (
    <section aria-labelledby="ai-title" className="rounded-xl border border-ai/20 bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto flex min-w-0 items-center gap-1">
          <h2 id="ai-title" className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="size-4 text-ai" aria-hidden />
            AI assistant
          </h2>
          <ModelPicker />
        </div>
        {ANALYSES.map((a) => (
          <button
            key={a.kind}
            type="button"
            onClick={() => {
              setAsk(false);
              setActive(a.kind);
            }}
            className={cn(
              "rounded-md px-2.5 py-1 text-[13px] font-medium",
              !ask && active === a.kind ? "bg-ai-soft text-ai" : "text-muted hover:text-text",
            )}
          >
            {a.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setAsk(true)}
          className={cn(
            "flex items-center gap-1 rounded-md px-2.5 py-1 text-[13px] font-medium",
            ask ? "bg-ai-soft text-ai" : "text-muted hover:text-text",
          )}
        >
          <MessageSquare className="size-3.5" aria-hidden />
          Ask
        </button>
      </div>
      {!hasPdfText && !current && !stream && !ask && (
        <p className="mt-2 text-[12.5px] text-subtle">
          No PDF attached: the AI reads the free open-access copy when there is one, otherwise only the abstract.
        </p>
      )}
      <div className="mt-3">
        {ask ? (
          <AskPaper paperId={paperId} />
        ) : stream?.kind === active ? (
          <AiOutput
            text={stream.text}
            loading={generating}
            error={stream.error}
            basis={stream.basis}
            status={stream.status}
            startedAt={stream.startedAt}
          />
        ) : current ? (
          <AiOutput
            text={current.content}
            model={current.model}
            basis={current.basis}
            actions={
              <Button size="sm" variant="ghost" onClick={() => generate(active)} aria-label="Regenerate">
                <RefreshCw />
                {relativeTime(current.createdAt)}
              </Button>
            }
          />
        ) : (
          <Button variant="ai" onClick={() => generate(active)}>
            <Sparkles />
            Generate {ANALYSES.find((a) => a.kind === active)?.label.toLowerCase()}
          </Button>
        )}
      </div>
    </section>
  );
}
