import { and, asc, eq } from "drizzle-orm";
import type { HighlightDto } from "@/lib/types";
import { db } from "@/server/db/client";
import { highlights, type HighlightRect } from "@/server/db/schema";
import { notFound } from "@/server/http";
import { getWorkspaceFile } from "./service";

type HighlightRow = typeof highlights.$inferSelect;

export function toHighlightDto(h: HighlightRow): HighlightDto {
  return {
    id: h.id,
    fileId: h.fileId,
    paperId: h.paperId,
    kind: h.kind,
    pageNumber: h.pageNumber,
    rects: h.rects,
    selectedText: h.selectedText,
    prefix: h.prefix,
    suffix: h.suffix,
    color: h.color,
    comment: h.comment,
    lost: h.anchorLost,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

export async function listHighlights(workspaceId: string, fileId: string) {
  await getWorkspaceFile(workspaceId, fileId);
  const rows = await db
    .select()
    .from(highlights)
    .where(and(eq(highlights.workspaceId, workspaceId), eq(highlights.fileId, fileId)))
    .orderBy(asc(highlights.pageNumber), asc(highlights.createdAt));
  return rows.map(toHighlightDto);
}

export interface HighlightInput {
  kind: "highlight" | "note";
  pageNumber: number;
  rects: HighlightRect[];
  selectedText: string;
  prefix: string;
  suffix: string;
  color: string;
  comment: string;
}

export async function createHighlight(workspaceId: string, userId: string, fileId: string, input: HighlightInput) {
  const file = await getWorkspaceFile(workspaceId, fileId);
  const [row] = await db
    .insert(highlights)
    .values({ ...input, workspaceId, fileId, paperId: file.paperId, createdBy: userId })
    .returning();
  return toHighlightDto(row);
}

async function ownedHighlight(workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(highlights)
    .where(and(eq(highlights.id, id), eq(highlights.workspaceId, workspaceId)));
  if (!row) throw notFound("Highlight");
  return row;
}

export async function updateHighlight(
  workspaceId: string,
  id: string,
  patch: Partial<Pick<HighlightInput, "color" | "comment">>,
) {
  await ownedHighlight(workspaceId, id);
  const [row] = await db.update(highlights).set(patch).where(eq(highlights.id, id)).returning();
  return toHighlightDto(row);
}

export async function deleteHighlight(workspaceId: string, id: string) {
  await ownedHighlight(workspaceId, id);
  await db.delete(highlights).where(eq(highlights.id, id));
}
