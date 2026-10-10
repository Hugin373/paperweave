"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import type { HighlightDto, HighlightRect } from "@/lib/types";
import type { HighlightColor } from "./geometry";

export interface NewHighlight {
  kind: "highlight" | "note";
  pageNumber: number;
  rects: HighlightRect[];
  selectedText: string;
  prefix: string;
  suffix: string;
  color: HighlightColor;
  comment: string;
}

export function useHighlights(fileId: string | null) {
  const qc = useQueryClient();
  const key = ["highlights", fileId];

  const query = useQuery({
    queryKey: key,
    queryFn: () => api<HighlightDto[]>(`/api/files/${fileId}/highlights`),
    enabled: !!fileId,
  });

  const setList = (fn: (list: HighlightDto[]) => HighlightDto[]) =>
    qc.setQueryData<HighlightDto[]>(key, (old) => fn(old ?? []));

  const create = useMutation({
    mutationFn: (input: NewHighlight) => api<HighlightDto>(`/api/files/${fileId}/highlights`, { body: input }),
    onSuccess: (h) => {
      setList((list) =>
        [...list, h].sort((a, b) => a.pageNumber - b.pageNumber || a.createdAt.localeCompare(b.createdAt)),
      );
      void qc.invalidateQueries({ queryKey: ["paper"] });
    },
    onError: (err) => toast.error(errorMessage(err, "The highlight could not be saved.")),
  });

  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; color?: HighlightColor; comment?: string }) =>
      api<HighlightDto>(`/api/highlights/${id}`, { method: "PATCH", body: patch }),
    onSuccess: (h) => setList((list) => list.map((x) => (x.id === h.id ? h : x))),
    onError: (err) => toast.error(errorMessage(err, "The change could not be saved.")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/highlights/${id}`, { method: "DELETE" }),
    onMutate: (id) => {
      const prev = qc.getQueryData<HighlightDto[]>(key);
      setList((list) => list.filter((x) => x.id !== id));
      return { prev };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(errorMessage(err, "The highlight could not be deleted."));
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["paper"] }),
  });

  return { highlights: query.data ?? [], query, create, update, remove };
}
