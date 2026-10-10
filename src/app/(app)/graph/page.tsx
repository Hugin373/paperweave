import type { Metadata } from "next";
import { Suspense } from "react";
import { KnowledgeGraphView } from "@/components/graph/knowledge-graph-view";
import { PageLoading } from "@/components/ui/spinner";

export const metadata: Metadata = { title: "Graph" };

export default function GraphPage() {
  return (
    <Suspense fallback={<PageLoading label="Loading graph…" />}>
      <KnowledgeGraphView />
    </Suspense>
  );
}
