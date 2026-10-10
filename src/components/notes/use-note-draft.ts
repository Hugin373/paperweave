"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JSONContent } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { NoteDetail } from "@/lib/types";

export type SaveState = "saved" | "unsaved" | "saving" | "error";

export const SAVE_LABEL: Record<SaveState, string> = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  error: "Not saved",
};

/**
 * Loads a note and autosaves edits (debounced), with optimistic-concurrency conflict detection
 * and a best-effort save when the page is closed or the component unmounts. Used by the full
 * note page and by the note panel in the PDF reader.
 */
export function useNoteDraft(id: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["note", id],
    queryFn: () => api<NoteDetail>(`/api/notes/${id}`),
  });
  const note = query.data;

  const [initialized, setInitialized] = useState<{ content: JSONContent; key: number } | null>(null);
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [conflict, setConflict] = useState(false);

  // Mutable save bookkeeping (not render state).
  const pending = useRef<{ title?: string; content?: JSONContent }>({});
  const version = useRef(0);
  const base = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const conflictRef = useRef(false);

  // Initialize the editable copy once, from the first server response (render-time adjustment).
  if (note && !initialized) {
    setInitialized({ content: note.content as JSONContent, key: 1 });
    setTitle(note.title);
  }
  useEffect(() => {
    if (note && base.current === null) base.current = note.updatedAt;
  }, [note]);

  const save = useCallback(async () => {
    if (inFlight.current) await inFlight.current;
    if (conflictRef.current) return;
    const body = pending.current;
    if (body.title === undefined && body.content === undefined) return;
    pending.current = {};
    const v = version.current;
    setSaveState("saving");
    const run = (async () => {
      try {
        const res = await api<{ updatedAt: string }>(`/api/notes/${id}`, {
          method: "PATCH",
          body: { ...body, baseUpdatedAt: base.current ?? undefined },
        });
        base.current = res.updatedAt;
        if (v === version.current) setSaveState("saved");
        void qc.invalidateQueries({ queryKey: ["note", id] });
        void qc.invalidateQueries({ queryKey: ["notes"] });
        void qc.invalidateQueries({ queryKey: ["paper"] });
      } catch (err) {
        // Keep the unsaved changes so the next attempt includes them.
        pending.current = { ...body, ...pending.current };
        if (err instanceof ApiError && err.status === 409) {
          conflictRef.current = true;
          setConflict(true);
        } else {
          toast.error(errorMessage(err, "Your note could not be saved."));
        }
        setSaveState("error");
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
  }, [id, qc]);

  const schedule = useCallback(
    (patch: { title?: string; content?: JSONContent }) => {
      pending.current = { ...pending.current, ...patch };
      version.current++;
      setSaveState("unsaved");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 800);
    },
    [save],
  );

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    await save();
  }, [save]);

  const changeTitle = useCallback(
    (value: string) => {
      setTitle(value);
      schedule({ title: value });
    },
    [schedule],
  );

  // Best-effort save when the page is closed (or this note is swapped out) with unsaved changes.
  useEffect(() => {
    const send = () => {
      const body = pending.current;
      if ((body.title === undefined && body.content === undefined) || conflictRef.current) return;
      pending.current = {};
      fetch(`/api/notes/${id}`, {
        method: "PATCH",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, baseUpdatedAt: base.current ?? undefined }),
      }).catch(() => {});
    };
    window.addEventListener("beforeunload", send);
    return () => {
      window.removeEventListener("beforeunload", send);
      if (timer.current) clearTimeout(timer.current);
      send();
    };
  }, [id]);

  /** Discards local edits and loads the latest server version (after a conflict). */
  const reload = useCallback(async () => {
    conflictRef.current = false;
    pending.current = {};
    setConflict(false);
    setSaveState("saved");
    const { data } = await query.refetch();
    if (data) {
      setInitialized((prev) => ({ content: data.content as JSONContent, key: (prev?.key ?? 0) + 1 }));
      setTitle(data.title);
      base.current = data.updatedAt;
    }
  }, [query]);

  /** Applies a server-side change made outside the editor (e.g. attaching the note to a paper). */
  const acceptServerVersion = useCallback((updatedAt: string) => {
    base.current = updatedAt;
  }, []);

  /** Stops autosaving (used before deleting the note). */
  const cancelPending = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    pending.current = {};
  }, []);

  const editable = note?.access === "owner" || note?.access === "edit";

  return {
    query,
    note,
    initialized,
    title,
    changeTitle,
    schedule,
    flush,
    saveState,
    conflict,
    reload,
    acceptServerVersion,
    cancelPending,
    editable,
  };
}
