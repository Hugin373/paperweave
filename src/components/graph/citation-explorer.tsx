"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, GitFork, RotateCcw } from "lucide-react";
import Link from "next/link";
import { SaveControl } from "@/components/papers/save-control";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage, qs } from "@/lib/api";
import { usePersistentState } from "@/lib/use-persistent-state";
import { formatCount, shortAuthors } from "@/lib/format";
import type { CitationGraphResponse, GraphEdge, GraphNode, PaperSummary } from "@/lib/types";
import { EdgePreview, PaperPreview } from "./citation-preview";
import type { Position } from "./graph-style";
import { GraphCanvas, GraphCanvas3D } from "./graph-canvas";
import { CitationLegend } from "./legend";
import { expansionPositions, lineagePositions } from "./lineage-layout";
import { GRAPH_VIEWS, ViewSwitcher } from "./view-switcher";

interface ExplorerState {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  papers: Map<string, PaperSummary>;
  positions: Record<string, Position>;
}

const pid = (graphId: string) => graphId.replace(/^paper:/, "");

function fromResponse(res: CitationGraphResponse): ExplorerState {
  const center = res.nodes.find((n) => n.role === "center")!;
  const refs = res.nodes.filter((n) => n.role === "reference");
  const cites = res.nodes.filter((n) => n.role === "citation");
  return {
    nodes: new Map(res.nodes.map((n) => [n.id, n])),
    edges: new Map(res.edges.map((e) => [e.id, e])),
    papers: new Map(Object.entries(res.papers)),
    positions: lineagePositions(center.id, refs, cites),
  };
}

