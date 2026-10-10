"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Lightbulb, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage, qs } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import type { ConceptSummary } from "@/lib/types";

export function useInvalidateConcepts() {
  const qc = useQueryClient();
  return () =>
    Promise.all(["paper", "concept", "concepts", "graph"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

/** Popover to link/unlink concepts to a paper, or create a new concept linked to it. */
export function ConceptPicker({
  paperId,
  linked,
  trigger,
}: {
  paperId: string;
  linked: { id: string; name: string }[];
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 200);
  const invalidate = useInvalidateConcepts();
  const linkedIds = new Set(linked.map((c) => c.id));

  const { data, isFetching } = useQuery({
    queryKey: ["concepts", "picker", debounced],
    queryFn: () => api<ConceptSummary[]>(`/api/concepts${qs({ q: debounced })}`),
    enabled: open,
  });

  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      api(`/api/concepts/${id}/papers`, { method: on ? "DELETE" : "POST", body: { paperId } }),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const create = useMutation({
    mutationFn: (name: string) => api<{ id: string; name: string }>("/api/concepts", { body: { name, paperId } }),
    onSuccess: (c) => {
      setQ("");
      toast.success(`Concept “${c.name}” created and linked`);
      return invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const term = q.trim();
  const exact = (data ?? []).some((c) => c.name.toLowerCase() === term.toLowerCase());

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="ghost">
            <Lightbulb />
            Concepts
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (term && !exact) create.mutate(term);
          }}
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find or create a concept…"
            aria-label="Concept name"
            className="h-8"
            autoFocus
          />
        </form>
        <div className="mt-2 max-h-60 overflow-y-auto">
          {isFetching && !data && (
            <div className="p-2">
              <Spinner />
            </div>
          )}
          {(data ?? []).map((c) => {
            const on = linkedIds.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ id: c.id, on })}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
              >
                <span className="flex size-4 items-center justify-center">
                  {on && <Check className="size-3.5 text-accent" />}
                </span>
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-[11px] text-subtle">{c.paperCount}</span>
              </button>
            );
          })}
          {term && !exact && (
            <button
              type="button"
              disabled={create.isPending}
              onClick={() => create.mutate(term)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-accent-text hover:bg-surface-2"
            >
              <Plus className="size-3.5" />
              Create “{term}”
            </button>
          )}
          {data && !data.length && !term && (
            <p className="px-2 py-2 text-[13px] text-muted">
              No concepts yet. Type a name like “metric depth” to create one.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
