"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  Eye,
  MoreHorizontal,
  Network,
  Share2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ShareDialog } from "@/components/sharing/share-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { PageLoading } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/states";
import { api, errorMessage } from "@/lib/api";
import { docToMarkdown, type PMNode } from "@/lib/prosemirror";
import { NoteAiPanel } from "./note-ai-panel";
import { NoteEditor } from "./note-editor";
import { Backlinks, NoteProperties } from "./note-sidebar";
import { SAVE_LABEL, useNoteDraft } from "./use-note-draft";

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function NotePage({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const {
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
  } = useNoteDraft(id);
  const { error, isLoading, refetch } = query;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const onOpenLink = useCallback(
    async (href: string, newTab: boolean) => {
      if (newTab) {
        window.open(href, "_blank", "noopener");
        return;
      }
      await flush();
      router.push(href);
    },
    [flush, router],
  );

  const onConceptCreated = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["concepts"] });
  }, [qc]);

  const setPaper = async (paperId: string | null) => {
    await flush();
    try {
      const res = await api<{ updatedAt: string }>(`/api/notes/${id}`, { method: "PATCH", body: { paperId } });
      acceptServerVersion(res.updatedAt);
      await qc.invalidateQueries({ queryKey: ["note", id] });
      void qc.invalidateQueries({ queryKey: ["notes"] });
      toast.success(paperId ? "Note attached to paper" : "Note is now standalone");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    try {
      cancelPending();
      await api(`/api/notes/${id}`, { method: "DELETE" });
      void qc.invalidateQueries({ queryKey: ["notes"] });
      toast.success("Note deleted");
      router.push("/notes");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const exportMarkdown = () => {
    const doc = (editor?.getJSON() ?? note?.content) as PMNode;
    const name =
      (title || "Untitled note")
        .replace(/[\\/:*?"<>|]/g, " ")
        .trim()
        .slice(0, 100) || "note";
    download(`${name}.md`, `# ${title || "Untitled note"}\n\n${docToMarkdown(doc)}`);
  };

  if (isLoading) return <PageLoading label="Loading note…" />;
  if (error || !note) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState title="This note could not be opened" error={error} onRetry={() => refetch()} />
        <Link href="/notes" className="mt-4 inline-block text-sm text-accent-text hover:underline">
          Back to notes
        </Link>
      </div>
    );
  }

  const isOwner = note.access === "owner";
  const stateLabel = SAVE_LABEL[saveState];

  return (
    <div className="mx-auto max-w-[52rem]">
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm text-muted">
          <Link
            href="/notes"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-2 hover:text-text"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Notes
          </Link>
          <span aria-hidden>/</span>
          <span className="truncate px-1 text-text">{title || "Untitled"}</span>
        </nav>
        {editable && (
          <span className="text-[12.5px] text-subtle" role="status" aria-live="polite">
            {stateLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {editable && (
            <Button
              size="sm"
              variant={aiOpen ? "ai" : "ghost"}
              onClick={() => setAiOpen((o) => !o)}
              aria-pressed={aiOpen}
            >
              <Sparkles />
              <span className="hidden sm:inline">AI</span>
            </Button>
          )}
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/graph?focus=note:${note.id}`}>
              <Network />
              <span className="hidden sm:inline">Graph</span>
            </Link>
          </Button>
          {isOwner && (
            <Button size="sm" variant="ghost" onClick={() => setShareOpen(true)}>
              <Share2 />
              Share
            </Button>
          )}
          <Menu>
            <MenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label="More note actions">
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={exportMarkdown}>
                <Download />
                Export as Markdown
              </MenuItem>
              {isOwner && (
                <>
                  <MenuSeparator />
                  <MenuItem danger onSelect={() => setConfirmDelete(true)}>
                    <Trash2 />
                    Delete note
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        </div>
      </div>

      {note.access === "view" && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
          <Eye className="size-4" aria-hidden />
          Shared by {note.ownerName ?? "another user"} · view only
        </div>
      )}
      {note.access === "edit" && !isOwner && (
        <div className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
          Shared by {note.ownerName ?? "another user"} · you can edit
        </div>
      )}
      {conflict && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm"
        >
          <AlertTriangle className="size-4 text-warning" aria-hidden />
          <span className="flex-1">
            This note was changed elsewhere since you opened it. Your latest edits were not saved.
          </span>
          <Button size="sm" onClick={reload}>
            Reload latest version
          </Button>
        </div>
      )}

      {/* The page: title, properties, content, backlinks — aligned with the editor's text column. */}
      <article className="pl-14">
        <label htmlFor="note-title" className="sr-only">
          Note title
        </label>
        <textarea
          id="note-title"
          value={title}
          readOnly={!editable}
          rows={1}
          ref={(el) => {
            // Grow with the title (fallback for browsers without field-sizing).
            if (el) {
              el.style.height = "auto";
              el.style.height = `${el.scrollHeight}px`;
            }
          }}
          onChange={(e) => changeTitle(e.target.value.replace(/\n/g, " "))}
          onKeyDown={(e) => {
            // Enter moves into the content, like Notion.
            if (e.key === "Enter") {
              e.preventDefault();
              // Focus synchronously so the next keystrokes land in the content.
              if (editor) {
                editor.view.focus();
                editor.commands.setTextSelection(1);
              }
            }
          }}
          placeholder="Untitled"
          maxLength={300}
          className="mb-3 field-sizing-content w-full resize-none bg-transparent text-[2.5rem] leading-tight font-bold tracking-tight outline-none placeholder:text-subtle/60 focus-visible:outline-none"
        />
        <NoteProperties note={note} canChange={isOwner} onChangePaper={setPaper} />
      </article>
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
        />
      )}
      {isOwner && (
        <div className="pl-14">
          <Backlinks note={note} />
        </div>
      )}

      {aiOpen && editable && (
        <aside
          aria-label="AI assist"
          className="fixed inset-y-0 right-0 z-40 w-[min(24rem,92vw)] overflow-y-auto border-l border-border bg-bg p-4 shadow-2xl"
        >
          <div className="mb-2 flex justify-end">
            <Button size="icon-sm" variant="ghost" onClick={() => setAiOpen(false)} aria-label="Close AI assist">
              <X />
            </Button>
          </div>
          <NoteAiPanel editor={editor} />
        </aside>
      )}

      {isOwner && (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          resourceType="note"
          resourceId={note.id}
          title={title}
        />
      )}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title="Delete this note?"
          description="Links from other notes to it will be removed. This cannot be undone."
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove}>
              Delete note
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
