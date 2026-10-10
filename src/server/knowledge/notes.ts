import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { docToPlainText, EMPTY_DOC, extractMentions, isDoc, type PMNode } from "@/lib/prosemirror";
import type { NoteDetail, NoteSummary } from "@/lib/types";
import { db, type Executor } from "@/server/db/client";
import { concepts, noteLinks, notes, papers, users, workspaceMembers } from "@/server/db/schema";
import { badRequest, conflict, notFound, type RequestContext } from "@/server/http";
import { getVisiblePaper, toNoteSummary } from "@/server/papers/service";
import { queueWorkspaceEmbedding } from "@/server/embeddings/queue";
import { requireAccess } from "@/server/sharing/access";

type NoteRow = typeof notes.$inferSelect;

const MAX_CONTENT_BYTES = 2_000_000;

export async function loadNote(noteId: string): Promise<NoteRow> {
  const [row] = await db.select().from(notes).where(eq(notes.id, noteId));
  if (!row) throw notFound("Note");
  return row;
}

export async function listNotes(
  workspaceId: string,
  opts: { q?: string; paperId?: string; kind?: "all" | "standalone" | "paper"; limit?: number } = {},
): Promise<NoteSummary[]> {
  const conditions: SQL[] = [eq(notes.workspaceId, workspaceId)];
  if (opts.paperId) conditions.push(eq(notes.paperId, opts.paperId));
  if (opts.kind === "standalone") conditions.push(isNull(notes.paperId));
  if (opts.kind === "paper") conditions.push(isNotNull(notes.paperId));
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conditions.push(sql`(${notes.title} ilike ${like} or ${notes.contentText} ilike ${like})`);
  }
  const rows = await db
    .select({
      id: notes.id,
      title: notes.title,
      text: notes.contentText,
      paperId: notes.paperId,
      paperTitle: papers.title,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .leftJoin(papers, eq(papers.id, notes.paperId))
    .where(and(...conditions))
    .orderBy(desc(notes.updatedAt))
    .limit(opts.limit ?? 200);
  return rows.map(toNoteSummary);
}

/**
 * Replaces the note's links with the mentions found in its content. Targets must belong to
 * the note's workspace (papers may also be global scholarly records); others are dropped.
 */
export async function syncNoteLinks(tx: Executor, note: { id: string; workspaceId: string }, doc: PMNode) {
  const mentions = extractMentions(doc);
  const [validPapers, validConcepts, validNotes] = await Promise.all([
    mentions.paper.length
      ? tx
          .select({ id: papers.id })
          .from(papers)
          .where(
            and(
              inArray(papers.id, mentions.paper),
              or(isNull(papers.ownerWorkspaceId), eq(papers.ownerWorkspaceId, note.workspaceId)),
            ),
          )
      : [],
    mentions.concept.length
      ? tx
          .select({ id: concepts.id })
          .from(concepts)
          .where(and(inArray(concepts.id, mentions.concept), eq(concepts.workspaceId, note.workspaceId)))
      : [],
    mentions.note.length
      ? tx
          .select({ id: notes.id })
          .from(notes)
          .where(and(inArray(notes.id, mentions.note), eq(notes.workspaceId, note.workspaceId)))
      : [],
  ]);
  await tx.delete(noteLinks).where(eq(noteLinks.noteId, note.id));
  const rows = [
    ...validPapers.map((p) => ({ noteId: note.id, targetPaperId: p.id })),
    ...validConcepts.map((c) => ({ noteId: note.id, targetConceptId: c.id })),
    ...validNotes.filter((n) => n.id !== note.id).map((n) => ({ noteId: note.id, targetNoteId: n.id })),
  ];
  if (rows.length) await tx.insert(noteLinks).values(rows).onConflictDoNothing();
}

function validateContent(content: unknown): PMNode {
  if (!isDoc(content)) throw badRequest("Note content must be a document.");
  if (JSON.stringify(content).length > MAX_CONTENT_BYTES) throw badRequest("This note is too large to save.");
  return content;
}

export async function createNote(
  ctx: RequestContext,
  input: { title?: string; paperId?: string | null; content?: unknown },
): Promise<NoteRow> {
  if (input.paperId) await getVisiblePaper(ctx.workspaceId, input.paperId);
  const doc = input.content === undefined ? EMPTY_DOC : validateContent(input.content);
  return db
    .transaction(async (tx) => {
      const [row] = await tx
        .insert(notes)
        .values({
          workspaceId: ctx.workspaceId,
          paperId: input.paperId ?? null,
          title: input.title?.trim() ?? "",
          content: doc,
          contentText: docToPlainText(doc),
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      await syncNoteLinks(tx, row, doc);
      return row;
    })
    .then(async (row) => {
      await queueWorkspaceEmbedding(row.workspaceId);
      return row;
    });
}

export async function updateNote(
  ctx: RequestContext,
  noteId: string,
  input: { title?: string; content?: unknown; paperId?: string | null; baseUpdatedAt?: string },
): Promise<NoteRow> {
  const note = await loadNote(noteId);
  await requireAccess(ctx, "note", note.id, note.workspaceId, "edit", "Note");
  if (input.paperId !== undefined && note.workspaceId !== ctx.workspaceId) {
    throw badRequest("Only the owner can change which paper a note belongs to.");
  }
  if (input.paperId) await getVisiblePaper(ctx.workspaceId, input.paperId);
  const doc = input.content === undefined ? null : validateContent(input.content);
  return db
    .transaction(async (tx) => {
      // Optimistic concurrency for asynchronous shared editing. The row lock makes the check and the
      // write one step, so two saves based on the same version cannot both succeed.
      const [current] = await tx
        .select({ updatedAt: notes.updatedAt })
        .from(notes)
        .where(eq(notes.id, noteId))
        .for("update");
      if (!current) throw notFound("Note");
      if (input.baseUpdatedAt && new Date(input.baseUpdatedAt).getTime() < current.updatedAt.getTime() - 1) {
        throw conflict("This note was changed elsewhere since you opened it. Reload to see the latest version.");
      }
      const [row] = await tx
        .update(notes)
        .set({
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.paperId !== undefined ? { paperId: input.paperId } : {}),
          ...(doc ? { content: doc, contentText: docToPlainText(doc) } : {}),
          updatedBy: ctx.userId,
          updatedAt: new Date(),
        })
        .where(eq(notes.id, noteId))
        .returning();
      if (doc) await syncNoteLinks(tx, row, doc);
      return row;
    })
    .then(async (row) => {
      if (doc || input.title !== undefined) await queueWorkspaceEmbedding(row.workspaceId);
      return row;
    });
}

export async function deleteNote(ctx: RequestContext, noteId: string) {
  const note = await loadNote(noteId);
  await requireAccess(ctx, "note", note.id, note.workspaceId, "owner", "Note");
  await db.delete(notes).where(eq(notes.id, noteId));
}

export async function getNoteDetail(ctx: RequestContext, noteId: string): Promise<NoteDetail> {
  const note = await loadNote(noteId);
  const access = await requireAccess(ctx, "note", note.id, note.workspaceId, "view", "Note");
  const isMember = note.workspaceId === ctx.workspaceId;

  const [paper, linkRows, backlinkRows, owner] = await Promise.all([
    note.paperId
      ? db.select({ id: papers.id, title: papers.title }).from(papers).where(eq(papers.id, note.paperId))
      : [],
    db
      .select({
        paperId: noteLinks.targetPaperId,
        paperTitle: papers.title,
        conceptId: noteLinks.targetConceptId,
        conceptName: concepts.name,
        noteId: noteLinks.targetNoteId,
        noteTitle: sql<string | null>`(select title from ${notes} n2 where n2.id = ${noteLinks.targetNoteId})`,
      })
      .from(noteLinks)
      .leftJoin(papers, eq(papers.id, noteLinks.targetPaperId))
      .leftJoin(concepts, eq(concepts.id, noteLinks.targetConceptId))
      .where(eq(noteLinks.noteId, noteId)),
    // Backlinks are only meaningful (and only disclosed) inside the owning workspace.
    isMember
      ? db
          .select({
            id: notes.id,
            title: notes.title,
            text: notes.contentText,
            paperId: notes.paperId,
            paperTitle: papers.title,
            updatedAt: notes.updatedAt,
          })
          .from(noteLinks)
          .innerJoin(notes, eq(notes.id, noteLinks.noteId))
          .leftJoin(papers, eq(papers.id, notes.paperId))
          .where(and(eq(noteLinks.targetNoteId, noteId), eq(notes.workspaceId, note.workspaceId)))
          .orderBy(desc(notes.updatedAt))
      : [],
    isMember
      ? []
      : db
          .select({ name: users.name })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(and(eq(workspaceMembers.workspaceId, note.workspaceId), eq(workspaceMembers.role, "owner"))),
  ]);

  return {
    id: note.id,
    title: note.title,
    content: note.content,
    paper: paper[0] ?? null,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    links: {
      papers: linkRows.filter((l) => l.paperId).map((l) => ({ id: l.paperId!, title: l.paperTitle ?? "" })),
      concepts: linkRows.filter((l) => l.conceptId).map((l) => ({ id: l.conceptId!, name: l.conceptName ?? "" })),
      notes: linkRows.filter((l) => l.noteId).map((l) => ({ id: l.noteId!, title: l.noteTitle || "Untitled note" })),
    },
    backlinks: backlinkRows.map(toNoteSummary),
    access,
    ownerName: owner[0]?.name ?? null,
  };
}
