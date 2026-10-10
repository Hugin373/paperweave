"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Archive,
  BookmarkCheck,
  Download,
  FileText,
  FolderMinus,
  FolderOpen,
  Library as LibraryIcon,
  MoreHorizontal,
  Network,
  NotebookPen,
  Pencil,
  Search,
  Share2,
  Tag as TagIcon,
  Telescope,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ShareDialog } from "@/components/sharing/share-dialog";
import { PaperMeta } from "@/components/papers/paper-card";
import { ReadAction } from "@/components/papers/read-action";
import { SaveControl, StatusDot } from "@/components/papers/save-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api, download, errorMessage, qs } from "@/lib/api";
import { cn } from "@/lib/cn";
import { collectionColor } from "@/lib/collection-colors";
import { formatCount, STATUS_LABEL } from "@/lib/format";
import { useCollections, useDebounced, useTags } from "@/lib/hooks";
import { useBulk, useInvalidateLibrary } from "@/lib/mutations";
import { READING_STATUSES, type LibraryItem, type LibraryResponse, type ReadingStatus } from "@/lib/types";
import { CollectionDialog } from "./collection-dialog";
import { CollectionPicker, TagChip, TagPicker } from "./organize";

const PAGE = 50;
const SORTS = [
  ["added_desc", "Recently added"],
  ["updated_desc", "Recently changed"],
  ["year_desc", "Newest publication"],
  ["year_asc", "Oldest publication"],
  ["title_asc", "Title A–Z"],
  ["citations_desc", "Most cited"],
] as const;

function LibraryRow({
  item,
  selected,
  onSelect,
}: {
  item: LibraryItem;
  selected: boolean;
  onSelect: (on: boolean) => void;
}) {
  return (
    <li
      className={cn(
        "flex gap-3 border-b border-border px-3 py-3 last:border-b-0 md:px-4",
        selected && "bg-accent-soft/40",
      )}
    >
      <input
        type="checkbox"
        className="mt-1.5 size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
        checked={selected}
        onChange={(e) => onSelect(e.target.checked)}
        aria-label={`Select ${item.title}`}
      />
      <div className="min-w-0 flex-1">
        <Link
          href={`/papers/${item.id}`}
          className="font-serif text-[15.5px] leading-snug font-semibold hover:text-accent-text hover:underline"
        >
          {item.title}
        </Link>
        <PaperMeta paper={item} className="mt-0.5" />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {item.citationCount !== null && <Badge>{formatCount(item.citationCount)} citations</Badge>}
          {item.hasPdf && (
            <Badge tone="outline">
              <FileText aria-hidden />
              PDF
            </Badge>
          )}
          {item.noteCount > 0 && (
            <Badge tone="outline">
              <NotebookPen aria-hidden />
              {item.noteCount} note{item.noteCount > 1 ? "s" : ""}
            </Badge>
          )}
          {item.collections.map((c) => (
            <Link key={c.id} href={`/library?collection=${c.id}`}>
              <Badge tone="accent">
                <span className="size-1.5 rounded-full" style={{ background: c.color ?? "currentColor" }} aria-hidden />
                {c.name}
              </Badge>
            </Link>
          ))}
          {item.tags.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-start">
        <SaveControl paperId={item.id} library={item.library} />
        <ReadAction
          paperId={item.id}
          hasFile={item.hasPdf}
          pdfAvailable={item.pdfAvailable}
          freeReadUrl={item.freeReadUrl}
          pdfUrl={item.openAccessPdfUrl}
          ids={item.ids}
          sourceFallback
        />
        <Menu>
          <MenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label={`More actions for ${item.title}`}>
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem asChild>
              <Link href={`/notes/new?paperId=${item.id}`}>
                <NotebookPen />
                Add note
              </Link>
            </MenuItem>
            <MenuItem asChild>
              <Link href={`/papers/${item.id}/graph`}>
                <Network />
                Citation graph
              </Link>
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </li>
  );
}

function FilterLink({
  active,
  href,
  children,
  count,
}: {
  active: boolean;
  href: string;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13.5px]",
        active ? "bg-surface-3/70 font-medium text-text" : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      {children}
      {count !== undefined && <span className="ml-auto text-xs text-subtle">{count}</span>}
    </Link>
  );
}

