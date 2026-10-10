"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";

/**
 * For papers known only from OpenReview (anonymous and without a free PDF while under double-blind
 * review): find the same paper on arXiv, or link the arXiv version the user found.
 */
export function ArxivLink({ paperId }: { paperId: string }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const link = useMutation({
    mutationFn: (arxiv?: string) => api<{ arxiv: string | null }>(`/api/papers/${paperId}/arxiv`, { body: { arxiv } }),
    onSuccess: async (r) => {
      if (!r.arxiv) {
        toast.info("Not found on arXiv by its title. If you found it, paste its arXiv link.");
        return;
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["paper", paperId] }),
        qc.invalidateQueries({ queryKey: ["library"] }),
      ]);
      setValue("");
      toast.success(`Linked to arXiv ${r.arxiv}: authors and the free PDF are now available.`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-2/60 p-3 text-[13px]">
      <p className="text-muted">
        This paper comes from OpenReview. While it is under double-blind review, its authors are hidden and its PDF
        needs an OpenReview login. Authors often post the same paper on arXiv; Paperweave looks for it when you save the
        paper and again every few days.
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <Button size="sm" variant="secondary" onClick={() => link.mutate(undefined)} loading={link.isPending && !value}>
          <Search />
          Look for it on arXiv
        </Button>
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) link.mutate(value.trim());
          }}
        >
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="or paste its arXiv link / id"
            aria-label="arXiv link or id of this paper"
            className="h-8 flex-1 text-[13px]"
          />
          <Button size="sm" type="submit" disabled={!value.trim()} loading={link.isPending && !!value}>
            Link
          </Button>
        </form>
      </div>
    </div>
  );
}
