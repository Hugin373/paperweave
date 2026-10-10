"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Maximize2, Minimize2, Minus, Network, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { GraphCanvas, GraphCanvas3D } from "@/components/graph/graph-canvas";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage, qs } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { CitationGraphResponse, GraphEdge, GraphNode, GraphResponse } from "@/lib/types";
import { usePersistentState } from "@/lib/use-persistent-state";

type Mode = "citations" | "knowledge";

const MODES = ["citations", "knowledge"] as const;

function entityHref(n: GraphNode) {
  return n.type === "paper"
    ? `/papers/${n.entityId}`
    : n.type === "concept"
      ? `/concepts/${n.entityId}`
      : `/notes/${n.entityId}`;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex rounded-md bg-surface-2 p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-1.5 py-0.5 text-[11.5px] font-medium",
            value === o.value ? "bg-surface text-text shadow-xs" : "text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A small, collapsible graph next to the PDF: this paper's citation neighborhood (earlier work on
 * the left, later work on the right) or its links in your knowledge graph. Opens items in a new
 * tab so reading is never interrupted.
 */
export function ReaderGraphDock({ paperId }: { paperId: string }) {
  const [open, setOpen] = usePersistentState("pw-reader-graph", "open", ["open", "closed"] as const);
  const [size, setSize] = usePersistentState("pw-reader-graph-size", "small", ["small", "large"] as const);
  const [mode, setMode] = usePersistentState<Mode>("pw-reader-graph-mode", "citations", MODES);
  const [dims, setDims] = usePersistentState("pw-reader-graph-dims", "3d", ["3d", "2d"] as const);
  const [selected, setSelected] = useState<string | null>(null);
  const [resetNonce, setResetNonce] = useState(0);

  const citations = useQuery({
    queryKey: ["citation-graph", paperId, "dock"],
    queryFn: () => api<CitationGraphResponse>(`/api/papers/${paperId}/citation-graph${qs({ refs: 15, cites: 15 })}`),
    enabled: open === "open" && mode === "citations",
    staleTime: 10 * 60_000,
  });
  const knowledge = useQuery({
    queryKey: ["graph", { focus: `paper:${paperId}`, depth: 2, dock: true }],
    queryFn: () => api<GraphResponse>(`/api/graph${qs({ focus: `paper:${paperId}`, depth: 2 })}`),
    enabled: open === "open" && mode === "knowledge",
  });
  const active = mode === "citations" ? citations : knowledge;
  const nodes: GraphNode[] = useMemo(() => active.data?.nodes ?? [], [active.data]);
  const edges: GraphEdge[] = useMemo(() => active.data?.edges ?? [], [active.data]);

  // Citations in 3D: earlier work on the left, later work on the right.
  const fixedX = useMemo(() => {
    if (mode !== "citations") return undefined;
    const out: Record<string, number> = {};
    for (const n of nodes) out[n.id] = n.role === "reference" ? -45 : n.role === "citation" ? 45 : 0;
    return out;
  }, [mode, nodes]);

  const selectedNode = selected ? (nodes.find((n) => n.id === selected) ?? null) : null;
  const fullHref = mode === "citations" ? `/papers/${paperId}/graph` : `/graph?focus=paper:${paperId}`;

  if (open === "closed") {
    return (
      <button
        type="button"
        onClick={() => setOpen("open")}
        className="absolute right-4 bottom-4 z-20 flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-2 text-[13px] font-medium shadow-lg hover:border-border-strong"
        aria-label="Show graph"
      >
        <Network className="size-4 text-accent" aria-hidden />
        Graph
      </button>
    );
  }

  return (
    <section
      aria-label="Paper graph"
      className={cn(
        "absolute right-4 bottom-4 z-20 flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl",
        size === "large"
          ? "h-[min(34rem,calc(100%-2rem))] w-[min(46rem,calc(100%-2rem))]"
          : "h-[17rem] w-[min(22rem,calc(100%-2rem))]",
      )}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Segmented
          label="Graph type"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setSelected(null);
          }}
          options={[
            { value: "citations", label: "Citations" },
            { value: "knowledge", label: "My links" },
          ]}
        />
        <Segmented
          label="Dimensions"
          value={dims}
          onChange={setDims}
          options={[
            { value: "3d", label: "3D" },
            { value: "2d", label: "2D" },
          ]}
        />
        {active.isFetching && <Spinner className="size-3.5" />}
        <div className="ml-auto flex items-center">
          <Tooltip content="Reset layout and view">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                setSelected(null);
                setResetNonce((n) => n + 1);
              }}
              aria-label="Reset graph"
            >
              <RotateCcw />
            </Button>
          </Tooltip>
          <Tooltip content="Open the full graph (new tab)">
            <Button asChild size="icon-sm" variant="ghost" aria-label="Open the full graph">
              <Link href={fullHref} target="_blank" rel="noopener">
                <ExternalLink />
              </Link>
            </Button>
          </Tooltip>
          <Tooltip content={size === "large" ? "Make smaller" : "Make larger"}>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setSize(size === "large" ? "small" : "large")}
              aria-label={size === "large" ? "Make graph smaller" : "Make graph larger"}
            >
              {size === "large" ? <Minimize2 /> : <Maximize2 />}
            </Button>
          </Tooltip>
          <Tooltip content="Minimize">
            <Button size="icon-sm" variant="ghost" onClick={() => setOpen("closed")} aria-label="Minimize graph">
              <Minus />
            </Button>
          </Tooltip>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 bg-bg">
        {active.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label={mode === "citations" ? "Loading citations…" : "Loading links…"} />
          </div>
        ) : active.error ? (
          <p className="p-4 text-center text-[12.5px] text-danger">{errorMessage(active.error)}</p>
        ) : nodes.length <= 1 ? (
          <p className="p-4 text-center text-[12.5px] text-muted">
            {mode === "citations"
              ? "No citation data is available for this paper."
              : "Nothing is linked to this paper yet. Link a concept or mention it in a note to see connections here."}
          </p>
        ) : dims === "3d" ? (
          <GraphCanvas3D
            key={mode}
            nodes={nodes}
            edges={edges}
            fixedX={fixedX}
            selectedNodeId={selected}
            onSelectNode={setSelected}
            resetNonce={resetNonce}
            compact
            onUnsupported={() => setDims("2d")}
            ariaLabel={`${mode === "citations" ? "Citation" : "Knowledge"} graph of this paper with ${nodes.length} items`}
          />
        ) : (
          <GraphCanvas
            key={mode}
            nodes={nodes}
            edges={edges}
            mode={mode === "citations" ? "citation" : "knowledge"}
            selectedNodeId={selected}
            onSelectNode={setSelected}
            resetNonce={resetNonce}
            ariaLabel={`${mode === "citations" ? "Citation" : "Knowledge"} graph of this paper with ${nodes.length} items`}
          />
        )}
      </div>

      {selectedNode ? (
        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-medium" title={selectedNode.label}>
              {selectedNode.label}
            </p>
            {selectedNode.sublabel && <p className="truncate text-[11.5px] text-muted">{selectedNode.sublabel}</p>}
          </div>
          {selectedNode.entityId !== paperId && (
            <Button asChild size="sm" variant="secondary" className="h-7 px-2 text-[12px]">
              <Link href={entityHref(selectedNode)} target="_blank" rel="noopener">
                <ExternalLink />
                Open
              </Link>
            </Button>
          )}
        </footer>
      ) : (
        <p className="shrink-0 border-t border-border px-2.5 py-1 text-[11.5px] text-subtle">
          {mode === "citations" ? "← earlier work · later work → · " : ""}Click a node for details
        </p>
      )}
    </section>
  );
}
