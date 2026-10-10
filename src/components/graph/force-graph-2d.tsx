"use client";

import ForceGraph, { type LinkObject, type NodeObject } from "force-graph";
import { Maximize, Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useRef } from "react";
import { forceCollide, forceX, forceY } from "d3-force-3d";
import { Button } from "@/components/ui/button";
import type { GraphEdge, GraphNode } from "@/lib/types";
import {
  edgeLook,
  nodeFill,
  nodeRing,
  nodeSize,
  readTokens,
  truncateLabel,
  type GraphMode,
  type Position,
} from "./graph-style";

/**
 * The 2D graph, modelled on Obsidian's graph view: a live force simulation (the graph unfolds from the
 * middle, settles, and follows when you drag a node — neighbors are pulled along by their links),
 * labels that fade in as you zoom closer, and hover / selection emphasis that eases in and out.
 * Drawn on a canvas by force-graph (d3-force + d3-zoom), the 2D sibling of the 3D view's library.
 */

export interface GraphView2DProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mode?: GraphMode;
  /** "preset": `positions` give each node's horizontal place (citation lineage: earlier ← → later). */
  layout?: "force" | "preset";
  positions?: Record<string, Position>;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  onSelectNode?: (id: string | null) => void;
  onSelectEdge?: (id: string | null) => void;
  /** Change the nonce to center the view on a node. */
  centerOn?: { id: string; nonce: number } | null;
  /** Change to re-run the layout and refit (e.g. from a toolbar "Reset" button). */
  resetNonce?: number;
  ariaLabel: string;
}

type Node2D = NodeObject & {
  id: string;
  data: GraphNode;
  r: number;
  degree: number;
  /** Eased display state: opacity and hover scale move toward their targets every frame. */
  alpha: number;
  alphaTo: number;
  scale: number;
  scaleTo: number;
  emphasized: boolean;
};
type Link2D = LinkObject<Node2D> & { id: string; type: GraphEdge["type"]; alpha: number; alphaTo: number };
type Tokens = ReturnType<typeof readTokens>;

const EASE = 0.2;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ends = (l: Link2D) => [l.source, l.target].map((e) => (typeof e === "object" ? (e as Node2D).id : String(e)));

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The node's outline in graph coordinates (circle, diamond, rounded square). */
function shapePath(ctx: CanvasRenderingContext2D, type: GraphNode["type"], x: number, y: number, r: number) {
  ctx.beginPath();
  if (type === "concept") {
    const d = r * 1.25;
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
  } else if (type === "note") {
    const s = r * 0.9;
    ctx.roundRect(x - s, y - s, s * 2, s * 2, s * 0.35);
  } else {
    ctx.arc(x, y, r, 0, 2 * Math.PI);
  }
}

