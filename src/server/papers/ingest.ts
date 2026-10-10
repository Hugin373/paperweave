/**
 * Turns normalized external paper records into internal papers, with conservative
 * de-duplication:
 *   1. any shared stable identifier (DOI, arXiv, S2, OpenAlex, PubMed…) → same paper
 *   2. otherwise identical normalized title + first-author family name + year (±1),
 *      and only if the DOIs do not conflict
 *   3. otherwise a new paper.
 * Existing metadata is only filled in, never overwritten, with two exceptions: counts that
 * naturally grow (citation counts take the maximum reported value), and core bibliographic
 * fields (title, authors, year) when a more authoritative source describes the paper — the
 * registries that mint the identifiers (arXiv, Crossref) outrank aggregators, which
 * occasionally carry corrupted records.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { normalizeAuthorFamilyName, normalizeTitle } from "@/lib/identifiers";
import { db, type Executor } from "@/server/db/client";
import { paperIdentifiers, papers } from "@/server/db/schema";
import { venueRank } from "@/server/scholarly/providers/openreview";
import type { IdentifierKind, NormalizedPaper } from "@/server/scholarly/types";

type PaperRow = typeof papers.$inferSelect;

const IDENTITY_PRIORITY: IdentifierKind[] = ["doi", "arxiv", "s2", "openalex", "pmid", "pmcid", "corpus", "openreview"];

function idEntries(p: NormalizedPaper): [IdentifierKind, string][] {
  return IDENTITY_PRIORITY.filter((k) => p.ids[k]).map((k) => [k, p.ids[k]!]);
}

function authorsText(p: NormalizedPaper) {
  return p.authors.map((a) => a.name).join(", ");
}

function insertValues(p: NormalizedPaper) {
  return {
    source: p.source,
    title: p.title,
    abstract: p.abstract,
    year: p.year,
    publicationDate: p.publicationDate,
    venue: p.venue,
    publicationTypes: p.publicationTypes,
    fieldsOfStudy: p.fieldsOfStudy,
    authors: p.authors,
    authorsText: authorsText(p),
    citationCount: p.citationCount,
    referenceCount: p.referenceCount,
    influentialCitationCount: p.influentialCitationCount,
    isOpenAccess: p.isOpenAccess,
    openAccessPdfUrl: p.openAccessPdfUrl,
    freeReadUrl: p.freeReadUrl ?? null,
    url: p.url,
    titleNorm: normalizeTitle(p.title),
    firstAuthorNorm: normalizeAuthorFamilyName(p.authors[0]?.name),
  };
}

const AUTHORITY: Record<string, number> = {
  arxiv: 3,
  crossref: 3,
  semantic_scholar: 2,
  europepmc: 2,
  openalex: 1,
  openreview: 1,
  user: 0,
};

/**
 * Whether an OpenReview acceptance should replace the stored venue: a preprint server, or (for venues
 * that came from OpenReview) a workshop or rejected/withdrawn submission. Journals are never replaced.
 */
function betterVenueNeeded(row: PaperRow) {
  if (!row.venue || /arxiv|corr|preprint|biorxiv|medrxiv|research square/i.test(row.venue)) return true;
  return row.source === "openreview" && venueRank(row.venue) > 0;
}

const maxOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

