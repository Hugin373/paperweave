import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { concepts, libraryItems, notes, papers } from "@/server/db/schema";

export interface LinkTarget {
  type: "paper" | "concept" | "note";
  id: string;
  label: string;
  detail: string | null;
}

/**
 * Candidates for linking from a note (the [[ / @ autocomplete) or from link pickers:
 * library papers, concepts and notes of the workspace whose name matches `q`.
 */
export async function searchLinkTargets(
  workspaceId: string,
  q: string,
  types: LinkTarget["type"][] = ["paper", "concept", "note"],
  limitPerType = 6,
  excludeNoteId?: string,
): Promise<LinkTarget[]> {
  const term = q.trim();
  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const prefix = `${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const out: LinkTarget[] = [];

  const tasks: Promise<void>[] = [];
  if (types.includes("concept")) {
    tasks.push(
      db
        .select({ id: concepts.id, name: concepts.name, description: concepts.description })
        .from(concepts)
        .where(
          and(
            eq(concepts.workspaceId, workspaceId),
            term
              ? sql`(${concepts.name} ilike ${like} or exists (select 1 from unnest(${concepts.aliases}) a where a ilike ${like}))`
              : undefined,
          ),
        )
        .orderBy(term ? sql`(${concepts.name} ilike ${prefix}) desc` : desc(concepts.updatedAt), concepts.name)
        .limit(limitPerType)
        .then((rows) => {
          for (const r of rows)
            out.push({ type: "concept", id: r.id, label: r.name, detail: r.description.slice(0, 80) || null });
        }),
    );
  }
  if (types.includes("paper")) {
    tasks.push(
      db
        .select({ id: papers.id, title: papers.title, year: papers.year, authors: papers.authorsText })
        .from(libraryItems)
        .innerJoin(papers, eq(papers.id, libraryItems.paperId))
        .where(
          and(
            eq(libraryItems.workspaceId, workspaceId),
            term ? sql`(${papers.title} ilike ${like} or ${papers.authorsText} ilike ${like})` : undefined,
          ),
        )
        .orderBy(desc(libraryItems.updatedAt))
        .limit(limitPerType)
        .then((rows) => {
          for (const r of rows) {
            const first = r.authors.split(",")[0]?.trim();
            out.push({
              type: "paper",
              id: r.id,
              label: r.title,
              detail: [first, r.year].filter(Boolean).join(", ") || null,
            });
          }
        }),
    );
  }
  if (types.includes("note")) {
    tasks.push(
      db
        .select({ id: notes.id, title: notes.title })
        .from(notes)
        .where(
          and(
            eq(notes.workspaceId, workspaceId),
            ne(notes.title, ""),
            excludeNoteId ? ne(notes.id, excludeNoteId) : undefined,
            term ? sql`${notes.title} ilike ${like}` : undefined,
          ),
        )
        .orderBy(desc(notes.updatedAt))
        .limit(limitPerType)
        .then((rows) => {
          for (const r of rows) out.push({ type: "note", id: r.id, label: r.title, detail: null });
        }),
    );
  }
  await Promise.all(tasks);
  const order = { concept: 0, paper: 1, note: 2 };
  return out.sort((a, b) => order[a.type] - order[b.type]);
}