export function ForceGraph2DView({
  nodes,
  edges,
  mode = "knowledge",
  layout = "force",
  positions,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  centerOn,
  resetNonce = 0,
  ariaLabel,
}: GraphView2DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph<Node2D, Link2D> | null>(null);
  const nodeCache = useRef(new Map<string, Node2D>());
  const linkCache = useRef(new Map<string, Link2D>());
  const tokens = useRef<Tokens | null>(null);
  const hovered = useRef<string | null>(null);
  const selection = useRef<{ node: string | null; edge: string | null }>({ node: null, edge: null });
  const userMoved = useRef(false);
  const callbacks = useRef({ onSelectNode, onSelectEdge });
  useEffect(() => {
    callbacks.current = { onSelectNode, onSelectEdge };
  });

  /** Recomputes every node's and link's target opacity from the hover and the selection. */
  const retarget = () => {
    const graph = graphRef.current;
    if (!graph) return;
    const sel = selection.current;
    const focus = sel.node ?? hovered.current;
    const hood = new Set<string>();
    const lit = new Set<string>();
    if (focus) {
      hood.add(focus);
      for (const l of linkCache.current.values()) {
        const [a, b] = ends(l);
        if (a === focus || b === focus) {
          hood.add(a).add(b);
          lit.add(l.id);
        }
      }
    } else if (sel.edge) {
      const l = linkCache.current.get(sel.edge);
      if (l) {
        ends(l).forEach((id) => hood.add(id));
        lit.add(l.id);
      }
    }
    const active = hood.size > 0;
    // A selection dims the rest more strongly than a passing hover.
    const dim = sel.node || sel.edge ? 0.12 : 0.22;
    for (const n of nodeCache.current.values()) {
      n.emphasized = active && hood.has(n.id);
      n.alphaTo = !active || hood.has(n.id) ? 1 : dim;
      n.scaleTo = n.id === hovered.current ? 1.25 : 1;
    }
    for (const l of linkCache.current.values()) l.alphaTo = !active ? 0.42 : lit.has(l.id) ? 1 : dim * 0.5;
    if (reducedMotion()) {
      for (const n of nodeCache.current.values()) {
        n.alpha = n.alphaTo;
        n.scale = n.scaleTo;
      }
      for (const l of linkCache.current.values()) l.alpha = l.alphaTo;
    }
    // Keep drawing until the transitions finish (force-graph otherwise pauses when the layout is still).
    graph.autoPauseRedraw(false);
  };

  // Create / destroy the instance.
  useEffect(() => {
    const container = containerRef.current!;
    tokens.current = readTokens();
    const graph = new ForceGraph<Node2D, Link2D>(container);
    graphRef.current = graph;
    const cache = nodeCache.current;
    const links = linkCache.current;

    graph
      .width(container.clientWidth)
      .height(container.clientHeight)
      .backgroundColor("rgba(0,0,0,0)")
      .nodeId("id")
      .minZoom(0.08)
      .maxZoom(8)
      .nodeRelSize(1)
      .nodeVal((n) => n.r * n.r)
      .nodeLabel((n) => {
        const sub = n.data.sublabel
          ? `<div style="opacity:.75;font-size:11px">${escapeHtml(n.data.sublabel)}</div>`
          : "";
        return `<div style="max-width:280px;font:12px/1.35 ui-sans-serif,system-ui">${escapeHtml(n.data.label)}${sub}</div>`;
      })
      .nodeCanvasObject((n, ctx, scale) => {
        const t = tokens.current!;
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        const r = n.r * n.scale;
        ctx.save();
        ctx.globalAlpha = n.alpha;
        // Soft halo behind the hovered node.
        if (n.scale > 1.01) {
          ctx.globalAlpha = n.alpha * (n.scale - 1) * 1.2;
          ctx.fillStyle = t.accent;
          shapePath(ctx, n.data.type, x, y, r + 5 / Math.sqrt(scale));
          ctx.fill();
          ctx.globalAlpha = n.alpha;
        }
        shapePath(ctx, n.data.type, x, y, r);
        ctx.fillStyle = nodeFill(n.data, t);
        ctx.fill();
        const ring = n.id === selection.current.node ? t.accent : nodeRing(n.data, t);
        if (ring) {
          ctx.lineWidth = (n.id === selection.current.node ? 2.5 : 1.8) / Math.sqrt(scale);
          ctx.strokeStyle = ring;
          ctx.stroke();
        }
        // Labels fade in as you zoom closer (bigger nodes first); hovered, selected and their
        // neighbors are always labelled.
        const showAt = 2.1 - Math.min(1.2, n.r / 9);
        const zoomAlpha = Math.min(1, Math.max(0, (scale - showAt) / 0.5));
        const labelAlpha = n.emphasized || n.data.role === "center" ? 1 : zoomAlpha;
        if (labelAlpha > 0.02) {
          const size = 11 / scale;
          ctx.font = `${n.emphasized ? 600 : 400} ${size}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          const text = truncateLabel(n.data.label, 40);
          const ty = y + r + 3 / scale;
          ctx.globalAlpha = n.alpha * labelAlpha;
          ctx.lineWidth = 3 / scale;
          ctx.strokeStyle = t.bg;
          ctx.lineJoin = "round";
          ctx.strokeText(text, x, ty);
          ctx.fillStyle = t.text;
          ctx.fillText(text, x, ty);
        }
        ctx.restore();
      })
      .nodePointerAreaPaint((n, color, ctx) => {
        ctx.fillStyle = color;
        shapePath(ctx, n.data.type, n.x ?? 0, n.y ?? 0, n.r + 2);
        ctx.fill();
      })
      .linkCanvasObjectMode(() => "replace")
      .linkCanvasObject((l, ctx, scale) => {
        const s = l.source as Node2D;
        const e = l.target as Node2D;
        if (s.x === undefined || e.x === undefined) return;
        const t = tokens.current!;
        const look = edgeLook(l.type, t);
        const selected = l.id === selection.current.edge;
        const dx = e.x - s.x;
        const dy = (e.y ?? 0) - (s.y ?? 0);
        const len = Math.hypot(dx, dy) || 1;
        // Stop at the target's edge, so arrows touch the node instead of hiding under it.
        const end = look.arrow ? (e.r * e.scale + 1.5) / len : 0;
        const tx = e.x - dx * end;
        const ty = (e.y ?? 0) - dy * end;
        ctx.save();
        ctx.globalAlpha = Math.min(s.alpha, e.alpha, 1) * l.alpha + (selected ? 0.4 : 0);
        ctx.strokeStyle = selected || l.alpha > 0.9 ? t.accent : look.color;
        ctx.lineWidth = (selected ? 2.4 : look.width) / Math.sqrt(scale);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y ?? 0);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        if (look.arrow) {
          const a = Math.atan2(dy, dx);
          const size = 5 / Math.sqrt(scale);
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - size * Math.cos(a - 0.45), ty - size * Math.sin(a - 0.45));
          ctx.lineTo(tx - size * Math.cos(a + 0.45), ty - size * Math.sin(a + 0.45));
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      })
      .linkWidth(4) // the clickable width around a link
      .onRenderFramePre(() => {
        // Ease every opacity and hover scale toward its target.
        let moving = false;
        for (const n of cache.values()) {
          if (Math.abs(n.alphaTo - n.alpha) > 0.005 || Math.abs(n.scaleTo - n.scale) > 0.005) {
            n.alpha += (n.alphaTo - n.alpha) * EASE;
            n.scale += (n.scaleTo - n.scale) * EASE;
            moving = true;
          }
        }
        for (const l of links.values()) {
          if (Math.abs(l.alphaTo - l.alpha) > 0.005) {
            l.alpha += (l.alphaTo - l.alpha) * EASE;
            moving = true;
          }
        }
        if (!moving) graph.autoPauseRedraw(true);
      })
      .onNodeHover((n) => {
        hovered.current = n?.id ?? null;
        container.style.cursor = n ? "pointer" : "";
        retarget();
      })
      .onNodeClick((n) => callbacks.current.onSelectNode?.(n.id))
      .onLinkClick((l) => callbacks.current.onSelectEdge?.(l.id))
      .onBackgroundClick(() => {
        callbacks.current.onSelectNode?.(null);
        callbacks.current.onSelectEdge?.(null);
      })
      .onEngineStop(() => {
        // Once settled, re-frame only if part of the graph ended up outside the view.
        if (userMoved.current || !cache.size) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        const outside = [...cache.values()].some((n) => {
          const p = graph.graph2ScreenCoords(n.x ?? 0, n.y ?? 0);
          return p.x < 10 || p.y < 10 || p.x > w - 10 || p.y > h - 10;
        });
        if (outside) graph.zoomToFit(800, 40);
      })
      .onNodeDrag(() => {
        userMoved.current = true;
      })
      .onZoom(() => {
        // Programmatic zooms (fit, center) also fire this; only user gestures count, and those
        // happen while the pointer is over the canvas.
        if (container.matches(":hover")) userMoved.current = true;
      })
      // The graph unfolds from the middle: no precomputed layout, a few seconds of settling.
      .warmupTicks(reducedMotion() ? 300 : 0)
      .cooldownTime(6000)
      .d3VelocityDecay(0.35);

    // Forces, tuned for Obsidian-like spacing: nodes push apart, links pull related items together,
    // and a gentle pull to the middle keeps unconnected items from drifting away.
    graph
      .d3Force("charge")
      ?.strength?.((n: Node2D) => -110 - n.r * 9)
      .distanceMax?.(700);
    graph
      .d3Force("link")
      ?.distance?.((l: Link2D) => (l.type === "cites" ? 80 : l.type === "note_about_paper" ? 38 : 60));
    graph.d3Force("collide", forceCollide((n: Node2D) => n.r + 8) as never);
    graph.d3Force("x", forceX(0).strength(0.025) as never);
    graph.d3Force("y", forceY(0).strength(0.025) as never);

    const resize = new ResizeObserver(() => graph.width(container.clientWidth).height(container.clientHeight));
    resize.observe(container);
    const theme = new MutationObserver(() => {
      tokens.current = readTokens();
      graph.autoPauseRedraw(false);
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      resize.disconnect();
      theme.disconnect();
      graph._destructor();
      graphRef.current = null;
      cache.clear();
      links.clear();
    };
  }, []);

  // Sync data, reusing node/link objects so the simulation continues from current positions.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const ids = new Set(nodes.map((n) => n.id));
    const first = nodeCache.current.size === 0;
    const nextNodes: Node2D[] = [];
    for (const n of nodes) {
      const r = Math.max(3, nodeSize(n, degree.get(n.id) ?? 0) / 4.5);
      const preset = layout === "preset" ? positions?.[n.id] : undefined;
      let node = nodeCache.current.get(n.id);
      if (node) {
        node.data = n;
        node.r = r;
        node.degree = degree.get(n.id) ?? 0;
      } else {
        // New nodes start next to a node they link to, so expansions grow out of their parent.
        const neighbor = edges
          .filter((e) => e.source === n.id || e.target === n.id)
          .map((e) => nodeCache.current.get(e.source === n.id ? e.target : e.source))
          .find((x) => x?.x !== undefined);
        node = {
          id: n.id,
          data: n,
          r,
          degree: degree.get(n.id) ?? 0,
          alpha: 0, // fades in
          alphaTo: 1,
          scale: 1,
          scaleTo: 1,
          emphasized: false,
          ...(neighbor
            ? { x: neighbor.x! + (Math.random() - 0.5) * 20, y: neighbor.y! + (Math.random() - 0.5) * 20 }
            : {}),
        };
        nodeCache.current.set(n.id, node);
      }
      // Citation lineage: the horizontal place is fixed (earlier ← → later), the rest is physics.
      if (preset) {
        node.fx = preset.x;
        if (node.y === undefined) node.y = preset.y;
      } else if (layout === "preset") {
        node.fx = undefined;
      }
      nextNodes.push(node);
    }
    for (const id of [...nodeCache.current.keys()]) if (!ids.has(id)) nodeCache.current.delete(id);
    const nextLinks: Link2D[] = [];
    for (const e of edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) continue;
      let link = linkCache.current.get(e.id);
      if (!link) {
        link = { id: e.id, type: e.type, source: e.source, target: e.target, alpha: 0, alphaTo: 0.42 };
        linkCache.current.set(e.id, link);
      }
      nextLinks.push(link);
    }
    for (const id of [...linkCache.current.keys()])
      if (!nextLinks.some((l) => l.id === id)) linkCache.current.delete(id);
    graph.graphData({ nodes: nextNodes, links: nextLinks });
    retarget();
    if (first && nextNodes.length) {
      userMoved.current = false;
      // Start close in (the graph unfolds outward), then frame it once it has mostly settled.
      graph.zoom(Math.min(3, Math.max(0.6, 9 / Math.sqrt(nextNodes.length + 4))), 0);
      graph.centerAt(0, 0, 0);
      setTimeout(
        () => {
          if (!userMoved.current) graphRef.current?.zoomToFit(900, 40);
        },
        reducedMotion() ? 0 : 1300,
      );
    }
  }, [nodes, edges, layout, positions]);

  // Selection emphasis.
  useEffect(() => {
    selection.current = { node: selectedNodeId ?? null, edge: selectedEdgeId ?? null };
    retarget();
  }, [selectedNodeId, selectedEdgeId, nodes, edges]);

  // Glide to a node on request.
  useEffect(() => {
    const graph = graphRef.current;
    const node = centerOn ? nodeCache.current.get(centerOn.id) : null;
    if (!graph || !node || node.x === undefined) return;
    graph.centerAt(node.x, node.y, 600);
    graph.zoom(Math.max(graph.zoom(), 2), 600);
  }, [centerOn]);

  /** Shakes the layout loose: positions are forgotten and the graph unfolds again. */
  const resetLayout = () => {
    const graph = graphRef.current;
    if (!graph) return;
    for (const n of nodeCache.current.values()) {
      n.x = n.y = undefined;
      n.vx = n.vy = undefined;
      if (layout !== "preset") n.fx = n.fy = undefined;
      else n.fy = undefined;
    }
    userMoved.current = false;
    const { nodes: current, links } = graph.graphData();
    graph.graphData({ nodes: current, links });
    graph.centerAt(0, 0, 400);
    setTimeout(() => graphRef.current?.zoomToFit(900, 40), reducedMotion() ? 0 : 1300);
  };

  const lastReset = useRef(resetNonce);
  useEffect(() => {
    if (lastReset.current === resetNonce) return;
    lastReset.current = resetNonce;
    resetLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetLayout reads refs only
  }, [resetNonce]);

  const zoomBy = (factor: number) => {
    const graph = graphRef.current;
    if (graph) graph.zoom(graph.zoom() * factor, 260);
  };

  return (
    <div className="relative h-full w-full" data-graph-mode={mode}>
      <div ref={containerRef} className="h-full w-full" role="img" aria-label={ariaLabel} />
      <div className="absolute right-3 bottom-3 flex flex-col gap-1 rounded-lg border border-border bg-surface/95 p-1 shadow-sm">
        <Button variant="ghost" size="icon-sm" onClick={() => zoomBy(1.3)} aria-label="Zoom in">
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out">
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => graphRef.current?.zoomToFit(600, 40)}
          aria-label="Fit graph to view"
        >
          <Maximize />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={resetLayout}
          aria-label="Reset view"
          title="Reset view: re-run the layout and recenter"
        >
          <RotateCcw />
        </Button>
      </div>
    </div>
  );
}
