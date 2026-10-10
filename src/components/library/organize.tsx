"use client";

import { Check, FolderPlus, Plus, Tag as TagIcon, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { useCollections, useTags } from "@/lib/hooks";
import { useBulk } from "@/lib/mutations";
import type { CollectionRef, TagRef } from "@/lib/types";
import { CollectionDialog } from "./collection-dialog";

export function TagChip({ tag, onRemove }: { tag: TagRef; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[12px] text-muted">
      <Link href={`/library?tag=${tag.id}`} className="hover:text-text">
        #{tag.name}
      </Link>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="rounded hover:text-danger"
          aria-label={`Remove tag ${tag.name}`}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

/** Popover to add/remove tags on one or more papers (creates tags on the fly). */
export function TagPicker({
  paperIds,
  current,
  trigger,
}: {
  paperIds: string[];
  current: TagRef[];
  trigger?: React.ReactNode;
}) {
  const { data: tags } = useTags();
  const bulk = useBulk();
  const [q, setQ] = useState("");
  const currentIds = new Set(current.map((t) => t.id));
  const term = q.trim().toLowerCase();
  const matches = (tags ?? []).filter((t) => !term || t.name.toLowerCase().includes(term));
  const exact = (tags ?? []).some((t) => t.name.toLowerCase() === term);

  return (
    <Popover onOpenChange={(o) => !o && setQ("")}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="ghost">
            <TagIcon />
            Tags
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (term && !exact) {
              bulk.mutate({ action: "tag", paperIds, tagNames: [q.trim()] });
              setQ("");
            }
          }}
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find or create a tag…"
            className="h-8"
            aria-label="Tag name"
            autoFocus
          />
        </form>
        <div className="mt-2 max-h-56 overflow-y-auto">
          {matches.map((t) => {
            const on = currentIds.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  bulk.mutate(
                    on ? { action: "untag", paperIds, tagIds: [t.id] } : { action: "tag", paperIds, tagIds: [t.id] },
                  )
                }
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                aria-pressed={on}
              >
                <span className="flex size-4 items-center justify-center">
                  {on && <Check className="size-3.5 text-accent" />}
                </span>
                <span className="flex-1 truncate">#{t.name}</span>
                <span className="text-[11px] text-subtle">{t.paperCount}</span>
              </button>
            );
          })}
          {term && !exact && (
            <button
              type="button"
              onClick={() => {
                bulk.mutate({ action: "tag", paperIds, tagNames: [q.trim()] });
                setQ("");
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-accent-text hover:bg-surface-2"
            >
              <Plus className="size-3.5" />
              Create “{q.trim()}”
            </button>
          )}
          {!matches.length && !term && (
            <p className="px-2 py-2 text-[13px] text-muted">Type to create your first tag.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Popover to add/remove papers to/from collections. */
export function CollectionPicker({
  paperIds,
  current,
  trigger,
}: {
  paperIds: string[];
  current: CollectionRef[];
  trigger?: React.ReactNode;
}) {
  const { data: collections } = useCollections();
  const bulk = useBulk();
  const [creating, setCreating] = useState(false);
  const currentIds = new Set(current.map((c) => c.id));
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          {trigger ?? (
            <Button size="sm" variant="ghost">
              <FolderPlus />
              Collections
            </Button>
          )}
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2">
          <p className="px-2 pb-1 text-xs font-medium text-subtle">Add to collection</p>
          <div className="max-h-56 overflow-y-auto">
            {(collections ?? []).map((c) => {
              const on = currentIds.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => bulk.mutate({ action: on ? "uncollect" : "collect", paperIds, collectionId: c.id })}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                  aria-pressed={on}
                >
                  <span className="flex size-4 items-center justify-center">
                    {on && <Check className="size-3.5 text-accent" />}
                  </span>
                  <span
                    className="size-2 rounded-full"
                    style={{ background: c.color ?? "var(--subtle)" }}
                    aria-hidden
                  />
                  <span className="flex-1 truncate">{c.name}</span>
                </button>
              );
            })}
            {!collections?.length && <p className="px-2 py-1.5 text-[13px] text-muted">No collections yet.</p>}
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-border px-2 pt-2 pb-1 text-left text-sm text-accent-text hover:bg-surface-2"
          >
            <Plus className="size-3.5" />
            New collection
          </button>
        </PopoverContent>
      </Popover>
      <CollectionDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => bulk.mutate({ action: "collect", paperIds, collectionId: id })}
      />
    </>
  );
}
