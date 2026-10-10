import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchView } from "@/components/search/search-view";
import { PageLoading } from "@/components/ui/spinner";

export const metadata: Metadata = { title: "Search" };

export default function SearchPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <SearchView />
    </Suspense>
  );
}
