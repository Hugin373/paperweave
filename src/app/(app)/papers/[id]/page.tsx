import type { Metadata } from "next";
import { PaperView } from "@/components/papers/paper-view";

export const metadata: Metadata = { title: "Paper" };

export default async function PaperPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PaperView id={id} />;
}
