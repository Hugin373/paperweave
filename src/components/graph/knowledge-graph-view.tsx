"use client";

import { useQuery } from "@tanstack/react-query";
import { Network, RotateCcw, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Spinner } from "@/components/ui/spinner";
import { api, qs } from "@/lib/api";
import { collectionColor } from "@/lib/collection-colors";
import { cn } from "@/lib/cn";
import { useCollections } from "@/lib/hooks";
import { usePersistentState } from "@/lib/use-persistent-state";
import type { GraphNode, GraphNodeType, GraphResponse } from "@/lib/types";
import { GraphCanvas, GraphCanvas3D } from "./graph-canvas";
import { GraphInspector, NODE_COLOR, NODE_ICON } from "./graph-inspector";
import { GraphListView } from "./graph-list-view";
import { CollectionLegend, KnowledgeLegend } from "./legend";
import { GRAPH_VIEWS, ViewSwitcher } from "./view-switcher";

const TYPES: { type: GraphNodeType; label: string }[] = [
  { type: "paper", label: "Papers" },
  { type: "concept", label: "Concepts" },
  { type: "note", label: "Notes" },
];

function Toggle({
  pressed,
  onClick,
  children,
  label,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium transition-colors",
        pressed
          ? "border-border-strong bg-surface text-text shadow-xs"
          : "border-transparent text-subtle hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

function FindNode({ nodes, onPick }: { nodes: GraphNode[]; onPick: (n: GraphNode) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const term = q.trim().toLowerCase();
  const matches = term ? nodes.filter((n) => n.label.toLowerCase().includes(term)).slice(0, 8) : [];
  return (
    <div className="relative w-full sm:w-56">
      <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-subtle" aria-hidden />
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches[0]) {
            onPick(matches[0]);
            setOpen(false);
          }
        }}
        placeholder="Find in graph…"
        aria-label="Find a node in the graph"
        className="h-8 pl-8"
      />
      {open && matches.length > 0 && (
        <ul
          className="absolute top-9 z-20 w-72 max-w-[80vw] rounded-lg border border-border bg-surface p-1 shadow-lg"
          role="listbox"
        >
          {matches.map((n) => {
            const Icon = NODE_ICON[n.type];
            return (
              <li key={n.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onPick(n);
                    setOpen(false);
                  }}
                >
                  <Icon className="size-3.5 shrink-0" style={{ color: NODE_COLOR[n.type] }} aria-hidden />
                  <span className="truncate">{n.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The personal knowledge graph: whole workspace, or the neighborhood of one item. */
export function KnowledgeGraphView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const focus = params.get("focus");
  const depth = Number(params.get("depth") ?? 1) || 1;

  const [types, setTypes] = useState<Set<GraphNodeType>>(new Set(["paper", "concept", "note"]));
  const [showCitations, setShowCitations] = useState(true);
  const [showKnowledge, setShowKnowledge] = useState(true);
  const [archived, setArchived] = useState(false);
  const [collectionId, setCollectionId] = useState("");
  // 3D is the default: it keeps large graphs readable. The choice is remembered per browser.
  const [view, setView] = usePersistentState("pw-graph-view", "3d", GRAPH_VIEWS);
  const [colorBy, setColorBy] = usePersistentState("pw-graph-color", "type", ["type", "collection"] as const);
  // Selection resets to the focused item whenever the focus changes.
  const [selection, setSelection] = useState<{ id: string | null; focus: string | null }>({ id: focus, focus });
  const selected = selection.focus === focus ? selection.id : focus;
  const setSelected = useCallback((id: string | null) => setSelection({ id, focus }), [focus]);
  const [centerOn, setCenterOn] = useState<{ id: string; nonce: number } | null>(null);
  const [resetNonce, setResetNonce] = useState(0);
  const { data: collections } = useCollections();

  const query = useQuery({
    queryKey: ["graph", { focus, depth, archived, collectionId }],
    queryFn: () =>
      api<GraphResponse>(
        `/api/graph${qs({
          focus,
          depth: focus ? depth : undefined,
          archived: archived || undefined,
          collectionId: focus ? undefined : collectionId || undefined,
        })}`,
      ),
    placeholderData: (prev) => prev,
  });

  const setParams = useCallback(
    (next: Record<string, string | null>) => {
      const p = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v === null) p.delete(k);
        else p.set(k, v);
      }
      const s = p.toString();
      router.push(s ? `${pathname}?${s}` : pathname);
    },
    [params, pathname, router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSelected]);

  const data = query.data;
  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    const nodes = data.nodes.filter((n) => types.has(n.type) || n.id === focus);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = data.edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target) && (e.type === "cites" ? showCitations : showKnowledge),
    );
    return { nodes, edges };
  }, [data, types, showCitations, showKnowledge, focus]);
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // "Color by collection": papers take their (first) collection's color, a second collection shows as a
  // ring; papers in no collection, concepts and notes are grey.
  const legendCollections = useMemo(
    () => (data?.collections ?? []).map((c) => ({ ...c, swatch: collectionColor(c) })),
    [data],
  );
  const shownNodes = useMemo(() => {
    if (colorBy !== "collection") return nodes;
    const colorOf = new Map(legendCollections.map((c) => [c.id, c.swatch]));
    return nodes.map((n): GraphNode => {
      const [first, second] = (n.collectionIds ?? []).map((id) => colorOf.get(id)).filter(Boolean) as string[];
      return { ...n, color: first ?? "dim", ring: second };
    });
  }, [nodes, colorBy, legendCollections]);
  const selectedNode = selected ? (nodeMap.get(selected) ?? null) : null;
  const focusNode = focus ? data?.nodes.find((n) => n.id === focus) : null;

  const pick = (n: GraphNode) => {
    setSelected(n.id);
    setCenterOn({ id: n.id, nonce: Date.now() });
  };

  const toggleType = (t: GraphNodeType) =>
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  /** Back to the default view: all filters on, nothing selected, fresh layout and camera. */
  const reset = () => {
    setTypes(new Set(["paper", "concept", "note"]));
    setShowCitations(true);
    setShowKnowledge(true);
    setArchived(false);
    setCollectionId("");
    setSelected(null);
    setResetNonce((n) => n + 1);
  };

  const workspaceEmpty = !focus && !collectionId && !archived && data && data.nodes.length === 0;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-bg px-4 py-2.5 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-[15px] font-semibold whitespace-nowrap">{focus ? "Focused graph" : "Knowledge graph"}</h1>
          {focus && (
            <span className="flex min-w-0 items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-[12.5px] text-accent-text">
              <span className="max-w-[16rem] truncate">{focusNode?.label ?? "…"}</span>
              <button
                type="button"
                onClick={() => setParams({ focus: null, depth: null })}
                aria-label="Show the whole workspace"
                className="rounded hover:bg-accent/10"
              >
                <X className="size-3.5" />
              </button>
            </span>
          )}
          {query.isFetching && <Spinner />}
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Show node types">
          {TYPES.map(({ type, label }) => {
            const Icon = NODE_ICON[type];
            return (
              <Toggle key={type} pressed={types.has(type)} onClick={() => toggleType(type)}>
                <Icon className="size-3.5" style={{ color: NODE_COLOR[type] }} aria-hidden />
                {label}
              </Toggle>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Show link types">
          <Toggle pressed={showCitations} onClick={() => setShowCitations((v) => !v)}>
            Citations
          </Toggle>
          <Toggle pressed={showKnowledge} onClick={() => setShowKnowledge((v) => !v)}>
            My links
          </Toggle>
        </div>
        {focus ? (
          <Select
            value={String(depth)}
            onChange={(e) => setParams({ depth: e.target.value })}
            aria-label="Neighborhood depth"
            className="h-8 w-auto text-[13px]"
          >
            <option value="1">1 step</option>
            <option value="2">2 steps</option>
            <option value="3">3 steps</option>
          </Select>
        ) : (
          <Select
            value={collectionId}
            onChange={(e) => setCollectionId(e.target.value)}
            aria-label="Limit to collection"
            className="h-8 w-auto max-w-44 text-[13px]"
          >
            <option value="">All papers</option>
            {collections?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <Select
          value={colorBy}
          onChange={(e) => setColorBy(e.target.value as "type" | "collection")}
          aria-label="Color nodes by"
          className="h-8 w-auto text-[13px]"
        >
          <option value="type">Color by type</option>
          <option value="collection">Color by collection</option>
        </Select>
        <label className="flex items-center gap-1.5 text-[13px] text-muted">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Archived
        </label>
        <div className="ml-auto flex items-center gap-2">
          <FindNode nodes={nodes} onPick={pick} />
          <Button size="sm" variant="ghost" onClick={reset} title="Reset filters, selection, layout and camera">
            <RotateCcw />
            Reset
          </Button>
          <ViewSwitcher view={view} onChange={setView} />
        </div>
      </div>

      {data?.truncated && (
        <p className="border-b border-border bg-warning-soft px-4 py-1.5 text-[12.5px] text-warning md:px-6">
          Your workspace is large, so only the most connected items are shown. Use a collection filter or focus on an
          item to see more.
        </p>
      )}

      <div className="relative flex min-h-0 flex-1">
        {query.isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner label="Building your graph…" />
          </div>
        ) : query.error ? (
          <div className="flex-1 p-6">
            <ErrorState title="The graph could not be loaded" error={query.error} onRetry={() => query.refetch()} />
          </div>
        ) : workspaceEmpty ? (
          <div className="flex-1 p-6">
            <EmptyState
              icon={Network}
              title="Your research graph is empty"
              description="Save papers or create concepts/notes to start building your research graph."
              action={
                <>
                  <Button asChild variant="primary">
                    <Link href="/search">Find papers</Link>
                  </Button>
                  <Button asChild variant="secondary">
                    <Link href="/notes">Write a note</Link>
                  </Button>
                </>
              }
            />
          </div>
        ) : nodes.length === 0 ? (
          <div className="flex-1 p-6">
            <EmptyState
              icon={Network}
              title={focus ? "Nothing connected yet" : "Nothing to show"}
              description={
                focus
                  ? "This item has no links yet. Mention it in a note or link it to a concept to connect it."
                  : "No items match the current filters."
              }
            />
          </div>
        ) : view === "list" ? (
          <div className="min-w-0 flex-1">
            <GraphListView nodes={nodes} edges={edges} />
          </div>
        ) : (
          <>
            <div className="relative min-w-0 flex-1">
              {view === "3d" ? (
                <GraphCanvas3D
                  nodes={shownNodes}
                  edges={edges}
                  selectedNodeId={selected}
                  onSelectNode={setSelected}
                  centerOn={centerOn}
                  resetNonce={resetNonce}
                  onUnsupported={() => setView("2d")}
                  ariaLabel={`3D knowledge graph with ${nodes.length} items and ${edges.length} links. Use the list view for a text version.`}
                />
              ) : (
                <GraphCanvas
                  nodes={shownNodes}
                  edges={edges}
                  mode="knowledge"
                  selectedNodeId={selected}
                  onSelectNode={setSelected}
                  centerOn={centerOn}
                  resetNonce={resetNonce}
                  ariaLabel={`Knowledge graph with ${nodes.length} items and ${edges.length} links. Use the list view for a text version.`}
                />
              )}
              {colorBy === "collection" ? (
                <CollectionLegend
                  collections={legendCollections}
                  showRing={shownNodes.some((n) => n.ring)}
                  className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-5rem)] rounded-lg border border-border bg-surface/90 px-2.5 py-1.5"
                />
              ) : (
                <KnowledgeLegend className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-5rem)] rounded-lg border border-border bg-surface/90 px-2.5 py-1.5" />
              )}
            </div>
            {selectedNode && (
              <div className="absolute inset-x-0 bottom-0 z-10 h-[55%] shadow-2xl md:static md:h-auto md:w-80 md:shrink-0 md:shadow-none">
                <GraphInspector
                  node={selectedNode}
                  nodes={nodeMap}
                  edges={edges}
                  onSelect={(id) => pick(nodeMap.get(id)!)}
                  onFocus={(n) => setParams({ focus: n.id, depth: String(depth) })}
                  onClose={() => setSelected(null)}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
