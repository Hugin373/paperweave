import type { Metadata } from "next";
import { Suspense } from "react";
import { WorkspaceSearchView } from "@/components/search/workspace-search-view";
import { PageLoading } from "@/components/ui/spinner";

export const metadata: Metadata = { title: "Search your workspace" };

export default function WorkspaceSearchPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <WorkspaceSearchView />
    </Suspense>
  );
}
