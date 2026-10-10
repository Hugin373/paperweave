"use client";

import { Box, List, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/menu";

export const GRAPH_VIEWS = ["3d", "2d", "list"] as const;
export type GraphView = (typeof GRAPH_VIEWS)[number];

const OPTIONS: { view: GraphView; label: string; tip: string; icon: typeof Box }[] = [
  { view: "3d", label: "3D view", tip: "3D graph — rotate to untangle large graphs", icon: Box },
  { view: "2d", label: "2D view", tip: "2D graph", icon: Network },
  { view: "list", label: "List view", tip: "Text list of items and their connections", icon: List },
];

/** 3D / 2D / list toggle shared by the graph views. */
export function ViewSwitcher({
  view,
  onChange,
  views = GRAPH_VIEWS,
}: {
  view: GraphView;
  onChange: (v: GraphView) => void;
  views?: readonly GraphView[];
}) {
  return (
    <div className="flex rounded-md border border-border bg-surface p-0.5" role="group" aria-label="View">
      {OPTIONS.filter((o) => views.includes(o.view)).map(({ view: v, label, tip, icon: Icon }) => (
        <Tooltip key={v} content={tip}>
          <Button
            size="icon-sm"
            variant={view === v ? "secondary" : "ghost"}
            onClick={() => onChange(v)}
            aria-label={label}
            aria-pressed={view === v}
          >
            {v === "3d" ? <span className="text-[11px] font-semibold">3D</span> : <Icon />}
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}