export function LibraryView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const status = (params.get("status") ?? "all") as ReadingStatus | "all";
  const collectionId = params.get("collection");
  const tagId = params.get("tag");
  const sort = params.get("sort") ?? "added_desc";
  const [q, setQ] = useState(params.get("q") ?? "");
  const debouncedQ = useDebounced(q, 300);
  // Selection is scoped to the current filter; changing the filter starts a fresh selection.
  const filterKey = `${status}|${collectionId}|${tagId}`;
  const [selection, setSelection] = useState<{ key: string; ids: Set<string> }>({ key: filterKey, ids: new Set() });
  const selected = selection.key === filterKey ? selection.ids : new Set<string>();
  const setSelected = (update: Set<string> | ((s: Set<string>) => Set<string>)) =>
    setSelection((cur) => {
      const base = cur.key === filterKey ? cur.ids : new Set<string>();
      return { key: filterKey, ids: typeof update === "function" ? update(base) : update };
    });
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const { data: collections } = useCollections();
  const { data: tags } = useTags();
  const bulk = useBulk();
  const invalidate = useInvalidateLibrary();

  const href = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    return `${pathname}${s ? `?${s}` : ""}`;
  };

  useEffect(() => {
    if ((params.get("q") ?? "") !== debouncedQ) router.replace(href({ q: debouncedQ || null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const query = useInfiniteQuery({
    queryKey: ["library", status, collectionId, tagId, sort, debouncedQ],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api<LibraryResponse>(
        `/api/library${qs({ status, collectionId, tagId, sort, q: debouncedQ, offset: pageParam, limit: PAGE })}`,
        { signal },
      ),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const counts = query.data?.pages[0]?.counts;
  const total = query.data?.pages[0]?.total ?? 0;
  const collection = collections?.find((c) => c.id === collectionId);
  const tag = tags?.find((t) => t.id === tagId);
  const selectedIds = [...selected];
  const selectedItems = items.filter((i) => selected.has(i.id));
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const hasFilters = !!(debouncedQ || collectionId || tagId || status !== "all");

  const exportBibtex = (opts: { collectionId?: string; paperIds?: string[] }) => {
    download(
      `/api/export${qs({ format: "bibtex", collectionId: opts.collectionId, paperIds: opts.paperIds?.join(",") })}`,
    );
  };

  const deleteCollection = async () => {
    if (!collection || !confirm(`Delete the collection “${collection.name}”? Papers stay in your library.`)) return;
    try {
      await api(`/api/collections/${collection.id}`, { method: "DELETE" });
      await invalidate();
      router.push("/library");
      toast.success("Collection deleted");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const title = collection
    ? collection.name
    : tag
      ? `#${tag.name}`
      : status === "all"
        ? "Library"
        : STATUS_LABEL[status];

  return (
    <div className="mx-auto flex max-w-6xl gap-8">
      <aside className="hidden w-52 shrink-0 lg:block" aria-label="Library filters">
        <div className="sticky top-20 space-y-5">
          <div>
            <p className="mb-1 px-2.5 text-xs font-medium tracking-wide text-subtle uppercase">Status</p>
            <FilterLink active={status === "all" && !collectionId && !tagId} href="/library" count={counts?.all}>
              <LibraryIcon className="size-4" aria-hidden />
              All papers
            </FilterLink>
            {READING_STATUSES.map((s) => (
              <FilterLink key={s} active={status === s} href={href({ status: s })} count={counts?.[s]}>
                {s === "archived" ? <Archive className="size-4" aria-hidden /> : <StatusDot status={s} />}
                {STATUS_LABEL[s]}
              </FilterLink>
            ))}
          </div>
          {!!tags?.length && (
            <div>
              <p className="mb-1 px-2.5 text-xs font-medium tracking-wide text-subtle uppercase">Tags</p>
              <div className="max-h-64 overflow-y-auto">
                {tags.map((t) => (
                  <FilterLink
                    key={t.id}
                    active={tagId === t.id}
                    href={href({ tag: tagId === t.id ? null : t.id })}
                    count={t.paperCount}
                  >
                    <TagIcon className="size-3.5" aria-hidden />
                    <span className="truncate">{t.name}</span>
                  </FilterLink>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1 space-y-4">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              {collection && (
                <FolderOpen className="size-5" style={{ color: collectionColor(collection) }} aria-hidden />
              )}
              <span className="truncate">{title}</span>
            </h1>
            {collection?.description && <p className="mt-1 text-sm text-muted">{collection.description}</p>}
            <p className="mt-1 text-sm text-subtle">
              {query.isLoading ? "Loading…" : `${total} paper${total === 1 ? "" : "s"}`}
            </p>
          </div>
          {collection && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setSharing(true)}>
                <Share2 />
                Share
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link href={`/graph?collectionId=${collection.id}`}>
                  <Network />
                  Graph
                </Link>
              </Button>
              <Button size="sm" variant="ai" asChild>
                <Link href={`/research?collection=${collection.id}`}>
                  <Telescope />
                  Ask AI
                </Link>
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" variant="ghost" aria-label="Collection actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => setEditing(true)}>
                    <Pencil />
                    Edit collection
                  </MenuItem>
                  <MenuItem onSelect={() => exportBibtex({ collectionId: collection.id })}>
                    <Download />
                    Export BibTeX
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem danger onSelect={deleteCollection}>
                    <Trash2 />
                    Delete collection
                  </MenuItem>
                </MenuContent>
              </Menu>
            </div>
          )}
        </header>

        {/* Mobile filters */}
        <div className="flex gap-2 overflow-x-auto lg:hidden">
          <Select
            aria-label="Status"
            value={status}
            onChange={(e) => router.push(href({ status: e.target.value === "all" ? null : e.target.value }))}
            className="h-8 w-36"
          >
            <option value="all">All papers</option>
            {READING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
          {!!tags?.length && (
            <Select
              aria-label="Tag"
              value={tagId ?? ""}
              onChange={(e) => router.push(href({ tag: e.target.value || null }))}
              className="h-8 w-36"
            >
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  #{t.name}
                </option>
              ))}
            </Select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
              aria-hidden
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by title, author, venue, abstract…"
              aria-label="Filter library"
              className="pl-9"
            />
          </div>
          <Select
            aria-label="Sort"
            value={sort}
            onChange={(e) => router.replace(href({ sort: e.target.value === "added_desc" ? null : e.target.value }))}
            className="w-48"
          >
            {SORTS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </Select>
          {(collectionId || tagId) && (
            <Button size="sm" variant="ghost" asChild>
              <Link href="/library">
                <X />
                Clear filter
              </Link>
            </Button>
          )}
        </div>

        {selected.size > 0 && (
          <div
            className="sticky top-16 z-10 flex flex-wrap items-center gap-1.5 rounded-xl border border-accent/30 bg-accent-soft px-3 py-2 shadow-sm"
            role="toolbar"
            aria-label="Bulk actions"
          >
            <span className="mr-2 text-sm font-medium">{selected.size} selected</span>
            <Menu>
              <MenuTrigger asChild>
                <Button size="sm" variant="secondary">
                  <BookmarkCheck />
                  Set status
                </Button>
              </MenuTrigger>
              <MenuContent align="start">
                {READING_STATUSES.map((s) => (
                  <MenuItem
                    key={s}
                    onSelect={() =>
                      bulk.mutate(
                        { action: "status", paperIds: selectedIds, status: s },
                        {
                          onSuccess: () => toast.success(`Marked ${selected.size} as ${STATUS_LABEL[s].toLowerCase()}`),
                        },
                      )
                    }
                  >
                    <StatusDot status={s} />
                    {STATUS_LABEL[s]}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
            <TagPicker
              paperIds={selectedIds}
              current={
                selectedItems.length
                  ? selectedItems[0].tags.filter((t) => selectedItems.every((i) => i.tags.some((x) => x.id === t.id)))
                  : []
              }
              trigger={
                <Button size="sm" variant="secondary">
                  <TagIcon />
                  Tag
                </Button>
              }
            />
            <CollectionPicker
              paperIds={selectedIds}
              current={
                selectedItems.length
                  ? selectedItems[0].collections.filter((c) =>
                      selectedItems.every((i) => i.collections.some((x) => x.id === c.id)),
                    )
                  : []
              }
              trigger={
                <Button size="sm" variant="secondary">
                  <FolderOpen />
                  Collection
                </Button>
              }
            />
            {collectionId && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  bulk.mutate(
                    { action: "uncollect", paperIds: selectedIds, collectionId },
                    { onSuccess: () => setSelected(new Set()) },
                  )
                }
              >
                <FolderMinus />
                Remove from collection
              </Button>
            )}
            <Button size="sm" variant="ai" asChild>
              <Link href={`/research?papers=${selectedIds.slice(0, 30).join(",")}`}>
                <Telescope />
                {selected.size > 1 ? "Compare with AI" : "Ask AI"}
              </Link>
            </Button>
            <Button size="sm" variant="secondary" onClick={() => exportBibtex({ paperIds: selectedIds })}>
              <Download />
              BibTeX
            </Button>
            <Button
              size="sm"
              variant="danger-ghost"
              onClick={() => {
                if (confirm(`Remove ${selected.size} paper(s) from your library? Notes and highlights are kept.`)) {
                  bulk.mutate({ action: "remove", paperIds: selectedIds }, { onSuccess: () => setSelected(new Set()) });
                }
              }}
            >
              <Trash2 />
              Remove
            </Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {query.isError && (
          <ErrorState title="Your library could not be loaded" error={query.error} onRetry={() => query.refetch()} />
        )}

        {query.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : items.length ? (
          <div className="rounded-xl border border-border bg-surface shadow-xs">
            <div className="flex items-center gap-3 border-b border-border px-3 py-2 md:px-4">
              <input
                type="checkbox"
                className="size-4 cursor-pointer accent-[var(--accent)]"
                checked={allSelected}
                onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())}
                aria-label="Select all loaded papers"
              />
              <span className="text-[13px] text-muted">Select all</span>
            </div>
            <ul className="stagger">
              {items.map((item) => (
                <LibraryRow
                  key={item.id}
                  item={item}
                  selected={selected.has(item.id)}
                  onSelect={(on) =>
                    setSelected((s) => {
                      const next = new Set(s);
                      if (on) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          </div>
        ) : hasFilters ? (
          <EmptyState
            icon={Search}
            title="No papers match"
            description={
              collection
                ? "This collection is empty. Add papers from search results, a paper page, or with bulk actions here in the library."
                : "Try a different filter or search term."
            }
            action={
              <Button asChild variant="secondary">
                <Link href="/library">Show all papers</Link>
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={LibraryIcon}
            title="Search for your first paper."
            description="Papers you save appear here, organized by reading status, tags and collections. You can also import a BibTeX file or a list of DOIs."
            action={
              <>
                <Button asChild variant="primary">
                  <Link href="/search">
                    <Search />
                    Find papers
                  </Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link href="/settings?tab=import">Import references</Link>
                </Button>
              </>
            }
          />
        )}

        {query.hasNextPage && (
          <div className="flex justify-center">
            <Button onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
              Load more
            </Button>
          </div>
        )}
      </div>

      {collection && (
        <>
          <CollectionDialog open={editing} onOpenChange={setEditing} collection={collection} />
          <ShareDialog
            open={sharing}
            onOpenChange={setSharing}
            resourceType="collection"
            resourceId={collection.id}
            title={collection.name}
          />
        </>
      )}
    </div>
  );
}
