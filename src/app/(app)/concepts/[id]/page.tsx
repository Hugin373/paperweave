import type { Metadata } from "next";
import { ConceptPage } from "@/components/concepts/concept-page";

export const metadata: Metadata = { title: "Concept" };

export default async function ConceptRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConceptPage id={id} />;
}
