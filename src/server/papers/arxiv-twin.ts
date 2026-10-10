/**
 * The arXiv version of a paper known from elsewhere. Papers under double-blind review on OpenReview are
 * anonymous and their PDFs need an account, but authors often post the same paper on arXiv. Linking the
 * two gives the paper its authors, abstract and a free PDF (read live, following new versions).
 */
import { and, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import { normalizeArxivId, normalizeTitle } from "@/lib/identifiers";
import { db } from "@/server/db/client";
import { libraryItems, paperIdentifiers, papers } from "@/server/db/schema";
import { badRequest, notFound } from "@/server/http";
import { enqueueJob } from "@/server/jobs/queue";
import { scholarly } from "@/server/scholarly/service";
import type { NormalizedPaper } from "@/server/scholarly/types";
import { enrichPaper } from "./ingest";
import { getVisiblePaper } from "./service";

/** Look again after this long: new arXiv postings take a day or two to become searchable. */
const RECHECK_MS = 3 * 24 * 3600_000;
/** …for this long after the paper was first seen; after that it is probably not on arXiv. */
const GIVE_UP_MS = 60 * 24 * 3600_000;

/** Same title, allowing for punctuation, case and a word or two of difference (e.g. "VLMs" spelled out). */
export function sameTitle(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const wa = new Set(x.split(" "));
  const wb = new Set(y.split(" "));
  const shared = [...wa].filter((w) => wb.has(w)).length;
  // Jaccard similarity of the words; short titles must match exactly.
  return Math.min(wa.size, wb.size) >= 5 && shared / (wa.size + wb.size - shared) >= 0.85;
}

async function arxivIdOf(paperId: string) {
  const [row] = await db
    .select({ value: paperIdentifiers.value })
    .from(paperIdentifiers)
    .where(and(eq(paperIdentifiers.paperId, paperId), eq(paperIdentifiers.kind, "arxiv")));
  return row?.value ?? null;
}

/**
 * Merges an arXiv record into the paper: authors, abstract, dates and the arXiv PDF, and the arXiv id when
 * no other paper holds it yet (if one does, the two stay separate, but this one still gets the PDF link).
 */
async function linkRecord(paperId: string, record: NormalizedPaper) {
  const id = record.ids.arxiv!;
  const [holder] = await db
    .select({ paperId: paperIdentifiers.paperId })
    .from(paperIdentifiers)
    .where(
      and(eq(paperIdentifiers.kind, "arxiv"), eq(paperIdentifiers.value, id), ne(paperIdentifiers.paperId, paperId)),
    );
  await enrichPaper(paperId, [holder ? { ...record, ids: {} } : record]);
  await db.update(papers).set({ arxivCheckedAt: new Date() }).where(eq(papers.id, paperId));
  return id;
}

/** Looks for the paper on arXiv by its title and links the match. Returns the arXiv id, or null. */
export async function findArxivTwin(paperId: string): Promise<string | null> {
  const [row] = await db.select().from(papers).where(eq(papers.id, paperId));
  if (!row || row.ownerWorkspaceId !== null) return null;
  const existing = await arxivIdOf(paperId);
  if (existing) return existing;
  const candidates = await scholarly().arxivByTitle(row.title);
  const match = candidates.find((c) => c.ids.arxiv && sameTitle(c.title, row.title));
  if (!match) {
    await db.update(papers).set({ arxivCheckedAt: new Date() }).where(eq(papers.id, paperId));
    return null;
  }
  return linkRecord(paperId, match);
}

/** The user names the arXiv version themselves (an id or a link): it is looked up and linked. */
export async function linkArxivVersion(workspaceId: string, paperId: string, input: string): Promise<string> {
  const paper = await getVisiblePaper(workspaceId, paperId);
  if (paper.ownerWorkspaceId !== null) throw badRequest("Manually entered papers cannot be linked to arXiv.");
  const id = normalizeArxivId(input);
  if (!id) throw badRequest("That is not an arXiv id or link (e.g. 2609.29934 or https://arxiv.org/abs/2609.29934).");
  const records = await scholarly().lookup({ arxiv: id });
  const arxivRecord = records.find((r) => r.source === "arxiv") ?? records[0];
  if (!arxivRecord) throw notFound("arXiv paper");
  return linkRecord(paperId, { ...arxivRecord, ids: { ...arxivRecord.ids, arxiv: id } });
}

/** Queues a search for the arXiv version of a paper from OpenReview that has none yet (on save, on view). */
export async function queueArxivTwinCheck(row: {
  id: string;
  source: string;
  ownerWorkspaceId: string | null;
  arxivCheckedAt: Date | null;
  createdAt: Date;
}) {
  if (row.source !== "openreview" || row.ownerWorkspaceId !== null) return;
  if (row.arxivCheckedAt && Date.now() - row.arxivCheckedAt.getTime() < RECHECK_MS) return;
  if (Date.now() - row.createdAt.getTime() > GIVE_UP_MS && row.arxivCheckedAt) return;
  await enqueueJob({ type: "find_arxiv_twin", payload: { paperId: row.id }, dedupeKey: `find_arxiv_twin:${row.id}` });
}

/** Saved papers from OpenReview still without an arXiv version, due for another look (daily job). */
export async function queueArxivTwinBackfill() {
  const due = await db
    .selectDistinct({ id: papers.id })
    .from(papers)
    .innerJoin(libraryItems, eq(libraryItems.paperId, papers.id))
    .where(
      and(
        eq(papers.source, "openreview"),
        isNull(papers.ownerWorkspaceId),
        sql`not exists (select 1 from ${paperIdentifiers} pi where pi.paper_id = ${papers.id} and pi.kind = 'arxiv')`,
        or(isNull(papers.arxivCheckedAt), lt(papers.arxivCheckedAt, new Date(Date.now() - RECHECK_MS))),
        gt(papers.createdAt, new Date(Date.now() - GIVE_UP_MS)),
      ),
    )
    .limit(200);
  for (const r of due) {
    await enqueueJob({ type: "find_arxiv_twin", payload: { paperId: r.id }, dedupeKey: `find_arxiv_twin:${r.id}` });
  }
  return due.length;
}
