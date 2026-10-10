"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Lightbulb, NotebookPen, Share2, X } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { SharedWithMeItem } from "@/lib/types";

const ICON = { collection: FolderOpen, note: NotebookPen, concept: Lightbulb };
const HREF = { collection: "/collections/", note: "/notes/", concept: "/concepts/" };

export default function SharedPage() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["shared"],
    queryFn: () => api<SharedWithMeItem[]>("/api/shared"),
  });
  const leave = useMutation({
    mutationFn: (shareId: string) => api(`/api/shares/${shareId}/leave`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shared"] }),
  });
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Shared with me</h1>
        <p className="mt-1 text-sm text-muted">
          Collections, notes and concepts other people shared with your account.
        </p>
      </header>
      {isLoading ? (
        <PageLoading />
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : !data?.length ? (
        <EmptyState
          icon={Share2}
          title="Nothing shared with you yet"
          description="When someone shares a collection, note or concept with your email address, it appears here."
        />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {data.map((item) => {
            const Icon = ICON[item.resourceType];
            return (
              <li key={item.shareId} className="flex items-center gap-3 px-4 py-3">
                <Icon className="size-4 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`${HREF[item.resourceType]}${item.resourceId}`}
                    className="font-medium hover:text-accent-text hover:underline"
                  >
                    {item.title}
                  </Link>
                  <p className="text-[12.5px] text-muted">
                    From {item.ownerName} · {relativeTime(item.createdAt)}
                  </p>
                </div>
                <Badge tone={item.permission === "edit" ? "accent" : "neutral"}>
                  {item.permission === "edit" ? "Can edit" : "View only"}
                </Badge>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => leave.mutate(item.shareId)}
                  aria-label={`Remove ${item.title} from this list`}
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
