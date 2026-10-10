"use client";

import {
  ChevronRight,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Lightbulb,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Table,
  Type,
  type LucideIcon,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { BlockCommand, BlockIcon } from "./slash-command";

export const BLOCK_ICONS: Record<BlockIcon, LucideIcon> = {
  text: Type,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  bullet: List,
  numbered: ListOrdered,
  todo: ListChecks,
  quote: Quote,
  callout: Lightbulb,
  toggle: ChevronRight,
  code: Code,
  divider: Minus,
  table: Table,
  link: Link2,
};

export interface SlashMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/** Keyboard-navigable block menu shown when typing "/". */
export const SlashMenu = forwardRef<SlashMenuHandle, { items: BlockCommand[]; command: (c: BlockCommand) => void }>(
  function SlashMenu({ items, command }, ref) {
    const [index, setIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // Reset the highlighted row whenever the filtered list changes (render-time adjustment).
    const [prevItems, setPrevItems] = useState(items);
    if (prevItems !== items) {
      setPrevItems(items);
      setIndex(0);
    }

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

    if (!items.length) {
      return (
        <div className="z-50 w-72 rounded-lg border border-border bg-surface p-3 text-[13px] text-muted shadow-lg">
          No matching blocks
        </div>
      );
    }

    let lastGroup = "";
    return (
      <div
        ref={listRef}
        role="listbox"
        aria-label="Insert a block"
        className="z-50 max-h-80 w-72 overflow-y-auto rounded-lg border border-border bg-surface p-1 text-sm shadow-lg"
      >
        {items.map((item, i) => {
          const Icon = BLOCK_ICONS[item.icon];
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.id}>
              {header && <p className="px-2 pt-2 pb-1 text-[11px] font-medium text-subtle">{header}</p>}
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                data-index={i}
                onMouseEnter={() => setIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => command(item)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                  i === index ? "bg-surface-2" : "hover:bg-surface-2",
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface">
                  <Icon className="size-4 text-muted" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{item.title}</span>
                  <span className="block truncate text-[12px] text-muted">{item.description}</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    );
  },
);
