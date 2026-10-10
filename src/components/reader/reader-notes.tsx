"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { Editor, JSONContent } from "@tiptap/react";
import { AlertTriangle, ExternalLink, NotebookPen, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { NoteEditor } from "@/components/notes/note-editor";
import { SAVE_LABEL, useNoteDraft } from "@/components/notes/use-note-draft";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/states";
import { api, errorMessage } from "@/lib/api";
import type { NoteSummary } from "@/lib/types";

/** A passage the reader asked to add to the current note. `nonce` makes each request unique. */
export interface QuoteRequest {
  text: string;
  pageNumber: number;
  nonce: number;
}

const storageKey = (paperId: string) => `pw-reader-note:${paperId}`;

function readStoredNote(paperId: string) {
  try {
    return typeof window === "undefined" ? null : localStorage.getItem(storageKey(paperId));
  } catch {
    return null;
  }
}

function quoteContent(q: QuoteRequest): JSONContent[] {
  return [
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: q.text.replace(/\s+/g, " ").trim() },
            { type: "text", text: ` (p. ${q.pageNumber})`, marks: [{ type: "italic" }] },
          ],
        },
      ],
    },
    { type: "paragraph" },
  ];
}

function ActiveNote({
  id,
  notes,
  quote,
  consumeQuote,
  onSwitch,
  onCreate,
  creating,
}: {
  id: string;
  notes: NoteSummary[];
  quote: QuoteRequest | null;
  consumeQuote: (nonce: number) => boolean;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  const qc = useQueryClient();
  const { query, note, initialized, title, changeTitle, schedule, saveState, conflict, reload, editable } =
    useNoteDraft(id);
  const [editor, setEditor] = useState<Editor | null>(null);

  // Insert a quoted passage at the end of the note once the editor is ready.
  useEffect(() => {
    if (!editor || !quote || !editable || conflict || !consumeQuote(quote.nonce)) return;
    editor.chain().focus("end").insertContent(quoteContent(quote)).run();
    editor.view.dom.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [editor, quote, editable, conflict, consumeQuote]);

  const onConceptCreated = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["concepts"] });
  }, [qc]);

  // Links open in a new tab so the paper stays open.
  const onOpenLink = useCallback((href: string) => {
    window.open(href, "_blank", "noopener");
  }, []);

  if (query.isLoading) return <Spinner label="Loading note…" />;
  if (query.error || !note) {
    return <ErrorState title="This note could not be opened" error={query.error} onRetry={() => query.refetch()} />;
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {notes.length > 1 ? (
          <Select
            aria-label="Choose a note on this paper"
            value={id}
            onChange={(e) => onSwitch(e.target.value)}
            className="h-8 min-w-0 flex-1 text-[13px]"
          >
            {notes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.id === id ? title || "Untitled note" : n.title}
              </option>
            ))}
          </Select>
        ) : (
          <span className="flex-1 text-[12px] text-subtle" role="status" aria-live="polite">
            {editable ? SAVE_LABEL[saveState] : "View only"}
          </span>
        )}
        <Tooltip content="New note on this paper">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onCreate}
            loading={creating}
            aria-label="New note on this paper"
          >
            <Plus />
          </Button>
        </Tooltip>
        <Tooltip content="Open as a full page (new tab)">
          <Button asChild size="icon-sm" variant="ghost" aria-label="Open note as a full page">
            <Link href={`/notes/${id}`} target="_blank" rel="noopener">
              <ExternalLink />
            </Link>
          </Button>
        </Tooltip>
      </div>
      {notes.length > 1 && editable && (
        <span className="text-[12px] text-subtle" role="status" aria-live="polite">
          {SAVE_LABEL[saveState]}
        </span>
      )}
      {conflict && (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-warning-soft px-2.5 py-2 text-[12.5px]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span className="flex-1">This note was changed elsewhere. Your latest edits were not saved.</span>
          <Button size="sm" className="h-6 px-2 text-[12px]" onClick={reload}>
            Reload
          </Button>
        </div>
      )}
      <label htmlFor={`reader-note-title-${id}`} className="sr-only">
        Note title
      </label>
      <textarea
        id={`reader-note-title-${id}`}
        value={title}
        readOnly={!editable}
        rows={1}
        // Wraps onto new lines and grows with the title (it stays one paragraph: Enter moves to the content).
        onChange={(e) => changeTitle(e.target.value.replace(/\n/g, " "))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (editor) {
              editor.view.focus();
              editor.commands.setTextSelection(1);
            }
          }
        }}
        placeholder="Untitled"
        maxLength={300}
        className="block field-sizing-content w-full resize-none overflow-hidden bg-transparent pl-12 text-xl leading-snug font-bold tracking-tight break-words outline-none placeholder:text-subtle/60 focus-visible:outline-none"
      />
      {initialized && (
        <NoteEditor
          key={initialized.key}
          noteId={note.id}
          content={initialized.content}
          editable={editable && !conflict}
          onChange={(content) => schedule({ content })}
          onReady={setEditor}
          onOpenLink={onOpenLink}
          onConceptCreated={onConceptCreated}
          compact
        />
      )}
      <p className="text-[11.5px] text-subtle">
        Tip: select text in the PDF and choose <strong>Add to note</strong> to quote it with its page number. Type{" "}
        <kbd className="rounded border border-border px-1">[[</kbd> to link concepts, papers or notes.
      </p>
    </div>
  );
}

