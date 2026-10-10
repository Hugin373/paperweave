"use client";

import ForceGraph3D, { type ForceGraph3DInstance, type LinkObject, type NodeObject } from "3d-force-graph";
import { Maximize, Minus, Pause, Play, Plus, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { forceX, forceY, forceZ } from "d3-force-3d";
import SpriteText from "three-spritetext";
import {
  BackSide,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from "three";
import { Button } from "@/components/ui/button";
import type { GraphEdge, GraphNode } from "@/lib/types";
import { edgeLook, nodeFill, nodeRing, nodeSize, readTokens, truncateLabel } from "./graph-style";

type Node3D = NodeObject & {
  id: string;
  data: GraphNode;
  radius: number;
  degree: number;
  mesh?: Mesh;
  /** Outline shell, shown like the 2D border (second collection, or in-library in citation graphs). */
  ring?: Mesh;
  label?: SpriteText;
  /** Eased display state (as in the 2D view): opacity and hover scale move toward their targets. */
  alpha: number;
  alphaTo: number;
  scale: number;
  scaleTo: number;
  emphasized: boolean;
};
type Link3D = LinkObject<Node3D> & {
  id: string;
  type: GraphEdge["type"];
  alpha: number;
  alphaTo: number;
  color: string;
  /** The line and arrow objects three-forcegraph creates for the link. */
  __lineObj?: Mesh;
  __arrowObj?: Mesh;
};
type Instance = ForceGraph3DInstance<Node3D, Link3D>;
/** The subset of three.js OrbitControls settings used here. */
type OrbitLike = {
  zoomToCursor?: boolean;
  zoomSpeed?: number;
  rotateSpeed?: number;
  panSpeed?: number;
  enableDamping?: boolean;
  dampingFactor?: number;
  autoRotate?: boolean;
  autoRotateSpeed?: number;
  target?: { x: number; y: number; z: number };
  addEventListener?: (type: string, listener: () => void) => void;
};

export interface ForceGraph3DProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  onSelectNode?: (id: string | null) => void;
  onSelectEdge?: (id: string | null) => void;
  /** Change `nonce` to fly the camera to node `id`. */
  centerOn?: { id: string; nonce: number } | null;
  /** Pins nodes to an x coordinate (the citation explorer keeps time on the x axis). */
  fixedX?: Record<string, number>;
  /** Smaller labels and controls, for embedded panels. */
  compact?: boolean;
  ariaLabel: string;
  /** Called when WebGL is unavailable so the caller can fall back to 2D. */
  onUnsupported?: () => void;
  /** Change to reset the layout and camera (e.g. from a toolbar "Reset" button). */
  resetNonce?: number;
}

const geometries: Record<GraphNode["type"], BufferGeometry> = {
  paper: new SphereGeometry(1, 20, 14),
  concept: new OctahedronGeometry(1.25),
  note: new BoxGeometry(1.5, 1.5, 1.5),
};

const EASE = 0.18;
/** Labels appear when the camera comes closer than this (bigger nodes from further away). */
const LABEL_NEAR = 300;
const LABEL_FADE = 120;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function degreeMap(edges: GraphEdge[]) {
  const d = new Map<string, number>();
  for (const e of edges) {
    d.set(e.source, (d.get(e.source) ?? 0) + 1);
    d.set(e.target, (d.get(e.target) ?? 0) + 1);
  }
  return d;
}

function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * 3D force-directed graph (three.js), behaving like the 2D view (and Obsidian's graph): the graph
 * unfolds live from the middle, dragged nodes pull their neighbors along, labels fade in as the
 * camera comes closer, and hover / selection emphasis eases in and out. Node objects are kept between
 * updates so positions stay stable; emphasis only changes materials, never rebuilds objects.
 */
export function ForceGraph3DView({
  nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  centerOn,
  fixedX,
  compact,
  ariaLabel,
  onUnsupported,
  resetNonce = 0,
}: ForceGraph3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Instance | null>(null);
  const nodeCache = useRef(new Map<string, Node3D>());
  const linkCache = useRef(new Map<string, Link3D>());
  /** Set once the user rotates/zooms/pans/drags: automatic fitting must not move the camera after that. */
  const userMoved = useRef(false);
  const tokens = useRef<ReturnType<typeof readTokens> | null>(null);
  const hovered = useRef<string | null>(null);
  const selection = useRef<{ node: string | null; edge: string | null }>({ node: null, edge: null });
  const callbacks = useRef({ onSelectNode, onSelectEdge });
  // Auto-rotation; a reset (new nonce) turns it off without an effect.
  const [rotation, setRotation] = useState({ on: false, nonce: resetNonce });
  const rotating = rotation.on && rotation.nonce === resetNonce;
  const setRotating = (on: boolean) => setRotation({ on, nonce: resetNonce });
  // Rendered client-side only (see graph-canvas.tsx), so the DOM is available here.
  const [supported, setSupported] = useState(webglAvailable);
  useEffect(() => {
    callbacks.current = { onSelectNode, onSelectEdge };
  });

  const ends = (l: Link3D) => [l.source, l.target].map((e) => (typeof e === "object" ? (e as Node3D).id : String(e)));

  /** Target opacity, scale and color for every node and link, from the hover and the selection. */
  const retarget = () => {
    const t = (tokens.current ??= readTokens());
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
    const dim = sel.node || sel.edge ? 0.12 : 0.22;
    for (const n of nodeCache.current.values()) {
      n.emphasized = active && hood.has(n.id);
      n.alphaTo = !active || hood.has(n.id) ? 1 : dim;
      n.scaleTo = n.id === hovered.current ? 1.25 : 1;
    }
    for (const l of linkCache.current.values()) {
      l.alphaTo = !active ? 0.5 : lit.has(l.id) ? 1 : dim * 0.5;
      l.color = lit.has(l.id) ? t.accent : edgeLook(l.type, t).color;
    }
    if (prefersReducedMotion()) {
      for (const n of nodeCache.current.values()) {
        n.alpha = n.alphaTo;
        n.scale = n.scaleTo;
      }
      for (const l of linkCache.current.values()) l.alpha = l.alphaTo;
    }
  };

  /** Colors that only change with the theme or the data (fill, outline, label colors). */
  const paintStatic = (n: Node3D) => {
    const t = (tokens.current ??= readTokens());
    if (n.mesh) {
      const mat = n.mesh.material as MeshLambertMaterial;
      mat.color.set(nodeFill(n.data, t));
      mat.emissive.set(n.id === selection.current.node ? t.accent : "#000000");
      mat.emissiveIntensity = n.id === selection.current.node ? 0.45 : 0;
    }
    if (n.ring) {
      const ring = n.id === selection.current.node ? t.accent : nodeRing(n.data, t);
      n.ring.visible = !!ring;
      if (ring) (n.ring.material as MeshBasicMaterial).color.set(ring);
    }
    if (n.label) {
      n.label.color = t.text;
      n.label.backgroundColor = `${t.bg}d9`;
    }
  };

  // Create / destroy the renderer.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!supported) {
      onUnsupported?.();
      return;
    }
    const cache = nodeCache.current;
    const links = linkCache.current;
    let graph: Instance;
    try {
      graph = new ForceGraph3D(container, { controlType: "orbit" }) as unknown as Instance;
    } catch {
      queueMicrotask(() => setSupported(false));
      onUnsupported?.();
      return;
    }
    graphRef.current = graph;
    // Very high-density screens: 2x looks the same but renders far fewer pixels per frame.
    graph.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    graph
      .backgroundColor("rgba(0,0,0,0)")
      .showNavInfo(false)
      .width(container.clientWidth)
      .height(container.clientHeight)
      .nodeId("id")
      .nodeLabel((n) => {
        const sub = n.data.sublabel
          ? `<div style="opacity:.75;font-size:11px">${escapeHtml(n.data.sublabel)}</div>`
          : "";
        return `<div style="max-width:280px;font:12px/1.35 ui-sans-serif,system-ui">${escapeHtml(n.data.label)}${sub}</div>`;
      })
      .nodeThreeObject((n) => {
        const group = new Group();
        const mesh = new Mesh(geometries[n.data.type], new MeshLambertMaterial({ transparent: true, opacity: 0.95 }));
        mesh.scale.setScalar(n.radius);
        group.add(mesh);
        n.mesh = mesh;
        if (n.data.type === "paper") {
          // A slightly larger back-facing sphere reads as an outline around the node from any angle.
          const ring = new Mesh(geometries.paper, new MeshBasicMaterial({ side: BackSide, transparent: true }));
          ring.scale.setScalar(n.radius * 1.22);
          ring.raycast = () => {}; // only the node itself responds to the pointer
          group.add(ring);
          n.ring = ring;
        }
        const label = new SpriteText(truncateLabel(n.data.label, compact ? 30 : 42), compact ? 3.6 : 4.4);
        label.padding = 1;
        label.borderRadius = 2;
        label.fontFace = "ui-sans-serif, system-ui, sans-serif";
        // Anchor the label below the shape in screen space, so it never overlaps the shape
        // regardless of the camera angle (a world-space offset would swing over it).
        label.center.set(0.5, 1 + (n.radius * 1.15) / label.scale.y);
        label.material.depthWrite = false;
        label.raycast = () => {};
        label.renderOrder = 10;
        group.add(label);
        n.label = label;
        // Objects are created lazily by the renderer, so style them as they appear.
        paintStatic(n);
        return group;
      })
      // Link colors and opacities are eased per frame on the line materials (see the frame loop).
      .linkColor((l) => edgeLook(l.type, (tokens.current ??= readTokens())).color)
      .linkOpacity(1)
      .linkWidth(0)
      .linkDirectionalArrowLength((l) => (l.type === "cites" ? 3.2 : 0))
      .linkDirectionalArrowRelPos(1)
      .linkHoverPrecision(4)
      // Dragging a node pulls its neighbors along; it is released (not pinned) when dropped.
      .enableNodeDrag(true)
      .onNodeDrag(() => {
        userMoved.current = true;
      })
      .onNodeClick((n) => callbacks.current.onSelectNode?.(n.id))
      // Hover: the node swells, it and its neighbors stay bright, the rest fades.
      .onNodeHover((n) => {
        hovered.current = (n as Node3D | null)?.id ?? null;
        container.style.cursor = n ? "pointer" : "";
        retarget();
      })
      .onLinkClick((l) => callbacks.current.onSelectEdge?.(l.id))
      .onBackgroundClick(() => {
        callbacks.current.onSelectNode?.(null);
        callbacks.current.onSelectEdge?.(null);
      })
      // The graph unfolds from the middle (no precomputed layout) and settles over a few seconds.
      .warmupTicks(prefersReducedMotion() ? 300 : 0)
      .cooldownTime(6000)
      .d3VelocityDecay(0.35)
      .onEngineStop(() => {
        // Once settled, re-frame only if part of the graph ended up outside the view.
        if (userMoved.current || !cache.size) return;
        const camera = graph.camera();
        const outside = [...cache.values()].some((n) => {
          const p = new Vector3(n.x ?? 0, n.y ?? 0, n.z ?? 0).project(camera);
          return Math.abs(p.x) > 0.96 || Math.abs(p.y) > 0.96;
        });
        if (outside) graph.zoomToFit(800, compact ? 10 : 40);
      });
    graph.d3Force("charge")?.strength?.((n: Node3D) => -100 - n.radius * 8);

    // Camera feel: zoom toward the cursor, a usable zoom step for mouse wheels and trackpads,
    // and gentle damping so movement eases out instead of stopping abruptly.
    const controls = graph.controls() as OrbitLike;
    controls.zoomToCursor = true;
    controls.zoomSpeed = 2.4;
    controls.rotateSpeed = 0.7;
    controls.panSpeed = 0.9;
    controls.enableDamping = true;
    controls.dampingFactor = 0.14;
    controls.addEventListener?.("start", () => {
      userMoved.current = true;
    });
    // When a node drag ends, 3d-force-graph sends a synthetic "pointerup" (no real pointer id) so the
    // camera controls let go. OrbitControls then looks up that unknown pointer and crashes. Hand it
    // the pointers it is actually tracking instead.
    const orbit = controls as unknown as {
      _pointers?: number[];
      _onPointerUp?: (e: { pointerId: number; isTrusted?: boolean }) => void;
    };
    const pointerUp = orbit._onPointerUp;
    if (pointerUp) {
      orbit._onPointerUp = function (e) {
        if (e.isTrusted !== false) return pointerUp.call(this, e);
        for (const id of [...(orbit._pointers ?? [])]) pointerUp.call(this, { pointerId: id });
      };
    }

    // Every frame: ease opacities, hover scale and link colors toward their targets, and fade labels
    // in as the camera comes closer (hovered, selected and their neighbors are always labelled).
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const camera = graph.camera();
      for (const n of cache.values()) {
        n.alpha += (n.alphaTo - n.alpha) * EASE;
        n.scale += (n.scaleTo - n.scale) * EASE;
        const group = n.mesh?.parent;
        if (!group) continue;
        group.scale.setScalar(n.scale);
        (n.mesh!.material as MeshLambertMaterial).opacity = 0.95 * n.alpha;
        if (n.ring) (n.ring.material as MeshBasicMaterial).opacity = n.alpha;
        if (n.label) {
          const near = LABEL_NEAR + n.radius * 22;
          const d = camera.position.distanceTo(group.position);
          const byDistance = Math.min(1, Math.max(0, (near - d) / LABEL_FADE));
          const shown = (n.emphasized || n.data.role === "center" ? 1 : byDistance) * n.alpha;
          n.label.visible = shown > 0.02;
          n.label.material.opacity = shown;
        }
      }
      for (const l of links.values()) {
        l.alpha += (l.alphaTo - l.alpha) * EASE;
        for (const obj of [l.__lineObj, l.__arrowObj]) {
          const mat = obj?.material as (MeshBasicMaterial & { opacity: number }) | undefined;
          if (!mat) continue;
          mat.transparent = true;
          mat.opacity = l.alpha;
          if (l.color) mat.color.set(l.color);
        }
      }
    };
    frame = requestAnimationFrame(tick);
    // A gentle pull toward the center keeps unconnected items from drifting far away.
    graph.d3Force("x", forceX(0).strength(0.04) as never);
    graph.d3Force("y", forceY(0).strength(0.04) as never);
    graph.d3Force("z", forceZ(0).strength(0.04) as never);

    const resize = new ResizeObserver(() => graph.width(container.clientWidth).height(container.clientHeight));
    resize.observe(container);
    const theme = new MutationObserver(() => {
      tokens.current = readTokens();
      for (const n of cache.values()) paintStatic(n);
      retarget();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
      graph._destructor();
      graph.renderer().dispose();
      graphRef.current = null;
      cache.clear();
      links.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once; callbacks are read from refs
  }, []);

  // Sync data, reusing node/link objects so the simulation continues from current positions.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const degree = degreeMap(edges);
    const ids = new Set(nodes.map((n) => n.id));
    const nextNodes: Node3D[] = [];
    for (const n of nodes) {
      const existing = nodeCache.current.get(n.id);
      const radius = nodeSize(n, degree.get(n.id) ?? 0) / 5;
      if (existing) {
        existing.data = n;
        existing.degree = degree.get(n.id) ?? 0;
        if (existing.mesh && existing.radius !== radius) existing.mesh.scale.setScalar(radius);
        existing.radius = radius;
        existing.fx = fixedX?.[n.id];
        paintStatic(existing);
        nextNodes.push(existing);
      } else {
        // New nodes fade in next to a node they link to, so expansions grow out of their parent.
        const neighbor = edges
          .filter((e) => e.source === n.id || e.target === n.id)
          .map((e) => nodeCache.current.get(e.source === n.id ? e.target : e.source))
          .find((x) => x?.x !== undefined);
        const jitter = () => (Math.random() - 0.5) * 20;
        const node: Node3D = {
          id: n.id,
          data: n,
          radius,
          degree: degree.get(n.id) ?? 0,
          fx: fixedX?.[n.id],
          alpha: 0,
          alphaTo: 1,
          scale: 1,
          scaleTo: 1,
          emphasized: false,
          ...(neighbor
            ? { x: neighbor.x! + jitter(), y: (neighbor.y ?? 0) + jitter(), z: (neighbor.z ?? 0) + jitter() }
            : {}),
        };
        nodeCache.current.set(n.id, node);
        nextNodes.push(node);
      }
    }
    for (const id of [...nodeCache.current.keys()]) if (!ids.has(id)) nodeCache.current.delete(id);
    const nextLinks: Link3D[] = [];
    for (const e of edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) continue;
      let link = linkCache.current.get(e.id);
      if (!link) {
        link = { id: e.id, type: e.type, source: e.source, target: e.target, alpha: 0, alphaTo: 0.5, color: "" };
        linkCache.current.set(e.id, link);
      }
      nextLinks.push(link);
    }
    for (const id of [...linkCache.current.keys()]) {
      if (!nextLinks.some((l) => l.id === id)) linkCache.current.delete(id);
    }
    const first = !graph.graphData().nodes.length;
    graph.graphData({ nodes: nextNodes, links: nextLinks });
    retarget();
    if (first && nextNodes.length && !userMoved.current) {
      // Start close in (the graph unfolds outward), then frame it once it has mostly settled.
      graph.cameraPosition({ x: 0, y: 0, z: 160 + Math.sqrt(nextNodes.length) * 48 }, { x: 0, y: 0, z: 0 }, 0);
      setTimeout(
        () => {
          if (!userMoved.current) graphRef.current?.zoomToFit(900, compact ? 10 : 40);
        },
        prefersReducedMotion() ? 0 : 1300,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retarget and paintStatic read refs only
  }, [nodes, edges, fixedX]);

  // Selection emphasis.
  useEffect(() => {
    selection.current = { node: selectedNodeId ?? null, edge: selectedEdgeId ?? null };
    for (const n of nodeCache.current.values()) paintStatic(n);
    retarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retarget and paintStatic read refs only
  }, [selectedNodeId, selectedEdgeId, edges]);

  // Fly to a node on request.
  useEffect(() => {
    const graph = graphRef.current;
    const node = centerOn ? nodeCache.current.get(centerOn.id) : null;
    if (!graph || !node || node.x === undefined) return;
    const { x = 0, y = 0, z = 0 } = node;
    const dist = 230;
    const ratio = 1 + dist / Math.max(1, Math.hypot(x, y, z));
    graph.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, 900);
  }, [centerOn]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const controls = graph.controls() as OrbitLike;
    controls.autoRotate = rotating;
    controls.autoRotateSpeed = 1.2;
  }, [rotating]);

  /** Forgets all positions, re-runs the layout and returns the camera to the start. */
  const resetLayout = () => {
    const graph = graphRef.current;
    if (!graph) return;
    const { nodes: current, links } = graph.graphData();
    for (const n of current) {
      n.x = n.y = n.z = undefined;
      n.vx = n.vy = n.vz = undefined;
      n.fy = n.fz = undefined;
    }
    userMoved.current = false;
    graph.graphData({ nodes: current, links });
    graph.cameraPosition({ x: 0, y: 0, z: 160 + Math.sqrt(current.length) * 48 }, { x: 0, y: 0, z: 0 }, 500);
    setTimeout(() => graphRef.current?.zoomToFit(900, compact ? 10 : 40), prefersReducedMotion() ? 0 : 1300);
  };

  // A reset requested by the parent (toolbar button).
  const lastReset = useRef(resetNonce);
  useEffect(() => {
    if (lastReset.current === resetNonce) return;
    lastReset.current = resetNonce;
    resetLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetLayout only touches refs and the renderer
  }, [resetNonce]);

  const zoomBy = (factor: number) => {
    const graph = graphRef.current;
    if (!graph) return;
    const p = graph.cameraPosition();
    const t = (graph.controls() as OrbitLike).target ?? { x: 0, y: 0, z: 0 };
    graph.cameraPosition(
      { x: t.x + (p.x - t.x) * factor, y: t.y + (p.y - t.y) * factor, z: t.z + (p.z - t.z) * factor },
      { x: t.x, y: t.y, z: t.z },
      250,
    );
  };

  if (!supported) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted">
        3D graphs need WebGL, which isn&apos;t available in this browser. Switch to the 2D view.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        role="img"
        aria-label={ariaLabel}
      />
      <div
        className={
          compact
            ? "absolute right-2 bottom-2 flex gap-0.5 rounded-md border border-border bg-surface/95 p-0.5 shadow-sm"
            : "absolute right-3 bottom-3 flex flex-col gap-1 rounded-lg border border-border bg-surface/95 p-1 shadow-sm"
        }
      >
        <Button variant="ghost" size="icon-sm" onClick={() => zoomBy(0.75)} aria-label="Zoom in">
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => zoomBy(1.33)} aria-label="Zoom out">
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => graphRef.current?.zoomToFit(500, compact ? 20 : 50)}
          aria-label="Fit graph to view"
        >
          <Maximize />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            callbacks.current.onSelectNode?.(null);
            callbacks.current.onSelectEdge?.(null);
            setRotating(false);
            resetLayout();
          }}
          aria-label="Reset view"
          title="Reset view: re-run the layout and recenter"
        >
          <RotateCcw />
        </Button>
        {!compact && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setRotating(!rotating)}
            aria-label={rotating ? "Stop rotating" : "Rotate automatically"}
            aria-pressed={rotating}
          >
            {rotating ? <Pause /> : <Play />}
          </Button>
        )}
      </div>
      {!compact && (
        <p className="pointer-events-none absolute top-3 right-3 rounded-md bg-surface/85 px-2 py-1 text-[11.5px] text-muted shadow-xs">
          Drag to rotate · drag a node to move it · scroll to zoom · right-drag to pan
        </p>
      )}
    </div>
  );
}
