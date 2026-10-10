import type { Metadata } from "next";
import { ScreeningList } from "@/components/screening/screening-views";

export const metadata: Metadata = { title: "Screening" };

export default function ScreeningPage() {
  return <ScreeningList />;
}
