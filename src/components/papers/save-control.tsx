"use client";

import { Archive, BookmarkPlus, Check, ChevronDown, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { STATUS_LABEL } from "@/lib/format";
import { useRemoveFromLibrary, useSetStatus } from "@/lib/mutations";
import { READING_STATUSES, type LibraryState } from "@/lib/types";

const DOT: Record<string, string> = {
  saved: "bg-subtle",
  reading: "bg-warning",
  read: "bg-success",
  archived: "bg-border-strong",
};

export function StatusDot({ status, pop }: { status: string; pop?: boolean }) {
  return <span className={cn("inline-block size-2 rounded-full", DOT[status], pop && "animate-pop")} aria-hidden />;
}

/** "Save" for unsaved papers; a reading-status menu for saved ones. */
export function SaveControl({
  paperId,
  library,
  size = "sm",
}: {
  paperId: string;
  library: LibraryState | null;
  size?: "sm" | "md";
}) {
  const setStatus = useSetStatus();
  const remove = useRemoveFromLibrary();

  if (!library) {
    return (
      <Button
        size={size}
        variant="primary"
        loading={setStatus.isPending}
        onClick={() => setStatus.mutate({ paperId, status: "saved" })}
      >
        <BookmarkPlus />
        Save
      </Button>
    );
  }

  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          size={size}
          variant="secondary"
          loading={setStatus.isPending || remove.isPending}
          aria-label={`Reading status: ${STATUS_LABEL[library.status]}`}
        >
          {/* Re-mounted on change, so the dot pops when the status changes (e.g. right after saving). */}
          <StatusDot key={library.status} status={library.status} pop />
          {STATUS_LABEL[library.status]}
          <ChevronDown className="text-subtle" />
        </Button>
      </MenuTrigger>
      <MenuContent align="start">
        {READING_STATUSES.map((s) => (
          <MenuItem key={s} onSelect={() => s !== library.status && setStatus.mutate({ paperId, status: s })}>
            {s === "archived" ? <Archive /> : <StatusDot status={s} />}
            <span className="flex-1">{STATUS_LABEL[s]}</span>
            {s === library.status && <Check className="!text-accent" />}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem danger onSelect={() => remove.mutate(paperId)}>
          <Trash2 />
          Remove from library
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
