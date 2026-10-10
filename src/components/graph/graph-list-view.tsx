import Link from "next/link";
import type { GraphEdge, GraphNode, GraphNodeType } from "@/lib/types";
import { entityHref, NODE_COLOR, NODE_ICON } from "./graph-inspector";

const GROUPS: { type: GraphNodeType; title: string }[] = [
  { type: "paper", title: "Papers" },
  { type: "concept", title: "Concepts" },
  { type: "note", title: "Notes" },
];

/** Accessible text alternative to the graph canvas: every node with its connections. */
export function GraphListView({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const neighbors = new Map<string, GraphNode[]>();
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    neighbors.set(a.id, [...(neighbors.get(a.id) ?? []), b]);
    neighbors.set(b.id, [...(neighbors.get(b.id) ?? []), a]);
  }
  return (
    <div className="h-full overflow-y-auto px-4 py-5 md:px-8">
      <div className="mx-auto max-w-3xl space-y-8">
        {GROUPS.map(({ type, title }) => {
          const list = nodes.filter((n) => n.type === type).sort((a, b) => a.label.localeCompare(b.label));
          if (!list.length) return null;
          const Icon = NODE_ICON[type];
          return (
            <section key={type} aria-labelledby={`graph-list-${type}`}>
              <h2 id={`graph-list-${type}`} className="mb-2 text-sm font-semibold">
                {title} <span className="font-normal text-subtle">({list.length})</span>
              </h2>
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                {list.map((n) => {
                  const links = neighbors.get(n.id) ?? [];
                  return (
                    <li key={n.id} className="px-4 py-2.5">
                      <Link
                        href={entityHref(n)}
                        className="flex items-start gap-2 text-sm font-medium hover:text-accent-text"
                      >
                        <Icon className="mt-0.5 size-4 shrink-0" style={{ color: NODE_COLOR[n.type] }} aria-hidden />
                        {n.label}
                      </Link>
                      {links.length > 0 && (
                        <p className="mt-1 pl-6 text-[12.5px] text-muted">
                          Connected to:{" "}
                          {links.map((l, i) => (
                            <span key={l.id}>
                              {i > 0 && ", "}
                              <Link href={entityHref(l)} className="hover:text-text hover:underline">
                                {l.label}
                              </Link>
                            </span>
                          ))}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
