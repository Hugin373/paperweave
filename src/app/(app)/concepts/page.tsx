import type { Metadata } from "next";
import { ConceptsList } from "@/components/concepts/concepts-list";

export const metadata: Metadata = { title: "Concepts" };

export default async function ConceptsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const { new: openNew } = await searchParams;
  return <ConceptsList openNew={openNew === "1"} />;
}