/** Computes the fill-in-only update for an existing row. Returns null if nothing changes. */
export function mergePatch(row: PaperRow, p: NormalizedPaper): Partial<PaperRow> | null {
  const patch: Partial<PaperRow> = {};
  if (row.ownerWorkspaceId === null && (AUTHORITY[p.source] ?? 0) > (AUTHORITY[row.source] ?? 0)) {
    if (p.title && p.title !== row.title) {
      patch.title = p.title;
      patch.titleNorm = normalizeTitle(p.title);
    }
    if (p.authors.length && p.authors.map((a) => a.name).join("|") !== row.authors.map((a) => a.name).join("|")) {
      patch.authors = p.authors;
      patch.authorsText = authorsText(p);
      patch.firstAuthorNorm = normalizeAuthorFamilyName(p.authors[0]?.name);
    }
    if (p.year !== null && p.year !== row.year) patch.year = p.year;
    if (p.publicationDate && p.publicationDate !== row.publicationDate) patch.publicationDate = p.publicationDate;
    patch.source = p.source;
    row = { ...row, ...patch };
  }
  if (!row.abstract && p.abstract) patch.abstract = p.abstract;
  if (row.year === null && p.year !== null) patch.year = p.year;
  if (!row.publicationDate && p.publicationDate) patch.publicationDate = p.publicationDate;
  if (!row.venue && p.venue) patch.venue = p.venue;
  else if (p.source === "openreview" && p.venue && venueRank(p.venue) === 0 && betterVenueNeeded(row)) {
    // Acceptance at a peer-reviewed venue beats a preprint server or workshop as the venue.
    patch.venue = p.venue;
  }
  if (!row.url && p.url) patch.url = p.url;
  if (!row.openAccessPdfUrl && p.openAccessPdfUrl) patch.openAccessPdfUrl = p.openAccessPdfUrl;
  if (!row.freeReadUrl && p.freeReadUrl) patch.freeReadUrl = p.freeReadUrl;
  if (row.isOpenAccess !== true && p.isOpenAccess !== null && p.isOpenAccess !== row.isOpenAccess) {
    patch.isOpenAccess = row.isOpenAccess === null ? p.isOpenAccess : row.isOpenAccess || p.isOpenAccess;
  }
  if (row.authors.length === 0 && p.authors.length) {
    patch.authors = p.authors;
    patch.authorsText = authorsText(p);
    patch.firstAuthorNorm = normalizeAuthorFamilyName(p.authors[0]?.name);
  } else if (p.authors.length === row.authors.length) {
    // Same author list from another source: merge per-author external ids.
    let changed = false;
    const merged = row.authors.map((a, i) => {
      const extra = p.authors[i].ids;
      if (!extra) return a;
      const ids = { ...extra, ...a.ids };
      if (Object.keys(ids).length !== Object.keys(a.ids ?? {}).length) changed = true;
      return { ...a, ids };
    });
    if (changed) patch.authors = merged;
  }
  const citationCount = maxOf(row.citationCount, p.citationCount);
  if (citationCount !== row.citationCount) patch.citationCount = citationCount;
  const referenceCount = maxOf(row.referenceCount, p.referenceCount);
  if (referenceCount !== row.referenceCount) patch.referenceCount = referenceCount;
  if (p.influentialCitationCount !== null && p.influentialCitationCount !== row.influentialCitationCount) {
    patch.influentialCitationCount = p.influentialCitationCount;
  }
  const types = union(
    row.publicationTypes,
    p.publicationTypes.filter((t) => t !== "other"),
  );
  if (types.length !== row.publicationTypes.length) patch.publicationTypes = types;
  const fields = union(row.fieldsOfStudy, p.fieldsOfStudy).slice(0, 8);
  if (fields.length !== row.fieldsOfStudy.length) patch.fieldsOfStudy = fields;
  return Object.keys(patch).length ? patch : null;
}

/**
 * Ingests records and returns the internal paper id for each input (same order).
 * Runs inside one transaction holding an advisory lock so concurrent requests cannot
 * create duplicates of the same new paper.
 */
