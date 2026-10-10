"use client";

import { Plus } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { TYPE_LABEL, type LinkTarget } from "./link-targets";
import { TypeIcon } from "./type-icon";

export type MentionItem = LinkTarget | { type: "create"; label: string };

export interface MentionListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface Props {
  items: MentionItem[];
  query: string;
  loading?: boolean;
  command: (item: MentionItem) => void;
}

/** Keyboard-navigable popup listing link targets for [[ / @ in the note editor. */
export const MentionList = forwardRef<MentionListHandle, Props>(function MentionList(
  { items, query, loading, command },
  ref,
) {
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setIndex(0), [items]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") {
        setIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setIndex((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[index];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Link to a paper, concept or note"
      className="z-50 max-h-72 w-80 overflow-y-auto rounded-lg border border-border bg-surface p-1 text-sm shadow-lg"
    >
      {loading && !items.length && (
        <div className="px-2 py-2">
          <Spinner label="Searching…" />
        </div>
      )}
      {!loading && !items.length && (
        <p className="px-2 py-2 text-[13px] text-muted">
          {query ? "No matches in your workspace." : "Type to search papers, concepts and notes."}
        </p>
      )}
      {items.map((item, i) => (
        <button
          key={item.type === "create" ? "create" : `${item.type}:${item.id}`}
          type="button"
          role="option"
          aria-selected={i === index}
          data-index={i}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => command(item)}
          className={cn(
            "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left",
            i === index ? "bg-surface-2" : "hover:bg-surface-2",
          )}
        >
          {item.type === "create" ? (
            <>
              <Plus className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
              <span className="text-accent-text">
                Create concept “<span className="font-medium">{item.label}</span>”
              </span>
            </>
          ) : (
            <>
              <TypeIcon type={item.type} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.label}</span>
                <span className="block truncate text-[12px] text-muted">
                  {TYPE_LABEL[item.type]}
                  {item.detail ? ` · ${item.detail}` : ""}
                </span>
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  );
});