/**
 * The paper's notes, editable next to the PDF. Opens the most recently used note; a note is
 * created on demand (also when a passage is quoted and no note exists yet).
 */
export function ReaderNotes({
  paperId,
  paperTitle,
  notes,
  quote,
}: {
  paperId: string;
  paperTitle: string;
  notes: NoteSummary[];
  quote: QuoteRequest | null;
}) {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<string | null>(() => readStoredNote(paperId));
  const [created, setCreated] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const handledQuotes = useRef(new Set<number>());

  const known = (id: string | null) => !!id && (id === created || notes.some((n) => n.id === id));
  const activeId = known(chosen) ? chosen : (notes[0]?.id ?? created);

  const choose = useCallback(
    (id: string) => {
      setChosen(id);
      try {
        localStorage.setItem(storageKey(paperId), id);
      } catch {
        /* storage unavailable */
      }
    },
    [paperId],
  );

  const consumeQuote = useCallback((nonce: number) => {
    if (handledQuotes.current.has(nonce)) return false;
    handledQuotes.current.add(nonce);
    return true;
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    try {
      const { id } = await api<{ id: string }>("/api/notes", {
        body: { paperId, title: `Notes on ${paperTitle}`.slice(0, 300) },
      });
      setCreated(id);
      choose(id);
      await qc.invalidateQueries({ queryKey: ["paper", paperId] });
      void qc.invalidateQueries({ queryKey: ["notes"] });
    } catch (err) {
      toast.error(errorMessage(err, "The note could not be created."));
    } finally {
      setCreating(false);
    }
  }, [paperId, paperTitle, qc, choose]);

  // Quoting a passage when the paper has no note yet starts one.
  const startedForQuote = useRef<number | null>(null);
  useEffect(() => {
    if (!quote || activeId || creating || startedForQuote.current === quote.nonce) return;
    startedForQuote.current = quote.nonce;
    void create();
  }, [quote, activeId, creating, create]);

  if (!activeId) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-8 text-center">
        <NotebookPen className="size-6 text-muted" aria-hidden />
        <div>
          <p className="text-sm font-medium">Write notes while you read</p>
          <p className="mt-1 text-[12.5px] text-muted">
            Your note stays next to the PDF, is saved automatically, and appears on the paper page and in your graph.
          </p>
        </div>
        <Button variant="primary" onClick={() => void create()} loading={creating}>
          <Plus />
          Start a note on this paper
        </Button>
      </div>
    );
  }

  const list = notes.some((n) => n.id === activeId)
    ? notes
    : [
        { id: activeId, title: "New note", excerpt: "", paperId, paperTitle, updatedAt: new Date().toISOString() },
        ...notes,
      ];

  return (
    <ActiveNote
      key={activeId}
      id={activeId}
      notes={list}
      quote={quote}
      consumeQuote={consumeQuote}
      onSwitch={choose}
      onCreate={() => void create()}
      creating={creating}
    />
  );
}
