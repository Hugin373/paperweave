import type { Metadata } from "next";
import { CitationExplorer } from "@/components/graph/citation-explorer";

export const metadata: Metadata = { title: "Citation explorer" };

export default async function CitationExplorerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CitationExplorer key={id} paperId={id} />;
}
