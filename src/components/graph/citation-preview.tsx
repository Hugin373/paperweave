"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, GitFork, Quote, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AiOutput } from "@/components/ai/ai";
import { SaveControl } from "@/components/papers/save-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, errorMessage, streamText } from "@/lib/api";
import { formatAuthors, formatCount } from "@/lib/format";
import { useAiEnabled } from "@/lib/hooks";
import type { PaperDetail, PaperSummary } from "@/lib/types";

export function ExplainCitation({ citing, cited }: { citing: PaperSummary; cited: PaperSummary }) {
  const aiEnabled = useAiEnabled();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  if (!aiEnabled) return null;

  const run = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setText("");
    setError(null);
    setLoading(true);
    try {
      await streamText("/api/ai/citation", { citingId: citing.id, citedId: cited.id }, setText, ctrl.signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(errorMessage(err, "The explanation could not be generated."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button size="sm" variant="ai" onClick={run} loading={loading}>
        <Sparkles />
        Explain this citation
      </Button>
      <AiOutput text={text} loading={loading} error={error} />
    </div>
  );
}

function CitationFact({ citing, cited }: { citing: PaperSummary; cited: PaperSummary }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/60 p-3 text-[13px]">
      <p className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Citation (from scholarly data)</p>
      <Link href={`/papers/${citing.id}`} className="line-clamp-2 font-medium hover:underline">
        {citing.title}
      </Link>
      <p className="my-1 flex items-center gap-1 text-muted">
        <ArrowRight className="size-3.5" aria-hidden /> cites
      </p>
      <Link href={`/papers/${cited.id}`} className="line-clamp-2 font-medium hover:underline">
        {cited.title}
      </Link>
    </div>
  );
}

export function PaperPreview({
  paper,
  citationPair,
  expanding,
  onExpand,
  onLibraryState,
  onClose,
}: {
  paper: PaperSummary;
  /** When this paper is directly linked to the focus paper: who cites whom. */
  citationPair: { citing: PaperSummary; cited: PaperSummary } | null;
  expanding: "references" | "citations" | null;
  onExpand: (dir: "references" | "citations") => void;
  onLibraryState: (paperId: string, status: PaperSummary["library"]) => void;
  onClose: () => void;
}) {
  // Fresh library state (the save button invalidates ["paper"] queries).
  const { data: detail } = useQuery({
    queryKey: ["paper", paper.id],
    queryFn: () => api<PaperDetail>(`/api/papers/${paper.id}`),
  });
  const library = detail ? detail.library : paper.library;
  useEffect(() => {
    if (detail) onLibraryState(paper.id, detail.library);
  }, [detail, paper.id, onLibraryState]);

  return (
    <aside
      aria-label="Selected paper"
      className="flex h-full flex-col overflow-hidden border-l border-border bg-surface"
    >
      <div className="flex items-start gap-2 border-b border-border p-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-[15px] leading-snug font-semibold">{paper.title}</h2>
          <p className="mt-1 text-[12.5px] text-muted">
            {formatAuthors(paper.authors)}
            {paper.venue ? ` · ${paper.venue}` : ""}
            {paper.year ? ` · ${paper.year}` : ""}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex flex-wrap gap-1.5">
          {paper.citationCount !== null && (
            <Badge>
              <Quote aria-hidden />
              {formatCount(paper.citationCount)} citations
            </Badge>
          )}
          {paper.referenceCount !== null && (
            <Badge tone="outline">{formatCount(paper.referenceCount)} references</Badge>
          )}
        </div>
        {paper.abstract ? (
          <p className="line-clamp-[8] text-[13px] leading-relaxed text-text/85">{paper.abstract}</p>
        ) : (
          <p className="text-[13px] text-subtle italic">No abstract available from the source.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <SaveControl paperId={paper.id} library={library} />
          <Button asChild size="sm" variant="secondary">
            <Link href={`/papers/${paper.id}`}>
              <ExternalLink />
              Open paper
            </Link>
          </Button>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium tracking-wide text-subtle uppercase">Explore lineage</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={expanding === "references"}
              disabled={!!expanding}
              onClick={() => onExpand("references")}
            >
              <GitFork className="rotate-180" />
              Expand references
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={expanding === "citations"}
              disabled={!!expanding}
              onClick={() => onExpand("citations")}
            >
              <GitFork />
              Expand citations
            </Button>
          </div>
          <Link
            href={`/papers/${paper.id}/graph`}
            className="inline-block text-[12.5px] text-accent-text hover:underline"
          >
            Re-center the explorer on this paper
          </Link>
        </div>
        {citationPair && (
          <div className="space-y-2">
            <CitationFact {...citationPair} />
            <ExplainCitation key={paper.id} {...citationPair} />
          </div>
        )}
      </div>
    </aside>
  );
}

export function EdgePreview({
  citing,
  cited,
  onClose,
}: {
  citing: PaperSummary;
  cited: PaperSummary;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Selected citation"
      className="flex h-full flex-col overflow-hidden border-l border-border bg-surface"
    >
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="text-sm font-semibold">Citation</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <CitationFact citing={citing} cited={cited} />
        <ExplainCitation key={`${citing.id}-${cited.id}`} citing={citing} cited={cited} />
      </div>
    </aside>
  );
}
