"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Eye,
  Lightbulb,
  Link2,
  MoreHorizontal,
  Network,
  NotebookPen,
  Pencil,
  Plus,
  Share2,
  Sparkles,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { TargetPicker } from "@/components/notes/target-picker";
import { SidePanel } from "@/components/notes/note-sidebar";
import { PaperCard } from "@/components/papers/paper-card";
import { ShareDialog } from "@/components/sharing/share-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { PageLoading } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { ConceptDetail } from "@/lib/types";

export function ConceptPage({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const {
    data: c,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["concept", id],
    queryFn: () => api<ConceptDetail>(`/api/concepts/${id}`),
  });
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aliasDraft, setAliasDraft] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset local drafts whenever fresh server data arrives (render-time state adjustment).
  const [synced, setSynced] = useState<ConceptDetail | undefined>(undefined);
  if (c && c !== synced) {
    // Only overwrite a draft when the server value itself changed (keeps unsaved edits).
    if (!synced || synced.name !== c.name) setName(c.name);
    if (!synced || synced.description !== c.description) setDescription(c.description);
    setSynced(c);
  }

  const invalidate = () =>
    Promise.all(["concept", "concepts", "graph", "paper"].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  const update = useMutation({
    mutationFn: (patch: { name?: string; description?: string; aliases?: string[] }) =>
      api(`/api/concepts/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const paperLink = useMutation({
    mutationFn: ({ paperId, link }: { paperId: string; link: boolean }) =>
      api(`/api/concepts/${id}/papers`, { method: link ? "POST" : "DELETE", body: { paperId } }),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const relate = useMutation({
    mutationFn: ({ conceptId, related }: { conceptId: string; related: boolean }) =>
      api(`/api/concepts/${id}/related`, { method: related ? "POST" : "DELETE", body: { conceptId } }),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const newNote = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/notes", {
        body: {
          title: `Notes on ${c!.name}`,
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "mention", attrs: { id: `concept:${id}`, label: c!.name } },
                  { type: "text", text: " " },
                ],
              },
            ],
          },
        },
      }),
    onSuccess: (n) => {
      void invalidate();
      router.push(`/notes/${n.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = async () => {
    try {
      await api(`/api/concepts/${id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["concepts"] });
      toast.success("Concept deleted");
      router.push("/concepts");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (isLoading) return <PageLoading label="Loading concept…" />;
  if (error || !c) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState title="This concept could not be opened" error={error} onRetry={() => refetch()} />
        <Link href="/concepts" className="mt-4 inline-block text-sm text-accent-text hover:underline">
          Back to concepts
        </Link>
      </div>
    );
  }

  const isOwner = c.access === "owner";
  const canEdit = c.access !== "view";

  const addAlias = () => {
    const a = aliasDraft.trim();
    if (!a || c.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) return setAliasDraft("");
    update.mutate({ aliases: [...c.aliases, a] });
    setAliasDraft("");
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/concepts">
            <ArrowLeft />
            Concepts
          </Link>
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/graph?focus=concept:${c.id}`}>
              <Network />
              <span className="hidden sm:inline">View in graph</span>
            </Link>
          </Button>
          {isOwner && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setShareOpen(true)}>
                <Share2 />
                Share
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" variant="ghost" aria-label="More concept actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem danger onSelect={() => setConfirmDelete(true)}>
                    <Trash2 />
                    Delete concept
                  </MenuItem>
                </MenuContent>
              </Menu>
            </>
          )}
        </div>
      </div>

      {c.access === "view" && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
          <Eye className="size-4" aria-hidden />
          Shared with you · view only
        </div>
      )}

      <header className="mb-6">
        <div className="flex items-start gap-3">
          <span className="mt-1.5 rounded-lg bg-surface-2 p-2">
            <Lightbulb className="size-5 text-[var(--node-concept)]" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            {editingName ? (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim() && name.trim() !== c.name) update.mutate({ name: name.trim() });
                  setEditingName(false);
                }}
              >
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Concept name"
                  className="h-10 text-lg"
                  autoFocus
                  maxLength={120}
                />
                <Button type="submit" variant="primary">
                  Save
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setName(c.name);
                    setEditingName(false);
                  }}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
                {isOwner && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setEditingName(true)}
                    aria-label="Rename concept"
                  >
                    <Pencil />
                  </Button>
                )}
                {c.origin === "ai_suggestion" && (
                  <Badge tone="ai" title="Created by accepting an AI suggestion">
                    <Sparkles aria-hidden />
                    AI-suggested
                  </Badge>
                )}
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {c.aliases.map((a) => (
                <span
                  key={a}
                  className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[12.5px] text-muted"
                >
                  {a}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => update.mutate({ aliases: c.aliases.filter((x) => x !== a) })}
                      aria-label={`Remove alias ${a}`}
                      className="hover:text-danger"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
              {canEdit && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    addAlias();
                  }}
                >
                  <Input
                    value={aliasDraft}
                    onChange={(e) => setAliasDraft(e.target.value)}
                    onBlur={addAlias}
                    placeholder="+ alias"
                    aria-label="Add alias"
                    className="h-7 w-28 text-[12.5px]"
                  />
                </form>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="concept-description">
            <h2 id="concept-description" className="mb-2 text-sm font-semibold">
              Description
            </h2>
            {canEdit ? (
              <div className="space-y-2">
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  placeholder="Your definition or current understanding of this concept…"
                  aria-label="Concept description"
                />
                {description !== c.description && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      loading={update.isPending}
                      onClick={() => update.mutate({ description })}
                    >
                      Save description
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDescription(c.description)}>
                      Discard
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm whitespace-pre-wrap text-text/85">
                {c.description || <span className="text-muted italic">No description.</span>}
              </p>
            )}
          </section>

          <section aria-labelledby="concept-papers">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 id="concept-papers" className="text-sm font-semibold">
                Papers · {c.papers.length}
              </h2>
              {isOwner && (
                <TargetPicker
                  types={["paper"]}
                  placeholder="Search your library…"
                  emptyHint="No matching papers in your library. Save papers from Search first."
                  exclude={c.papers.map((p) => p.id)}
                  onSelect={(t) => paperLink.mutate({ paperId: t.id, link: true })}
                  trigger={
                    <Button size="sm" variant="secondary">
                      <Link2 />
                      Link a paper
                    </Button>
                  }
                />
              )}
            </div>
            {c.papers.length ? (
              <div className="space-y-2">
                {c.papers.map((p) => (
                  <PaperCard
                    key={p.id}
                    paper={p}
                    dense
                    actions={
                      isOwner ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => paperLink.mutate({ paperId: p.id, link: false })}
                          aria-label={`Unlink ${p.title}`}
                        >
                          <Unlink />
                          Unlink
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                className="py-8"
                title="No papers linked yet"
                description="Link papers that introduce, use or discuss this concept."
              />
            )}
          </section>
        </div>

        <aside className="space-y-4" aria-label="Concept connections">
          {isOwner && (
            <SidePanel
              title={`Notes · ${c.notes.length}`}
              action={
                <Button size="sm" variant="ghost" loading={newNote.isPending} onClick={() => newNote.mutate()}>
                  <Plus />
                  New note
                </Button>
              }
            >
              {c.notes.length ? (
                <ul className="space-y-0.5">
                  {c.notes.map((n) => (
                    <li key={n.id}>
                      <Link
                        href={`/notes/${n.id}`}
                        className="flex items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-surface-2"
                      >
                        <NotebookPen className="mt-0.5 size-4 shrink-0 text-[var(--node-note)]" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2">{n.title}</span>
                          <span className="block text-[12px] text-muted">{relativeTime(n.updatedAt)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">
                  No notes mention this concept yet. Type [[{c.name}]] in any note to link it.
                </p>
              )}
            </SidePanel>
          )}
          {isOwner && (
            <SidePanel
              title="Related concepts"
              action={
                <TargetPicker
                  types={["concept"]}
                  placeholder="Search concepts…"
                  exclude={[c.id, ...c.related.map((r) => r.id)]}
                  emptyHint="No other matching concepts."
                  onSelect={(t) => relate.mutate({ conceptId: t.id, related: true })}
                  trigger={
                    <Button size="sm" variant="ghost">
                      <Plus />
                      Add
                    </Button>
                  }
                />
              }
            >
              {c.related.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {c.related.map((r) => (
                    <span
                      key={r.id}
                      className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-[13px]"
                    >
                      <Link href={`/concepts/${r.id}`} className="hover:text-accent-text">
                        {r.name}
                      </Link>
                      <button
                        type="button"
                        onClick={() => relate.mutate({ conceptId: r.id, related: false })}
                        aria-label={`Remove relation to ${r.name}`}
                        className="text-subtle hover:text-danger"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-muted">
                  Connect concepts that belong together, e.g. “metric depth” ↔ “ordinal depth”.
                </p>
              )}
            </SidePanel>
          )}
        </aside>
      </div>

      {isOwner && (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          resourceType="concept"
          resourceId={c.id}
          title={c.name}
        />
      )}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title={`Delete “${c.name}”?`}
          description="Links from papers and notes to this concept will be removed. Notes themselves are kept."
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove}>
              Delete concept
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
