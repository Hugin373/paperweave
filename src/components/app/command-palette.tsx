"use client";

import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { Dialog as D } from "radix-ui";
import { FileText, Highlighter, Lightbulb, NotebookPen, Plus, Search, Tag, FolderOpen, ScrollText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import { api, qs } from "@/lib/api";
import { snippetParts } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import type { WorkspaceSearchResponse } from "@/lib/types";

export function Snippet({ text }: { text: string }) {
  return (
    <>
      {snippetParts(text).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-warning-soft px-0.5 text-text">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function Item({
  onSelect,
  icon,
  title,
  detail,
  value,
}: {
  onSelect: () => void;
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  value: string;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-sm data-[selected=true]:bg-surface-2"
    >
      <span className="mt-0.5 text-muted [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        {detail && <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-muted">{detail}</span>}
      </span>
    </Command.Item>
  );
}

const group =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 200);
  const { data, isFetching } = useQuery({
    queryKey: ["workspace-search", debounced],
    queryFn: () => api<WorkspaceSearchResponse>(`/api/workspace-search${qs({ q: debounced })}`),
    enabled: open && debounced.length > 0,
    placeholderData: (prev) => prev,
  });

  const go = (href: string) => {
    onOpenChange(false);
    setQ("");
    router.push(href);
  };

  const hasResults =
    !!data &&
    debounced.length > 0 &&
    (data.papers.length ||
      data.notes.length ||
      data.concepts.length ||
      data.highlights.length ||
      data.pdfPages.length ||
      data.tags.length ||
      data.collections.length) > 0;

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <D.Content className="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
          <D.Title className="sr-only">Search your workspace</D.Title>
          <D.Description className="sr-only">
            Find papers, notes, concepts and highlights in your workspace
          </D.Description>
          <Command shouldFilter={false} loop>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-muted" aria-hidden />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder="Search papers, notes, concepts, highlights…"
                className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle"
              />
              {isFetching && <Spinner />}
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-1.5">
              {debounced && !isFetching && !hasResults && (
                <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
                  Nothing in your workspace matches “{debounced}”.
                </Command.Empty>
              )}
              {debounced && (
                <Command.Group heading="Actions" className={group}>
                  <Item
                    value="action-scholarly"
                    icon={<Search />}
                    title={<>Search scholarly literature for “{debounced}”</>}
                    onSelect={() => go(`/search${qs({ q: debounced })}`)}
                  />
                  <Item
                    value="action-all"
                    icon={<ScrollText />}
                    title="See all workspace results"
                    onSelect={() => go(`/workspace-search${qs({ q: debounced })}`)}
                  />
                </Command.Group>
              )}
              {!debounced && (
                <Command.Group heading="Quick actions" className={group}>
                  <Item value="new-note" icon={<Plus />} title="New note" onSelect={() => go("/notes/new")} />
                  <Item
                    value="new-concept"
                    icon={<Lightbulb />}
                    title="New concept"
                    onSelect={() => go("/concepts?new=1")}
                  />
                  <Item value="find-papers" icon={<Search />} title="Find papers" onSelect={() => go("/search")} />
                </Command.Group>
              )}
              {data && debounced && (
                <>
                  {data.papers.length > 0 && (
                    <Command.Group heading="Papers" className={group}>
                      {data.papers.slice(0, 6).map(({ paper, snippet }) => (
                        <Item
                          key={paper.id}
                          value={`paper-${paper.id}`}
                          icon={<FileText />}
                          title={paper.title}
                          detail={snippet ? <Snippet text={snippet} /> : paper.authors.slice(0, 3).join(", ")}
                          onSelect={() => go(`/papers/${paper.id}`)}
                        />
                      ))}
                    </Command.Group>
                  )}
                  {data.concepts.length > 0 && (
                    <Command.Group heading="Concepts" className={group}>
                      {data.concepts.slice(0, 5).map((c) => (
                        <Item
                          key={c.id}
                          value={`concept-${c.id}`}
                          icon={<Lightbulb />}
                          title={c.name}
                          detail={c.snippet ? <Snippet text={c.snippet} /> : undefined}
                          onSelect={() => go(`/concepts/${c.id}`)}
                        />
                      ))}
                    </Command.Group>
                  )}
                  {data.notes.length > 0 && (
                    <Command.Group heading="Notes" className={group}>
                      {data.notes.slice(0, 5).map((n) => (
                        <Item
                          key={n.id}
                          value={`note-${n.id}`}
                          icon={<NotebookPen />}
                          title={n.title}
                          detail={n.snippet ? <Snippet text={n.snippet} /> : n.excerpt}
                          onSelect={() => go(`/notes/${n.id}`)}
                        />
                      ))}
                    </Command.Group>
                  )}
                  {data.highlights.length > 0 && (
                    <Command.Group heading="Highlights & annotations" className={group}>
                      {data.highlights.slice(0, 4).map((h) => (
                        <Item
                          key={h.id}
                          value={`hl-${h.id}`}
                          icon={<Highlighter />}
                          title={h.text || h.comment}
                          detail={`${h.paperTitle} · p. ${h.pageNumber}`}
                          onSelect={() => go(`/papers/${h.paperId}/read?page=${h.pageNumber}&highlight=${h.id}`)}
                        />
                      ))}
                    </Command.Group>
                  )}
                  {data.pdfPages.length > 0 && (
                    <Command.Group heading="Inside PDFs" className={group}>
                      {data.pdfPages.slice(0, 4).map((p) => (
                        <Item
                          key={`${p.fileId}-${p.pageNumber}`}
                          value={`page-${p.fileId}-${p.pageNumber}`}
                          icon={<ScrollText />}
                          title={`${p.paperTitle} · p. ${p.pageNumber}`}
                          detail={<Snippet text={p.snippet} />}
                          onSelect={() => go(`/papers/${p.paperId}/read?file=${p.fileId}&page=${p.pageNumber}`)}
                        />
                      ))}
                    </Command.Group>
                  )}
                  {(data.tags.length > 0 || data.collections.length > 0) && (
                    <Command.Group heading="Tags & collections" className={group}>
                      {data.collections.slice(0, 4).map((c) => (
                        <Item
                          key={c.id}
                          value={`coll-${c.id}`}
                          icon={<FolderOpen />}
                          title={c.name}
                          detail={`${c.paperCount} papers`}
                          onSelect={() => go(`/library?collection=${c.id}`)}
                        />
                      ))}
                      {data.tags.slice(0, 4).map((t) => (
                        <Item
                          key={t.id}
                          value={`tag-${t.id}`}
                          icon={<Tag />}
                          title={`#${t.name}`}
                          detail={`${t.paperCount} papers`}
                          onSelect={() => go(`/library?tag=${t.id}`)}
                        />
                      ))}
                    </Command.Group>
                  )}
                </>
              )}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
