import type { Metadata } from "next";
import { CollectionView } from "@/components/library/collection-view";

export const metadata: Metadata = { title: "Collection" };

export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CollectionView id={id} />;
}
