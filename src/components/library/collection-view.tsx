"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Plus, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { PaperCard } from "@/components/papers/paper-card";
import { SaveControl } from "@/components/papers/save-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api, errorMessage, qs } from "@/lib/api";
import { collectionColor } from "@/lib/collection-colors";
import { useDebounced } from "@/lib/hooks";
import type { AccessLevel, PaperSummary, SearchResponse } from "@/lib/types";

interface CollectionViewDto {
  id: string;
  name: string;
  description: string;
  color: string | null;
  papers: PaperSummary[];
  access: AccessLevel;
}

function AddPapers({ collectionId }: { collectionId: string }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 400);
  const results = useQuery({
    queryKey: ["search", "collection-add", debounced],
    queryFn: () => api<SearchResponse>(`/api/search/papers${qs({ q: debounced, limit: 5 })}`),
    enabled: debounced.length > 2,
  });
  const add = useMutation({
    mutationFn: (paperId: string) => api(`/api/collections/${collectionId}/papers`, { body: { paperIds: [paperId] } }),
    onSuccess: () => {
      toast.success("Added to the collection");
      return qc.invalidateQueries({ queryKey: ["collection", collectionId] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search for a paper to add (title, DOI, arXiv…)"
        aria-label="Search for a paper to add"
      />
      {results.data && (
        <ul className="stagger mt-2 divide-y divide-border">
          {results.data.items.map((p) => (
            <li key={p.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                {p.title} <span className="text-muted">({p.year ?? "n.d."})</span>
              </span>
              <Button size="sm" onClick={() => add.mutate(p.id)} loading={add.isPending && add.variables === p.id}>
                <Plus />
                Add
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A collection viewed by its owner or by someone it was shared with. */
export function CollectionView({ id }: { id: string }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["collection", id],
    queryFn: () => api<CollectionViewDto>(`/api/collections/${id}`),
  });
  const remove = useMutation({
    mutationFn: (paperId: string) =>
      api(`/api/collections/${id}/papers`, { method: "DELETE", body: { paperIds: [paperId] } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["collection", id] }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading) return <PageLoading />;
  if (error || !data)
    return <ErrorState title="This collection is not available" error={error} onRetry={() => refetch()} />;
  const canEdit = data.access !== "view";

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <FolderOpen className="size-5" style={{ color: collectionColor(data) }} aria-hidden />
            {data.name}
          </h1>
          {data.description && <p className="mt-1 text-sm text-muted">{data.description}</p>}
          <div className="mt-2 flex gap-2">
            <Badge tone={data.access === "owner" ? "accent" : "neutral"}>
              {data.access === "owner"
                ? "Your collection"
                : data.access === "edit"
                  ? "Shared with you · can edit"
                  : "Shared with you · view only"}
            </Badge>
            <span className="text-sm text-subtle">{data.papers.length} papers</span>
          </div>
        </div>
        {data.access === "owner" && (
          <Button variant="secondary" asChild>
            <Link href={`/library?collection=${data.id}`}>Open in library</Link>
          </Button>
        )}
        {canEdit && data.access !== "owner" && (
          <Button variant="secondary" onClick={() => setAdding((a) => !a)}>
            <Plus />
            Add papers
          </Button>
        )}
      </header>
      {adding && <AddPapers collectionId={data.id} />}
      {data.papers.length ? (
        <div className="space-y-2">
          {data.papers.map((p) => (
            <PaperCard
              key={p.id}
              paper={p}
              actions={
                <>
                  {!p.isUserPaper && <SaveControl paperId={p.id} library={p.library} />}
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => remove.mutate(p.id)}
                      aria-label={`Remove ${p.title} from collection`}
                    >
                      <X />
                      Remove
                    </Button>
                  )}
                </>
              }
            />
          ))}
        </div>
      ) : (
        <EmptyState icon={FolderOpen} title="This collection is empty" />
      )}
    </div>
  );
}
