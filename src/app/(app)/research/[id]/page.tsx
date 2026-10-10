import type { Metadata } from "next";
import { ResearchThread } from "@/components/research/research-thread";

export const metadata: Metadata = { title: "Assistant" };

export default async function ResearchThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ResearchThread id={id} />;
}