export async function ingestPapers(records: NormalizedPaper[], executor?: Executor): Promise<string[]> {
  if (!records.length) return [];
  const run = async (tx: Executor) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('paperweave:paper-ingest'))`);

    // 1. Identifier matches, prefetched in one query.
    const allIds = records.flatMap(idEntries);
    const idMap = new Map<string, string>(); // "kind:value" → paper id
    if (allIds.length) {
      const rows = await tx
        .select({ paperId: paperIdentifiers.paperId, kind: paperIdentifiers.kind, value: paperIdentifiers.value })
        .from(paperIdentifiers)
        .where(
          and(
            eq(paperIdentifiers.scope, "global"),
            sql`(${paperIdentifiers.kind}::text, ${paperIdentifiers.value}) in (select * from unnest(${sql.param(
              allIds.map(([k]) => k),
            )}::text[], ${sql.param(allIds.map(([, v]) => v))}::text[]))`,
          ),
        );
      for (const r of rows) idMap.set(`${r.kind}:${r.value}`, r.paperId);
    }

    // 2. Title candidates for records without identifier matches.
    const titleNorms = [...new Set(records.map((r) => normalizeTitle(r.title)))];
    const titleRows = await tx
      .select()
      .from(papers)
      .where(and(isNull(papers.ownerWorkspaceId), inArray(papers.titleNorm, titleNorms)));

    const matchedIds = [...new Set(idMap.values())];
    const rowById = new Map<string, PaperRow>(titleRows.map((r) => [r.id, r]));
    const missing = matchedIds.filter((id) => !rowById.has(id));
    if (missing.length) {
      for (const r of await tx.select().from(papers).where(inArray(papers.id, missing))) rowById.set(r.id, r);
    }
    const doiByPaper = new Map<string, string>();
    if (rowById.size) {
      const dois = await tx
        .select({ paperId: paperIdentifiers.paperId, value: paperIdentifiers.value })
        .from(paperIdentifiers)
        .where(and(eq(paperIdentifiers.kind, "doi"), inArray(paperIdentifiers.paperId, [...rowById.keys()])));
      for (const d of dois) doiByPaper.set(d.paperId, d.value);
    }

    const result: string[] = [];
    for (const rec of records) {
      const entries = idEntries(rec);
      let paperId = entries.map(([k, v]) => idMap.get(`${k}:${v}`)).find(Boolean);

      if (!paperId) {
        const tn = normalizeTitle(rec.title);
        const fa = normalizeAuthorFamilyName(rec.authors[0]?.name);
        // A title match alone is not enough (many works share a title): it also needs a matching
        // first author or year, and neither may disagree.
        const candidate = [...rowById.values()].find((r) => {
          const sameAuthor = !!fa && !!r.firstAuthorNorm && r.firstAuthorNorm === fa;
          const sameYear = rec.year !== null && r.year !== null && Math.abs(r.year - rec.year) <= 1;
          return (
            r.ownerWorkspaceId === null &&
            r.titleNorm === tn &&
            tn.length >= 12 &&
            (!fa || !r.firstAuthorNorm || sameAuthor) &&
            (rec.year === null || r.year === null || sameYear) &&
            (sameAuthor || sameYear) &&
            (!rec.ids.doi || !doiByPaper.get(r.id) || doiByPaper.get(r.id) === rec.ids.doi)
          );
        });
        paperId = candidate?.id;
      }

      if (paperId) {
        const row = rowById.get(paperId);
        const patch = row ? mergePatch(row, rec) : null;
        if (patch) {
          await tx.update(papers).set(patch).where(eq(papers.id, paperId));
          rowById.set(paperId, { ...row!, ...patch });
        }
      } else {
        const [row] = await tx.insert(papers).values(insertValues(rec)).returning();
        paperId = row.id;
        rowById.set(row.id, row);
      }

      if (entries.length) {
        const inserted = await tx
          .insert(paperIdentifiers)
          .values(entries.map(([kind, value]) => ({ paperId: paperId!, kind, value, scope: "global" })))
          .onConflictDoNothing()
          .returning({ kind: paperIdentifiers.kind, value: paperIdentifiers.value });
        for (const i of inserted) {
          idMap.set(`${i.kind}:${i.value}`, paperId);
          if (i.kind === "doi") doiByPaper.set(paperId, i.value);
        }
      }
      result.push(paperId);
    }
    return result;
  };
  return executor ? run(executor) : db.transaction(run);
}

/** Records the merge of several source records of the same paper (lookup/enrichment). */
export async function ingestRecordsOfOnePaper(records: NormalizedPaper[]): Promise<string | null> {
  if (!records.length) return null;
  return db.transaction(async (tx) => {
    const ids = await ingestPapers(records, tx);
    // All records describe the same paper; the first record's resolution wins, and the
    // identifiers of the others are attached to it when they are still unclaimed.
    const primary = ids[0];
    for (let i = 1; i < records.length; i++) {
      if (ids[i] === primary) continue;
      const entries = idEntries(records[i]);
      if (entries.length) {
        await tx
          .insert(paperIdentifiers)
          .values(entries.map(([kind, value]) => ({ paperId: primary, kind, value, scope: "global" })))
          .onConflictDoNothing();
      }
    }
    await tx.update(papers).set({ metadataRefreshedAt: new Date() }).where(eq(papers.id, primary));
    return primary;
  });
}

/**
 * Merges freshly fetched source records into an existing paper (fill-in only) and attaches
 * any identifiers that no other paper has claimed.
 */
export async function enrichPaper(paperId: string, records: NormalizedPaper[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('paperweave:paper-ingest'))`);
    let [row] = await tx.select().from(papers).where(eq(papers.id, paperId));
    if (!row) return;
    for (const rec of records) {
      const patch = mergePatch(row, rec);
      if (patch) {
        await tx.update(papers).set(patch).where(eq(papers.id, paperId));
        row = { ...row, ...patch };
      }
      const entries = idEntries(rec);
      if (entries.length && row.ownerWorkspaceId === null) {
        await tx
          .insert(paperIdentifiers)
          .values(entries.map(([kind, value]) => ({ paperId, kind, value, scope: "global" })))
          .onConflictDoNothing();
      }
    }
    await tx.update(papers).set({ metadataRefreshedAt: new Date() }).where(eq(papers.id, paperId));
  });
}