function PaperList({ title, papers }: { title: string; papers: PaperSummary[] }) {
  if (!papers.length) return null;
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">
        {title} <span className="font-normal text-subtle">({papers.length})</span>
      </h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
        {papers.map((p) => (
          <li key={p.id} className="flex items-start gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <Link href={`/papers/${p.id}`} className="text-sm font-medium hover:text-accent-text hover:underline">
                {p.title}
              </Link>
              <p className="text-[12.5px] text-muted">
                {[
                  shortAuthors(p.authors),
                  p.year,
                  p.citationCount !== null ? `${formatCount(p.citationCount)} citations` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <SaveControl paperId={p.id} library={p.library} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Interactive research-lineage explorer around one paper. Mount with `key={paperId}`. */
export function CitationExplorer({ paperId }: { paperId: string }) {
  const centerId = `paper:${paperId}`;
  const query = useQuery({
    queryKey: ["citation-graph", paperId],
    queryFn: () => api<CitationGraphResponse>(`/api/papers/${paperId}/citation-graph${qs({ refs: 20, cites: 20 })}`),
  });
  // Papers added by expanding nodes, and library states learned after saving.
  const [extra, setExtra] = useState<ExplorerState>(() => ({
    nodes: new Map(),
    edges: new Map(),
    papers: new Map(),
    positions: {},
  }));
  const [libraryOverrides, setLibraryOverrides] = useState<Map<string, PaperSummary["library"]>>(() => new Map());
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [expanding, setExpanding] = useState<{ id: string; dir: "references" | "citations" } | null>(null);
  const [view, setView] = usePersistentState("pw-citation-view", "3d", GRAPH_VIEWS);
  const [resetNonce, setResetNonce] = useState(0);

  /** Removes papers added by exploring, clears the selection and lays the graph out again. */
  const reset = () => {
    setExtra({ nodes: new Map(), edges: new Map(), papers: new Map(), positions: {} });
    setSelectedNode(null);
    setSelectedEdge(null);
    setResetNonce((n) => n + 1);
  };

  // The initial neighborhood is derived from the query (refetches refresh library state);
  // expansions are layered on top.
  const state = useMemo<ExplorerState | null>(() => {
    if (!query.data) return null;
    const base = fromResponse(query.data);
    const nodes = new Map(base.nodes);
    for (const [id, n] of extra.nodes) if (!nodes.has(id)) nodes.set(id, n);
    const papers = new Map(extra.papers);
    for (const [id, p] of base.papers) papers.set(id, p);
    for (const [id, library] of libraryOverrides) {
      const p = papers.get(id);
      if (p) papers.set(id, { ...p, library });
      const n = nodes.get(`paper:${id}`);
      if (n) nodes.set(n.id, { ...n, status: library?.status ?? null });
    }
    return {
      nodes,
      edges: new Map([...base.edges, ...extra.edges]),
      papers,
      positions: { ...extra.positions, ...base.positions },
    };
  }, [query.data, extra, libraryOverrides]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedNode(null);
        setSelectedEdge(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onLibraryState = useCallback((id: string, library: PaperSummary["library"]) => {
    setLibraryOverrides((prev) => {
      const current = prev.get(id);
      if (prev.has(id) && (current?.status ?? null) === (library?.status ?? null)) return prev;
      return new Map(prev).set(id, library);
    });
  }, []);

  const expand = async (node: GraphNode, dir: "references" | "citations") => {
    if (!state) return;
    setExpanding({ id: node.id, dir });
    try {
      const res = await api<CitationGraphResponse>(
        `/api/papers/${node.entityId}/citation-graph${qs({
          refs: dir === "references" ? 12 : 0,
          cites: dir === "citations" ? 12 : 0,
        })}`,
      );
      const fresh = res.nodes.filter((n) => n.role !== "center" && !state.nodes.has(n.id));
      const placed = expansionPositions(
        state.positions[node.id] ?? { x: 0, y: 0 },
        fresh.filter((n) => n.role === "reference"),
        fresh.filter((n) => n.role === "citation"),
        state.positions,
      );
      setExtra((prev) => {
        const nodes = new Map(prev.nodes);
        const edges = new Map(prev.edges);
        const papers = new Map(prev.papers);
        for (const n of fresh) nodes.set(n.id, { ...n, role: "expanded" });
        for (const e of res.edges) edges.set(e.id, e);
        for (const [id, p] of Object.entries(res.papers)) if (!papers.has(id)) papers.set(id, p);
        return { nodes, edges, papers, positions: { ...prev.positions, ...placed } };
      });
      if (res.partial) toast.warning("Some citation data couldn't be loaded right now.");
      else if (!res.nodes.some((n) => n.role !== "center")) {
        toast.info(
          dir === "references" ? "No references are available for this paper." : "No citing papers were found.",
        );
      } else if (!fresh.length) toast.info("Those papers are already in the graph.");
    } catch (err) {
      toast.error(errorMessage(err, "Citation data could not be loaded."));
    } finally {
      setExpanding(null);
    }
  };

  const nodes = useMemo(() => (state ? [...state.nodes.values()] : []), [state]);
  // In 3D, time stays on the left–right axis: each paper keeps its 2D lineage x position.
  const fixedX = useMemo(() => {
    const out: Record<string, number> = {};
    if (state) for (const [id, p] of Object.entries(state.positions)) out[id] = p.x / 3;
    return out;
  }, [state]);
  const edges = useMemo(() => (state ? [...state.edges.values()] : []), [state]);
  const center = state?.papers.get(paperId) ?? null;
  const counts = useMemo(() => {
    const c = { reference: 0, citation: 0, expanded: 0 };
    for (const n of nodes) if (n.role && n.role !== "center") c[n.role]++;
    return c;
  }, [nodes]);

  const selectedPaper = selectedNode && state ? (state.papers.get(pid(selectedNode)) ?? null) : null;
  const citationPair = useMemo(() => {
    if (!state || !selectedNode || selectedNode === centerId || !center) return null;
    const out = state.edges.get(`cites:${centerId}->${selectedNode}`);
    const inc = state.edges.get(`cites:${selectedNode}->${centerId}`);
    const other = state.papers.get(pid(selectedNode));
    if (!other) return null;
    if (out) return { citing: center, cited: other };
    if (inc) return { citing: other, cited: center };
    return null;
  }, [state, selectedNode, centerId, center]);
  const edge = selectedEdge && state ? state.edges.get(selectedEdge) : null;
  const edgePapers =
    edge && state ? { citing: state.papers.get(pid(edge.source)), cited: state.papers.get(pid(edge.target)) } : null;

  if (query.isLoading) {
    return (
      <div className="flex h-[calc(100dvh-3.5rem)] items-center justify-center">
        <Spinner label="Loading references and citations…" />
      </div>
    );
  }
  if (query.error || !state) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState
          title="The citation graph could not be loaded"
          error={query.error}
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }

  const listByRole = (role: GraphNode["role"]) =>
    nodes
      .filter((n) => n.role === role)
      .map((n) => state.papers.get(n.entityId))
      .filter((p): p is PaperSummary => !!p);

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg px-4 py-2.5 md:px-6">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/papers/${paperId}`}>
            <ArrowLeft />
            Paper
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold">
            <GitFork className="size-4 shrink-0 text-muted" aria-hidden />
            <span className="truncate">Citation explorer: {center?.title ?? "…"}</span>
          </h1>
          <p className="text-[12.5px] text-muted">
            {counts.reference} references
            {center?.referenceCount ? ` of ${formatCount(center.referenceCount)}` : ""} · {counts.citation} citing
            papers
            {center?.citationCount ? ` of ${formatCount(center.citationCount)}` : ""}
            {counts.expanded ? ` · ${counts.expanded} added by exploring` : ""}
            {query.data?.truncated ? " · showing the most-cited" : ""}
          </p>
        </div>
        <CitationLegend className="hidden lg:flex" />
        <Button
          size="sm"
          variant="ghost"
          onClick={reset}
          title="Remove papers added by exploring and reset the layout and camera"
        >
          <RotateCcw />
          Reset
        </Button>
        <ViewSwitcher view={view} onChange={setView} />
      </div>
      {query.data?.partial && (
        <p
          className="flex items-center gap-2 border-b border-border bg-warning-soft px-4 py-1.5 text-[12.5px] text-warning md:px-6"
          role="status"
        >
          <AlertTriangle className="size-3.5" aria-hidden />
          Some citation data couldn&apos;t be loaded right now. Try again in a minute.
        </p>
      )}

      <div className="relative flex min-h-0 flex-1">
        {nodes.length <= 1 ? (
          <div className="flex-1 p-6">
            <EmptyState
              icon={GitFork}
              title="No citation data available"
              description="Scholarly sources don't list references or citing papers for this paper (yet)."
              action={
                <Button asChild variant="secondary">
                  <Link href={`/papers/${paperId}`}>Back to paper</Link>
                </Button>
              }
            />
          </div>
        ) : view === "list" ? (
          <div className="min-w-0 flex-1 overflow-y-auto px-4 py-5 md:px-8">
            <div className="mx-auto max-w-3xl space-y-8">
              <PaperList title="References (earlier work)" papers={listByRole("reference")} />
              <PaperList title="Cited by (later work)" papers={listByRole("citation")} />
              <PaperList title="Added by exploring" papers={listByRole("expanded")} />
            </div>
          </div>
        ) : (
          <>
            <div className="relative min-w-0 flex-1">
              {view === "3d" ? (
                <GraphCanvas3D
                  nodes={nodes}
                  edges={edges}
                  fixedX={fixedX}
                  resetNonce={resetNonce}
                  selectedNodeId={selectedNode}
                  selectedEdgeId={selectedEdge}
                  onSelectNode={(id) => {
                    setSelectedNode(id);
                    setSelectedEdge(null);
                  }}
                  onSelectEdge={(id) => {
                    setSelectedEdge(id);
                    setSelectedNode(null);
                  }}
                  onUnsupported={() => setView("2d")}
                  ariaLabel={`3D citation graph of ${center?.title ?? "this paper"}: ${counts.reference} references and ${counts.citation} citing papers. Use the list view for a text version.`}
                />
              ) : (
                <GraphCanvas
                  nodes={nodes}
                  edges={edges}
                  mode="citation"
                  layout="preset"
                  positions={state.positions}
                  resetNonce={resetNonce}
                  selectedNodeId={selectedNode}
                  selectedEdgeId={selectedEdge}
                  onSelectNode={(id) => {
                    setSelectedNode(id);
                    setSelectedEdge(null);
                  }}
                  onSelectEdge={(id) => {
                    setSelectedEdge(id);
                    setSelectedNode(null);
                  }}
                  ariaLabel={`Citation graph of ${center?.title ?? "this paper"}: ${counts.reference} references and ${counts.citation} citing papers. Use the list view for a text version.`}
                />
              )}
              <p className="pointer-events-none absolute top-3 left-3 rounded-md bg-surface/90 px-2 py-1 text-[11.5px] text-muted shadow-xs">
                ← earlier work · later work → · click a paper to explore
              </p>
              <CitationLegend className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-5rem)] rounded-lg border border-border bg-surface/90 px-2.5 py-1.5 lg:hidden" />
            </div>
            {(selectedPaper || (edgePapers?.citing && edgePapers.cited)) && (
              <div className="absolute inset-x-0 bottom-0 z-10 h-[60%] shadow-2xl md:static md:h-auto md:w-80 md:shrink-0 md:shadow-none">
                {selectedPaper ? (
                  <PaperPreview
                    paper={selectedPaper}
                    citationPair={citationPair}
                    expanding={expanding && expanding.id === selectedNode ? expanding.dir : null}
                    onExpand={(dir) => {
                      const node = selectedNode ? state.nodes.get(selectedNode) : null;
                      if (node) void expand(node, dir);
                    }}
                    onLibraryState={onLibraryState}
                    onClose={() => setSelectedNode(null)}
                  />
                ) : (
                  <EdgePreview
                    citing={edgePapers!.citing!}
                    cited={edgePapers!.cited!}
                    onClose={() => setSelectedEdge(null)}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
