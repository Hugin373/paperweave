"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, FolderOpen, Highlighter, Lightbulb, NotebookPen, ScrollText, Search, Tag } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Snippet } from "@/components/app/command-palette";
import { PaperMeta } from "@/components/papers/paper-card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api, qs } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import type { WorkspaceSearchResponse } from "@/lib/types";

function Group({
  title,
  icon: Icon,
  count,
  children,
}: {
  title: string;
  icon: typeof FileText;
  count: number;
  children: ReactNode;
}) {
  if (!count) return null;
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-muted">
        <Icon className="size-4" aria-hidden />
        {title} <span className="font-normal text-subtle">{count}</span>
      </h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-surface">{children}</ul>
    </section>
  );
}

const row = "block px-4 py-3 hover:bg-surface-2/60";

/** Full-page search over the user's own knowledge, grouped by type. */
export function WorkspaceSearchView() {
  const params = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState(params.get("q") ?? "");
  const debounced = useDebounced(q.trim(), 250);
  useEffect(() => {
    router.replace(`/workspace-search${qs({ q: debounced })}`);
  }, [debounced, router]);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["workspace-search", debounced],
    queryFn: () => api<WorkspaceSearchResponse>(`/api/workspace-search${qs({ q: debounced })}`),
    enabled: debounced.length > 0,
  });
  const total = data
    ? data.papers.length +
      data.notes.length +
      data.concepts.length +
      data.highlights.length +
      data.pdfPages.length +
      data.tags.length +
      data.collections.length
    : 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Search your workspace</h1>
        <p className="mt-1 text-sm text-muted">
          Searches your saved papers, notes, concepts, highlights, PDF text, tags and collections. To find new
          literature, use{" "}
          <Link href={`/search${qs({ q: debounced })}`} className="text-accent-text hover:underline">
            scholarly search
          </Link>
          .
        </p>
      </header>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
          aria-hidden
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-11 pl-9 text-base"
          placeholder="Search your knowledge…"
          aria-label="Search your workspace"
          autoFocus
        />
      </div>
      {isLoading && debounced && <Skeleton className="h-40 w-full rounded-xl" />}
      {error && <ErrorState error={error} onRetry={() => refetch()} />}
      {data && debounced && total === 0 && (
        <EmptyState
          icon={Search}
          title={`Nothing matches “${debounced}”`}
          description="Try other words, or search the literature for new papers."
        />
      )}
      {data && debounced && (
        <div className="space-y-6">
          <Group title="Papers" icon={FileText} count={data.papers.length}>
            {data.papers.map(({ paper, snippet }) => (
              <li key={paper.id}>
                <Link href={`/papers/${paper.id}`} className={row}>
                  <span className="font-medium">{paper.title}</span>
                  <PaperMeta paper={paper} />
                  {snippet && (
                    <p className="mt-1 line-clamp-2 text-[13px] text-text/80">
                      <Snippet text={snippet} />
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </Group>
          <Group title="Concepts" icon={Lightbulb} count={data.concepts.length}>
            {data.concepts.map((c) => (
              <li key={c.id}>
                <Link href={`/concepts/${c.id}`} className={row}>
                  <span className="font-medium">{c.name}</span>
                  {c.snippet && (
                    <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">
                      <Snippet text={c.snippet} />
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </Group>
          <Group title="Notes" icon={NotebookPen} count={data.notes.length}>
            {data.notes.map((n) => (
              <li key={n.id}>
                <Link href={`/notes/${n.id}`} className={row}>
                  <span className="font-medium">{n.title}</span>
                  {n.paperTitle && <span className="ml-2 text-[12.5px] text-muted">on {n.paperTitle}</span>}
                  <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">
                    {n.snippet ? <Snippet text={n.snippet} /> : n.excerpt}
                  </p>
                </Link>
              </li>
            ))}
          </Group>
          <Group title="Highlights & annotations" icon={Highlighter} count={data.highlights.length}>
            {data.highlights.map((h) => (
              <li key={h.id}>
                <Link href={`/papers/${h.paperId}/read?page=${h.pageNumber}&highlight=${h.id}`} className={row}>
                  {h.text && <p className="border-l-2 border-warning pl-2 text-sm italic">“{h.text}”</p>}
                  {h.comment && <p className="mt-1 text-sm">{h.comment}</p>}
                  <p className="mt-1 text-[12.5px] text-muted">
                    {h.paperTitle} · page {h.pageNumber}
                  </p>
                </Link>
              </li>
            ))}
          </Group>
          <Group title="Inside your PDFs" icon={ScrollText} count={data.pdfPages.length}>
            {data.pdfPages.map((p) => (
              <li key={`${p.fileId}-${p.pageNumber}`}>
                <Link href={`/papers/${p.paperId}/read?file=${p.fileId}&page=${p.pageNumber}`} className={row}>
                  <span className="text-sm font-medium">
                    {p.paperTitle} · page {p.pageNumber}
                  </span>
                  <p className="mt-0.5 line-clamp-3 text-[13px] text-muted">
                    <Snippet text={p.snippet} />
                  </p>
                </Link>
              </li>
            ))}
          </Group>
          <Group title="Collections" icon={FolderOpen} count={data.collections.length}>
            {data.collections.map((c) => (
              <li key={c.id}>
                <Link href={`/library?collection=${c.id}`} className={row}>
                  <span className="font-medium">{c.name}</span>{" "}
                  <span className="text-[12.5px] text-muted">{c.paperCount} papers</span>
                </Link>
              </li>
            ))}
          </Group>
          <Group title="Tags" icon={Tag} count={data.tags.length}>
            {data.tags.map((t) => (
              <li key={t.id}>
                <Link href={`/library?tag=${t.id}`} className={row}>
                  <span className="font-medium">#{t.name}</span>{" "}
                  <span className="text-[12.5px] text-muted">{t.paperCount} papers</span>
                </Link>
              </li>
            ))}
          </Group>
        </div>
      )}
    </div>
  );
}
