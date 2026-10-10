"use client";

import { useQuery } from "@tanstack/react-query";
import { Crosshair, ExternalLink, GitFork, Lightbulb, NotebookPen, FileText, X } from "lucide-react";
import Link from "next/link";
import { SaveControl } from "@/components/papers/save-control";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { formatAuthors, formatCount } from "@/lib/format";
import type { GraphEdge, GraphNode, GraphNodeType, PaperDetail } from "@/lib/types";
import { EDGE_LABEL } from "./graph-style";

export const NODE_ICON: Record<GraphNodeType, typeof FileText> = {
  paper: FileText,
  concept: Lightbulb,
  note: NotebookPen,
};

export const NODE_COLOR: Record<GraphNodeType, string> = {
  paper: "var(--node-paper)",
  concept: "var(--node-concept)",
  note: "var(--node-note)",
};

export function entityHref(node: Pick<GraphNode, "type" | "entityId">) {
  return node.type === "paper"
    ? `/papers/${node.entityId}`
    : node.type === "concept"
      ? `/concepts/${node.entityId}`
      : `/notes/${node.entityId}`;
}

function PaperDetails({ paperId }: { paperId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["paper", paperId],
    queryFn: () => api<PaperDetail>(`/api/papers/${paperId}`),
  });
  if (isLoading) return <Spinner label="Loading paper…" />;
  if (error || !data) return <p className="text-sm text-muted">Paper details are unavailable right now.</p>;
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        {formatAuthors(data.authors)}
        {data.year ? ` · ${data.year}` : ""}
        {data.venue ? ` · ${data.venue}` : ""}
      </p>
      {data.citationCount !== null && (
        <p className="text-[13px] text-muted">{formatCount(data.citationCount)} citations</p>
      )}
      {data.abstract && <p className="line-clamp-5 text-[13px] leading-relaxed text-text/85">{data.abstract}</p>}
      <div className="flex flex-wrap gap-2">
        <SaveControl paperId={data.id} library={data.library} />
        <Button asChild size="sm" variant="secondary">
          <Link href={`/papers/${data.id}/graph`}>
            <GitFork />
            Citation explorer
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** Side panel describing the selected node and its connections. */
export function GraphInspector({
  node,
  nodes,
  edges,
  onSelect,
  onFocus,
  onClose,
}: {
  node: GraphNode;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  onSelect: (id: string) => void;
  onFocus: (node: GraphNode) => void;
  onClose: () => void;
}) {
  const Icon = NODE_ICON[node.type];
  const connections = edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .map((e) => {
      const otherId = e.source === node.id ? e.target : e.source;
      const outgoing = e.source === node.id;
      return { edge: e, other: nodes.get(otherId), outgoing };
    })
    .filter((c): c is typeof c & { other: GraphNode } => !!c.other);

  return (
    <aside
      aria-label="Selected item"
      className="flex h-full flex-col overflow-hidden border-l border-border bg-surface"
    >
      <div className="flex items-start gap-2 border-b border-border p-4">
        <Icon className="mt-0.5 size-4 shrink-0" style={{ color: NODE_COLOR[node.type] }} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium tracking-wide text-subtle uppercase">{node.type}</p>
          <h2 className="mt-0.5 font-serif text-[15px] leading-snug font-semibold">{node.label}</h2>
          {node.sublabel && <p className="mt-0.5 text-[12.5px] text-muted">{node.sublabel}</p>}
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="primary">
            <Link href={entityHref(node)}>
              <ExternalLink />
              Open {node.type}
            </Link>
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onFocus(node)}>
            <Crosshair />
            Focus here
          </Button>
        </div>
        {node.type === "paper" && <PaperDetails paperId={node.entityId} />}
        <div>
          <h3 className="mb-1.5 text-xs font-medium tracking-wide text-subtle uppercase">
            Connections ({connections.length})
          </h3>
          {connections.length ? (
            <ul className="space-y-0.5">
              {connections.map(({ edge, other, outgoing }) => {
                const OtherIcon = NODE_ICON[other.type];
                return (
                  <li key={edge.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(other.id)}
                      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                    >
                      <OtherIcon
                        className="mt-0.5 size-3.5 shrink-0"
                        style={{ color: NODE_COLOR[other.type] }}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="line-clamp-2 text-[13px]">{other.label}</span>
                        <span className="text-[11.5px] text-subtle">
                          {edge.type === "cites"
                            ? outgoing
                              ? "cited by this paper"
                              : "cites this paper"
                            : EDGE_LABEL[edge.type]}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No connections yet. Link it from a note or concept to connect it.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
