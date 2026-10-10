"use client";

import dynamic from "next/dynamic";
import { Spinner } from "@/components/ui/spinner";

const loading = () => (
  <div className="flex h-full items-center justify-center">
    <Spinner label="Preparing graph…" />
  </div>
);

/** 2D graph (force-graph on a canvas, Obsidian-style physics). Needs the DOM, so client-only. */
export const GraphCanvas = dynamic(() => import("./force-graph-2d").then((m) => m.ForceGraph2DView), {
  ssr: false,
  loading,
});

/** 3D graph (three.js / WebGL), loaded on demand. */
export const GraphCanvas3D = dynamic(() => import("./force-graph-3d").then((m) => m.ForceGraph3DView), {
  ssr: false,
  loading,
});
