/**
 * Keeps the embeddings of a workspace's texts up to date: PDF pages in chunks, abstracts of saved papers
 * without a PDF, and notes. Each source is re-embedded only when its text (content hash) or the model
 * changed. Runs in background jobs.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { libraryItems, notes, paperFilePages, paperFiles, papers, textEmbeddings } from "@/server/db/schema";
import { embedder, type Embedder } from "./embedder";

const CHUNK_CHARS = 1100;

/** Splits text into chunks of whole sentences (about 1100 characters, roughly 250 tokens). */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current && current.length + s.length + 1 > size) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current} ${s}` : s.slice(0, size * 2);
  }
  if (current.trim().length >= 40) chunks.push(current);
  return chunks;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

type Row = typeof textEmbeddings.$inferInsert;

async function store(e: Embedder, rows: Omit<Row, "vector" | "model">[]) {
  if (!rows.length) return 0;
  const vectors = await e.passages(rows.map((r) => r.text));
  const values = rows.map((r, i) => ({ ...r, vector: vectors[i], model: e.model }));
  for (let i = 0; i < values.length; i += 100) await db.insert(textEmbeddings).values(values.slice(i, i + 100));
  return rows.length;
}

/** Embeds a PDF's pages (replacing earlier embeddings of that file). */
export async function indexFile(fileId: string): Promise<{ chunks: number } | { skipped: string }> {
  const e = await embedder();
  if (!e) return { skipped: "embeddings off" };
  const [file] = await db.select().from(paperFiles).where(eq(paperFiles.id, fileId));
  if (!file) return { skipped: "file deleted" };
  const pages = await db
    .select({ n: paperFilePages.pageNumber, text: paperFilePages.text })
    .from(paperFilePages)
    .where(eq(paperFilePages.fileId, fileId))
    .orderBy(paperFilePages.pageNumber);
  const contentHash = hash(`${e.model}:${file.sha256}`);
  const [existing] = await db
    .select({ hash: textEmbeddings.contentHash })
    .from(textEmbeddings)
    .where(eq(textEmbeddings.fileId, fileId))
    .limit(1);
  if (existing?.hash === contentHash) return { chunks: 0 };
  const rows = pages.flatMap((p) =>
    chunkText(p.text).map((text, chunk) => ({
      workspaceId: file.workspaceId,
      sourceKind: "pdf" as const,
      fileId,
      paperId: file.paperId,
      page: p.n,
      chunk,
      text,
      contentHash,
    })),
  );
  const vectors = rows.length ? await e.passages(rows.map((r) => r.text)) : [];
  await db.transaction(async (tx) => {
    await tx.delete(textEmbeddings).where(eq(textEmbeddings.fileId, fileId));
    const values = rows.map((r, i) => ({ ...r, vector: vectors[i], model: e.model }));
    for (let i = 0; i < values.length; i += 100) await tx.insert(textEmbeddings).values(values.slice(i, i + 100));
  });
  return { chunks: rows.length };
}

/**
 * Brings a workspace's embeddings up to date: PDFs not embedded yet (or with another model), abstracts of
 * saved papers without a PDF, and notes changed since they were embedded. Stale rows are replaced.
 */
export async function indexWorkspace(
  workspaceId: string,
): Promise<{ files: number; abstracts: number; notes: number }> {
  const e = await embedder();
  if (!e) return { files: 0, abstracts: 0, notes: 0 };

  // PDFs with extracted text but no (current) embeddings.
  const files = await db
    .select({ id: paperFiles.id })
    .from(paperFiles)
    .where(
      and(
        eq(paperFiles.workspaceId, workspaceId),
        eq(paperFiles.textStatus, "ready"),
        sql`not exists (select 1 from ${textEmbeddings} te where te.file_id = ${paperFiles.id} and te.model = ${e.model})`,
      ),
    );
  for (const f of files) await indexFile(f.id);

  // Abstracts of saved papers that have no PDF here.
  const saved = await db
    .select({ id: papers.id, title: papers.title, abstract: papers.abstract })
    .from(libraryItems)
    .innerJoin(papers, eq(papers.id, libraryItems.paperId))
    .where(
      and(
        eq(libraryItems.workspaceId, workspaceId),
        isNotNull(papers.abstract),
        sql`not exists (select 1 from ${paperFiles} pf where pf.paper_id = ${papers.id} and pf.workspace_id = ${workspaceId})`,
      ),
    );
  const abstractRows = await db
    .select({ paperId: textEmbeddings.paperId, hash: textEmbeddings.contentHash })
    .from(textEmbeddings)
    .where(and(eq(textEmbeddings.workspaceId, workspaceId), eq(textEmbeddings.sourceKind, "abstract")));
  const abstractHash = new Map(abstractRows.map((r) => [r.paperId, r.hash]));
  const staleAbstracts = saved
    .map((p) => ({ p, text: `${p.title}. ${p.abstract}`, h: hash(`${e.model}:${p.title}. ${p.abstract}`) }))
    .filter(({ p, h }) => abstractHash.get(p.id) !== h);
  if (staleAbstracts.length) {
    await db.delete(textEmbeddings).where(
      and(
        eq(textEmbeddings.workspaceId, workspaceId),
        eq(textEmbeddings.sourceKind, "abstract"),
        inArray(
          textEmbeddings.paperId,
          staleAbstracts.map((s) => s.p.id),
        ),
      ),
    );
    await store(
      e,
      staleAbstracts.map(({ p, text, h }) => ({
        workspaceId,
        sourceKind: "abstract" as const,
        paperId: p.id,
        text: text.slice(0, 4000),
        contentHash: h,
      })),
    );
  }
  // Abstracts of papers no longer saved (or that now have a PDF) are removed.
  const keep = saved.map((p) => p.id);
  await db
    .delete(textEmbeddings)
    .where(
      and(
        eq(textEmbeddings.workspaceId, workspaceId),
        eq(textEmbeddings.sourceKind, "abstract"),
        keep.length ? notInArray(textEmbeddings.paperId, keep) : undefined,
      ),
    );

  // Notes, re-embedded when their text changes.
  const noteRows = await db
    .select({ id: notes.id, title: notes.title, text: notes.contentText })
    .from(notes)
    .where(eq(notes.workspaceId, workspaceId));
  const noteHashes = await db
    .selectDistinct({ noteId: textEmbeddings.noteId, hash: textEmbeddings.contentHash })
    .from(textEmbeddings)
    .where(and(eq(textEmbeddings.workspaceId, workspaceId), eq(textEmbeddings.sourceKind, "note")));
  const noteHash = new Map(noteHashes.map((r) => [r.noteId, r.hash]));
  let noteCount = 0;
  for (const n of noteRows) {
    const body = `${n.title}\n${n.text}`.trim();
    const h = hash(`${e.model}:${body}`);
    if (noteHash.get(n.id) === h) continue;
    await db.delete(textEmbeddings).where(eq(textEmbeddings.noteId, n.id));
    if (body.length >= 20) {
      await store(
        e,
        chunkText(body).map((text, chunk) => ({
          workspaceId,
          sourceKind: "note" as const,
          noteId: n.id,
          chunk,
          text,
          contentHash: h,
        })),
      );
    }
    noteCount++;
  }
  return { files: files.length, abstracts: staleAbstracts.length, notes: noteCount };
}
