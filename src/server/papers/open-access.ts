/**
 * Background check for free PDFs of journal papers. Papers on arXiv, or with an open-access link from
 * the scholarly sources, already offer "Read". For papers known only by a DOI, Unpaywall is asked
 * once (when SCHOLARLY_CONTACT_EMAIL is set) and a PDF it finds is recorded as the paper's open-access
 * link, so the button appears only when a copy really exists. Checks are repeated after 30 days,
 * since embargoed papers become free later.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { libraryItems, paperIdentifiers, papers } from "@/server/db/schema";
import { enqueueJob } from "@/server/jobs/queue";
import { aclAnthologyPdf } from "@/server/scholarly/free-pdf";
import { pmcidFromUrl } from "@/server/scholarly/providers/unpaywall";
import { scholarly } from "@/server/scholarly/service";
import { identifiersFor } from "./service";

const RECHECK_DAYS = 30;
const BACKFILL_BATCH = 500;

/**
 * Checks one paper; returns the PDF link found, or null. A paper that is free to read without a
 * downloadable PDF (e.g. an author manuscript on PubMed Central) gets that page as `freeReadUrl`.
 * Throws when Unpaywall cannot be reached.
 */
export async function checkOpenAccess(paperId: string): Promise<string | null> {
  const [row] = await db
    .select({ owner: papers.ownerWorkspaceId, url: papers.openAccessPdfUrl })
    .from(papers)
    .where(eq(papers.id, paperId));
  if (!row || row.owner !== null) return null;
  const ids = (await identifiersFor([paperId])).get(paperId) ?? {};
  // arXiv DOIs (10.48550) are covered by the arXiv copy.
  if (row.url || ids.arxiv || !ids.doi || ids.doi.startsWith("10.48550/")) return row.url;
  // ACL Anthology papers are all free, at an address their DOI names.
  const acl = aclAnthologyPdf(ids.doi);
  if (acl) {
    await db
      .update(papers)
      .set({ oaCheckedAt: new Date(), openAccessPdfUrl: sql`coalesce(${papers.openAccessPdfUrl}, ${acl})` })
      .where(eq(papers.id, paperId));
    return acl;
  }
  const result = await scholarly().unpaywallCheck(ids.doi);
  if (result === null) return null; // lookups are off: check again once they are on
  const found = result.pdfs[0] ?? null;
  await db
    .update(papers)
    .set({
      oaCheckedAt: new Date(),
      openAccessPdfUrl: sql`coalesce(${papers.openAccessPdfUrl}, ${found})`,
      freeReadUrl: result.freeReadUrl,
    })
    .where(eq(papers.id, paperId));
  // Free on PubMed Central: record its id, so AI features can use PMC's full text when it is open.
  const pmcid = pmcidFromUrl(result.freeReadUrl);
  if (pmcid && !ids.pmcid) {
    await db
      .insert(paperIdentifiers)
      .values({ paperId, kind: "pmcid", value: pmcid, scope: "global" })
      .onConflictDoNothing();
  }
  return found;
}

/** Queues a check for a paper that may need one (cheap to call; the job skips papers that don't). */
export async function queueOpenAccessCheck(paperId: string) {
  if (!scholarly().unpaywallEnabled) return;
  await enqueueJob({
    type: "find_open_access",
    payload: { paperId },
    dedupeKey: `find_open_access:${paperId}`,
    maxAttempts: 4,
  });
}

/**
 * Queues checks for saved papers that have only a DOI, no free PDF on record, and no recent check:
 * run when the worker starts (e.g. right after SCHOLARLY_CONTACT_EMAIL is set) and daily.
 */
export async function queueOpenAccessBackfill(): Promise<number> {
  if (!scholarly().unpaywallEnabled) return 0;
  const recheckBefore = new Date(Date.now() - RECHECK_DAYS * 86_400_000);
  const rows = await db
    .selectDistinct({ id: papers.id })
    .from(papers)
    .innerJoin(libraryItems, eq(libraryItems.paperId, papers.id))
    .innerJoin(paperIdentifiers, and(eq(paperIdentifiers.paperId, papers.id), eq(paperIdentifiers.kind, "doi")))
    .where(
      and(
        isNull(papers.ownerWorkspaceId),
        isNull(papers.openAccessPdfUrl),
        or(isNull(papers.oaCheckedAt), lt(papers.oaCheckedAt, recheckBefore)),
        sql`not exists (select 1 from ${paperIdentifiers} a where a.paper_id = ${papers.id} and a.kind = 'arxiv')`,
      ),
    )
    .limit(BACKFILL_BATCH);
  for (const r of rows) await queueOpenAccessCheck(r.id);
  return rows.length;
}
