"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { useDebounced } from "@/lib/hooks";
import { fetchLinkTargets, type LinkTarget, type LinkTargetType } from "./link-targets";
import { TypeIcon } from "./type-icon";

/**
 * Popover that searches the workspace for papers (library), concepts or notes and reports
 * the chosen one. Used to set a note's paper, link papers to concepts, relate concepts.
 */
export function TargetPicker({
  types,
  onSelect,
  trigger,
  placeholder = "Search…",
  exclude = [],
  emptyHint,
}: {
  types: LinkTargetType[];
  onSelect: (target: LinkTarget) => void;
  trigger: ReactNode;
  placeholder?: string;
  exclude?: string[];
  emptyHint?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 200);
  const { data, isFetching } = useQuery({
    queryKey: ["link-targets", types.join(","), debounced],
    queryFn: () => fetchLinkTargets(debounced, { types }),
    enabled: open,
  });
  const items = (data ?? []).filter((t) => !exclude.includes(t.id));

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-80 p-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-8"
          autoFocus
        />
        <div className="mt-2 max-h-64 overflow-y-auto" role="listbox">
          {isFetching && !items.length && (
            <div className="p-2">
              <Spinner label="Searching…" />
            </div>
          )}
          {!isFetching && !items.length && (
            <p className="px-2 py-2 text-[13px] text-muted">{emptyHint ?? "No matches."}</p>
          )}
          {items.map((t) => (
            <button
              key={`${t.type}:${t.id}`}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                onSelect(t);
                setOpen(false);
                setQ("");
              }}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
            >
              <TypeIcon type={t.type} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 font-medium">{t.label}</span>
                {t.detail && <span className="block truncate text-[12px] text-muted">{t.detail}</span>}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
