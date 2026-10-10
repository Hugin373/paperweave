"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import type { ResearchMode, ResearchScope, ResearchThreadDto, ResearchThreadSummary } from "@/lib/types";

export function useResearchThreads() {
  return useQuery({
    queryKey: ["research", "list"],
    queryFn: () => api<ResearchThreadSummary[]>("/api/research"),
    refetchInterval: (q) => (q.state.data?.some((t) => t.status === "running") ? 3000 : false),
  });
}

/** A research thread; polls while research is running so progress appears live. */
export function useResearchThread(id: string) {
  return useQuery({
    queryKey: ["research", id],
    queryFn: () => api<ResearchThreadDto>(`/api/research/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.messages.some((m) => m.status === "running") ? 1000 : false),
  });
}

export interface StartResearchInput {
  question: string;
  mode: ResearchMode;
  autoApply?: boolean;
  scope?: Partial<ResearchScope>;
}

/** Starts a new research thread and opens it. */
export function useStartResearch() {
  const router = useRouter();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartResearchInput) =>
      api<{ threadId: string; messageId: string }>("/api/research", { body: input }),
    onSuccess: ({ threadId }) => {
      void qc.invalidateQueries({ queryKey: ["research", "list"] });
      router.push(`/research/${threadId}`);
    },
    onError: (err) => toast.error(errorMessage(err, "The message could not be sent.")),
  });
}
