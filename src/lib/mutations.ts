"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "./api";
import type { ReadingStatus } from "./types";
import { STATUS_LABEL } from "./format";

/** Query keys whose data depends on library membership/organization. */
export function useInvalidateLibrary() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [
        "library",
        "paper",
        "search",
        "me",
        "collections",
        "tags",
        "collection",
        "graph",
        "citations",
        "citation-graph",
        "concept",
        "research",
      ].map((k) => qc.invalidateQueries({ queryKey: [k] })),
    );
}

export function useSetStatus() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: ({ paperId, status }: { paperId: string; status: ReadingStatus }) =>
      api(`/api/papers/${paperId}/library`, { method: "PUT", body: { status } }),
    onSuccess: (_d, v) => {
      toast.success(
        v.status === "saved" ? "Saved to your library" : `Marked as ${STATUS_LABEL[v.status].toLowerCase()}`,
      );
      return invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, "Could not update the paper.")),
  });
}

export function useRemoveFromLibrary() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: (paperId: string) => api(`/api/papers/${paperId}/library`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Removed from your library. Notes and highlights were kept.");
      return invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, "Could not remove the paper.")),
  });
}

export function useBulk() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api("/api/library/bulk", { body }),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(errorMessage(err, "Could not update the papers.")),
  });
}
