import type { Metadata } from "next";
import { ScreeningDetailView } from "@/components/screening/screening-views";

export const metadata: Metadata = { title: "Screening" };

export default async function ScreeningDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ScreeningDetailView id={id} />;
}
