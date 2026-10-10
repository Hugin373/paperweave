/**
 * Imports: BibTeX files (including Zotero/Mendeley/JabRef exports) and lists of identifiers
 * (DOIs, arXiv ids/URLs, PubMed ids). Runs as a background job; each entry is resolved
 * against scholarly sources, and entries no source knows become private user-entered papers.
 */
import { eq } from "drizzle-orm";
import { detectIdentifier, normalizeAuthorFamilyName, normalizeTitle } from "@/lib/identifiers";
import { db } from "@/server/db/client";
import { jobs, paperIdentifiers, papers } from "@/server/db/schema";
import { badRequest, type RequestContext } from "@/server/http";
import { enqueueJob } from "@/server/jobs/queue";
import { savePaper } from "@/server/library/library";
import { addToCollection, getOwnedCollection } from "@/server/library/organize";
import { ingestPapers } from "@/server/papers/ingest";
import { resolveIdentifier } from "@/server/papers/service";
import { scholarly } from "@/server/scholarly/service";
import { parseBibtex, type ParsedBibEntry } from "@/server/export/bibtex";

const MAX_ITEMS = 1000;

type ImportItem = { kind: "bib"; entry: ParsedBibEntry } | { kind: "identifier"; value: string };

export interface ImportPayload {
  workspaceId: string;
  userId: string;
  collectionId: string | null;
  items: ImportItem[];
}

export interface ImportResult {
  total: number;
  processed: number;
  matched: number;
  created: number;
  failed: { label: string; reason: string }[];
}

async function enqueue(ctx: RequestContext, items: ImportItem[], collectionId: string | null) {
  if (!items.length) throw badRequest("Nothing to import was found.");
  if (items.length > MAX_ITEMS) throw badRequest(`Imports are limited to ${MAX_ITEMS} entries at a time.`);
  if (collectionId) await getOwnedCollection(ctx.workspaceId, collectionId);
  const payload: ImportPayload = { workspaceId: ctx.workspaceId, userId: ctx.userId, collectionId, items };
  const id = await enqueueJob({
    type: "import",
    payload: payload as never,
    workspaceId: ctx.workspaceId,
    maxAttempts: 1,
  });
  return { jobId: id, total: items.length };
}

export async function startBibtexImport(ctx: RequestContext, text: string, collectionId: string | null) {
  const { entries } = parseBibtex(text);
  const usable = entries.filter((e) => e.title || e.doi || e.arxiv);
  if (!usable.length) throw badRequest("No BibTeX entries could be read from that file.");
  return enqueue(
    ctx,
    usable.map((entry) => ({ kind: "bib", entry })),
    collectionId,
  );
}

export async function startIdentifierImport(ctx: RequestContext, text: string, collectionId: string | null) {
  const values = [
    ...new Set(
      text
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const unrecognized = values.filter((v) => !detectIdentifier(v));
  if (unrecognized.length === values.length) {
    throw badRequest("No DOIs, arXiv identifiers or other supported identifiers were recognized.");
  }
  return enqueue(
    ctx,
    values.map((value) => ({ kind: "identifier", value })),
    collectionId,
  );
}

async function findByTitle(entry: ParsedBibEntry): Promise<string | null> {
  if (!entry.title) return null;
  const page = await scholarly().search({ query: entry.title, mode: "title", filters: {}, offset: 0, limit: 5 });
  const target = normalizeTitle(entry.title);
  const family = normalizeAuthorFamilyName(entry.authors[0]);
  const match = page.papers.find(
    (p) =>
      normalizeTitle(p.title) === target &&
      (!entry.year || !p.year || Math.abs(p.year - entry.year) <= 1) &&
      (!family || !p.authors.length || normalizeAuthorFamilyName(p.authors[0]?.name) === family),
  );
  if (!match) return null;
  const [id] = await ingestPapers([match]);
  return id;
}

async function createUserPaper(workspaceId: string, entry: ParsedBibEntry): Promise<string> {
  const title = entry.title ?? entry.doi ?? entry.arxiv ?? entry.key;
  const [row] = await db
    .insert(papers)
    .values({
      ownerWorkspaceId: workspaceId,
      source: "user",
      title,
      abstract: entry.abstract,
      year: entry.year,
      venue: entry.venue,
      authors: entry.authors.map((name) => ({ name })),
      authorsText: entry.authors.join(", "),
      url: entry.url,
      titleNorm: normalizeTitle(title),
      firstAuthorNorm: normalizeAuthorFamilyName(entry.authors[0]),
      publicationTypes: [],
    })
    .returning({ id: papers.id });
  const ids = [
    entry.doi ? { kind: "doi" as const, value: entry.doi } : null,
    entry.arxiv ? { kind: "arxiv" as const, value: entry.arxiv } : null,
  ].filter((x): x is NonNullable<typeof x> => !!x);
  if (ids.length) {
    await db
      .insert(paperIdentifiers)
      .values(ids.map((i) => ({ ...i, paperId: row.id, scope: workspaceId })))
      .onConflictDoNothing();
  }
  return row.id;
}

async function resolveItem(workspaceId: string, item: ImportItem): Promise<{ id: string | null; created: boolean }> {
  if (item.kind === "identifier") return { id: await resolveIdentifier(item.value), created: false };
  const e = item.entry;
  let id: string | null = null;
  if (e.arxiv) id = await resolveIdentifier(`arXiv:${e.arxiv}`);
  if (!id && e.doi && !/^10\.48550\/arxiv\./.test(e.doi)) id = await resolveIdentifier(e.doi);
  if (!id) id = await findByTitle(e);
  if (id) return { id, created: false };
  return { id: await createUserPaper(workspaceId, e), created: true };
}

export async function runImport(jobId: number, payload: ImportPayload): Promise<ImportResult> {
  const result: ImportResult = { total: payload.items.length, processed: 0, matched: 0, created: 0, failed: [] };
  const resolved: string[] = [];
  for (const item of payload.items) {
    const label = item.kind === "identifier" ? item.value : (item.entry.title ?? item.entry.key);
    try {
      const { id, created } = await resolveItem(payload.workspaceId, item);
      if (id) {
        await savePaper(payload.workspaceId, payload.userId, id);
        resolved.push(id);
        if (created) result.created++;
        else result.matched++;
      } else {
        result.failed.push({ label, reason: "Not found in scholarly sources" });
      }
    } catch (err) {
      result.failed.push({ label, reason: err instanceof Error ? err.message : "Unknown error" });
    }
    result.processed++;
    if (result.processed % 5 === 0) await db.update(jobs).set({ result }).where(eq(jobs.id, jobId));
  }
  if (payload.collectionId && resolved.length) {
    await addToCollection(payload.workspaceId, payload.userId, payload.collectionId, [...new Set(resolved)]);
  }
  return result;
}
