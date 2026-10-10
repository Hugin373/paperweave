/**
 * Personal workspace search over the user's own knowledge: library papers, notes, concepts,
 * highlights/annotations, PDF text, tags and collections. PostgreSQL full-text search with
 * prefix matching; no external search infrastructure.
 */
import { sql } from "drizzle-orm";
import type { WorkspaceSearchResponse } from "@/lib/types";
import { db } from "@/server/db/client";
import { listCollections, listTags } from "@/server/library/organize";
import { getPaperSummaries } from "@/server/papers/service";

export const SNIPPET_START = "⟦";
export const SNIPPET_END = "⟧";

/** Builds a prefix tsquery string ("graph:* & neur:*") from free text, or null. */
export function toPrefixQuery(q: string): string | null {
  const tokens = q
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `${t}:*`).join(" & ");
}

const headline = (column: ReturnType<typeof sql>, q: ReturnType<typeof sql>) =>
  sql<string>`ts_headline('english', ${column}, ${q}, ${`StartSel=${SNIPPET_START}, StopSel=${SNIPPET_END}, MaxWords=30, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "`})`;

/**
 * Searches the workspace. `limit` / `offset` page every kind of result together (the assistant pages
 * through long result lists; the search page uses the defaults).
 */
export async function searchWorkspace(
  workspaceId: string,
  q: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<WorkspaceSearchResponse> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const pageLimit = opts.limit ?? 15;
  const empty: WorkspaceSearchResponse = {
    query: q,
    papers: [],
    notes: [],
    concepts: [],
    highlights: [],
    pdfPages: [],
    tags: [],
    collections: [],
  };
  const prefix = toPrefixQuery(q);
  if (!prefix) return empty;
  const tsq = sql`to_tsquery('english', ${prefix})`;
  const like = `%${q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

  const [paperRows, noteRows, conceptRows, highlightRows, pageRows, tags, collections] = await Promise.all([
    db.execute<{ id: string; rank: number; snippet: string | null }>(sql`
      select p.id, ts_rank(p.search_vector, ${tsq}) + (case when p.title ilike ${like} then 1 else 0 end) as rank,
             case when p.abstract is not null then ${headline(sql`p.abstract`, tsq)} end as snippet
      from papers p join library_items li on li.paper_id = p.id and li.workspace_id = ${workspaceId}
      where p.search_vector @@ ${tsq} or p.title ilike ${like}
      order by rank desc limit ${limit} offset ${offset}`),
    db.execute<{
      id: string;
      title: string;
      text: string;
      paper_id: string | null;
      paper_title: string | null;
      updated_at: string;
      snippet: string;
    }>(sql`
      select n.id, n.title, n.content_text as text, n.paper_id, p.title as paper_title, n.updated_at,
             ${headline(sql`n.content_text`, tsq)} as snippet
      from notes n left join papers p on p.id = n.paper_id
      where n.workspace_id = ${workspaceId} and (n.search_vector @@ ${tsq} or n.title ilike ${like})
      order by ts_rank(n.search_vector, ${tsq}) desc, n.updated_at desc limit ${limit} offset ${offset}`),
    db.execute<{ id: string; name: string; snippet: string | null }>(sql`
      select c.id, c.name, case when c.description <> '' then ${headline(sql`c.description`, tsq)} end as snippet
      from concepts c
      where c.workspace_id = ${workspaceId} and (c.search_vector @@ ${tsq} or c.name ilike ${like})
      order by (c.name ilike ${like}) desc, ts_rank(c.search_vector, ${tsq}) desc limit ${limit} offset ${offset}`),
    db.execute<{
      id: string;
      paper_id: string;
      paper_title: string;
      page_number: number;
      text: string;
      comment: string;
    }>(sql`
      select h.id, h.paper_id, p.title as paper_title, h.page_number, h.selected_text as text, h.comment
      from highlights h join papers p on p.id = h.paper_id
      where h.workspace_id = ${workspaceId} and h.search_vector @@ ${tsq}
      order by ts_rank(h.search_vector, ${tsq}) desc limit ${limit} offset ${offset}`),
    db.execute<{ paper_id: string; paper_title: string; file_id: string; page_number: number; snippet: string }>(sql`
      select f.paper_id, p.title as paper_title, f.id as file_id, pg.page_number,
             ${headline(sql`pg.text`, tsq)} as snippet
      from paper_file_pages pg
      join paper_files f on f.id = pg.file_id and f.workspace_id = ${workspaceId}
      join papers p on p.id = f.paper_id
      where pg.search_vector @@ ${tsq}
      order by ts_rank(pg.search_vector, ${tsq}) desc limit ${pageLimit} offset ${offset}`),
    listTags(workspaceId),
    listCollections(workspaceId),
  ]);

  const summaries = await getPaperSummaries(
    workspaceId,
    paperRows.map((r) => r.id),
  );
  const snippetById = new Map(paperRows.map((r) => [r.id, r.snippet]));
  const needle = q.trim().toLowerCase();

  return {
    query: q,
    papers: summaries.map((paper) => ({ paper, snippet: snippetById.get(paper.id) ?? null })),
    notes: noteRows.map((r) => ({
      id: r.id,
      title: r.title || "Untitled note",
      excerpt: r.text.slice(0, 240),
      paperId: r.paper_id,
      paperTitle: r.paper_title,
      updatedAt: new Date(r.updated_at).toISOString(),
      snippet: r.snippet,
    })),
    concepts: conceptRows.map((r) => ({ id: r.id, name: r.name, snippet: r.snippet })),
    highlights: highlightRows.map((r) => ({
      id: r.id,
      paperId: r.paper_id,
      paperTitle: r.paper_title,
      pageNumber: r.page_number,
      text: r.text,
      comment: r.comment,
    })),
    pdfPages: pageRows.map((r) => ({
      paperId: r.paper_id,
      paperTitle: r.paper_title,
      fileId: r.file_id,
      pageNumber: r.page_number,
      snippet: r.snippet,
    })),
    tags: tags.filter((t) => t.name.toLowerCase().includes(needle)),
    collections: collections.filter(
      (c) => c.name.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle),
    ),
  };
}
