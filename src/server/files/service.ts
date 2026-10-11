import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { VersionNotice } from "@/lib/types";
import { db, type Executor } from "@/server/db/client";
import { highlights, paperFilePages, paperFiles, paperIdentifiers } from "@/server/db/schema";
import { env } from "@/server/env";
import { AppError, badRequest, notFound } from "@/server/http";
import { enqueueJob } from "@/server/jobs/queue";
import { readLimited, safeFetch, UnsafeUrlError } from "@/server/net/safe-fetch";
import { pdfUrlVariants, serverCanFetchPdf } from "@/server/scholarly/free-pdf";
import { getVisiblePaper } from "@/server/papers/service";
import { scholarly } from "@/server/scholarly/service";
import { queueFileEmbedding } from "@/server/embeddings/queue";
import { anchorHighlight, readPdfContents } from "./anchor";
import { arxivIdOfPdfUrl } from "./info";
import { parseRange, storage } from "./storage";

export type FileRow = typeof paperFiles.$inferSelect;

const maxBytes = () => env().MAX_PDF_MB * 1024 * 1024;

export function isPdf(bytes: Uint8Array): boolean {
  // "%PDF-" may be preceded by a few junk bytes in real-world files.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

function safeFilename(name: string) {
  const base =
    name
      .replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_")
      .trim()
      .slice(0, 180) || "paper.pdf";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

function assertPdf(bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw badRequest("The file is empty.");
  if (bytes.byteLength > maxBytes()) throw badRequest(`PDFs must be smaller than ${env().MAX_PDF_MB} MB.`);
  if (!isPdf(bytes)) throw badRequest("That file is not a valid PDF.");
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const objectKey = (workspaceId: string, paperId: string) =>
  `workspaces/${workspaceId}/papers/${paperId}/${randomUUID()}.pdf`;

const g = globalThis as unknown as {
  __pwOaText?: Map<string, { pages: string[] | null; at: number }>;
  __pwPdfBytes?: Map<string, { bytes: Uint8Array; at: number }>;
};

// A live PDF was just downloaded to check it; text extraction reuses those bytes instead of downloading
// it again.
const recentBytes = (g.__pwPdfBytes ??= new Map());
const RECENT_BYTES_MS = 10 * 60_000;

function rememberBytes(fileId: string, bytes: Uint8Array) {
  recentBytes.set(fileId, { bytes, at: Date.now() });
  while (recentBytes.size > 4) recentBytes.delete(recentBytes.keys().next().value!);
}

/** The PDF's bytes: from storage, or (live PDFs) from its source. */
export async function fileBytes(file: FileRow): Promise<Uint8Array> {
  const recent = recentBytes.get(file.id);
  // A copy: pdf.js takes ownership of the buffers it is given.
  if (recent && Date.now() - recent.at < RECENT_BYTES_MS) return recent.bytes.slice();
  if (file.storageKey) return storage().getBytes(file.storageKey);
  if (!file.sourceUrl) throw notFound("File");
  return downloadPdf(file.sourceUrl);
}

async function saveFile(input: {
  workspaceId: string;
  userId: string;
  paperId: string;
  bytes: Uint8Array;
  filename: string;
  source: FileRow["source"];
  sourceUrl: string | null;
  /** Read from the source each time instead of stored. */
  live?: boolean;
  version?: string | null;
}): Promise<FileRow> {
  assertPdf(input.bytes);
  const sha256 = sha256Of(input.bytes);
  const [existing] = await db
    .select()
    .from(paperFiles)
    .where(
      and(
        eq(paperFiles.workspaceId, input.workspaceId),
        eq(paperFiles.paperId, input.paperId),
        eq(paperFiles.sha256, sha256),
      ),
    );
  if (existing) return existing;

  const key = input.live ? null : objectKey(input.workspaceId, input.paperId);
  if (key) await storage().put(key, input.bytes, "application/pdf");
  const [row] = await db
    .insert(paperFiles)
    .values({
      workspaceId: input.workspaceId,
      paperId: input.paperId,
      storageKey: key,
      source: input.source,
      sourceUrl: input.sourceUrl,
      version: input.version ?? null,
      checkedAt: input.source === "open_access" ? new Date() : null,
      filename: safeFilename(input.filename),
      sizeBytes: input.bytes.byteLength,
      sha256,
      createdBy: input.userId,
    })
    .returning();
  rememberBytes(row.id, input.bytes);
  await enqueueJob({
    type: "extract_pdf_text",
    payload: { fileId: row.id },
    workspaceId: input.workspaceId,
    dedupeKey: `extract_pdf_text:${row.id}`,
  });
  return row;
}

export async function uploadPdf(workspaceId: string, userId: string, paperId: string, file: File): Promise<FileRow> {
  await getVisiblePaper(workspaceId, paperId);
  if (file.size > maxBytes()) throw badRequest(`PDFs must be smaller than ${env().MAX_PDF_MB} MB.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return saveFile({ workspaceId, userId, paperId, bytes, filename: file.name, source: "upload", sourceUrl: null });
}

/** Downloads one candidate URL and validates that it really is a PDF. */
const PDF_REQUEST_HEADERS = {
  Accept: "application/pdf,*/*;q=0.8",
  "User-Agent": "Paperweave/1.0 (+open-access retrieval)",
};

/** Downloads a PDF link, trying its better versions first (e.g. Nature's final PDF before its preview). */
async function downloadPdf(target: string): Promise<Uint8Array> {
  const variants = pdfUrlVariants(target); // ends with the link itself
  for (const url of variants.slice(0, -1)) {
    try {
      return await downloadOnePdf(url);
    } catch {
      /* not there (yet): try the next version */
    }
  }
  return downloadOnePdf(target);
}

async function downloadOnePdf(target: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await safeFetch(target, { timeoutMs: 45000, headers: PDF_REQUEST_HEADERS });
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw badRequest(err.message);
    throw new AppError(502, "pdf_unavailable", "The PDF could not be downloaded. The host may be unavailable.");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new AppError(
      502,
      "pdf_unavailable",
      res.status === 403 || res.status === 401
        ? "The PDF host refused access. The paper may not be openly available — try uploading it."
        : `The PDF host responded with an error (HTTP ${res.status}).`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(res, maxBytes());
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw badRequest(`PDFs must be smaller than ${env().MAX_PDF_MB} MB.`);
    throw new AppError(502, "pdf_unavailable", "The PDF download was interrupted.");
  }
  if (!isPdf(bytes)) {
    throw new AppError(
      422,
      "not_a_pdf",
      "That link did not return a PDF (it may be a landing page or require a login). Try uploading the file instead.",
    );
  }
  return bytes;
}

/** A place a legal copy of a paper's PDF can be fetched from. */
export type PdfSource = { kind: "url"; url: string } | { kind: "openreview"; forumId: string };

/** An arXiv PDF link resolved to its newest version (links to one version never change). */
async function newestArxivPdf(id: string, fresh = false): Promise<{ url: string; version: string | null }> {
  const latest = await scholarly().arxivLatestVersion(id, fresh);
  return latest
    ? { url: `https://arxiv.org/pdf/${id}v${latest}`, version: `v${latest}` }
    : { url: `https://arxiv.org/pdf/${id}`, version: null };
}

async function identifiersOf(paperId: string) {
  const rows = await db
    .select({ kind: paperIdentifiers.kind, value: paperIdentifiers.value })
    .from(paperIdentifiers)
    .where(eq(paperIdentifiers.paperId, paperId));
  return Object.fromEntries(rows.map((r) => [r.kind, r.value])) as Partial<
    Record<(typeof rows)[number]["kind"], string>
  >;
}

/**
 * Legal open-access copies of a paper's PDF, in order: the canonical arXiv PDF, the URL reported by
 * scholarly sources, Unpaywall's locations for the DOI (publisher sites, repositories), and the
 * OpenReview submission (when an OpenReview account is configured).
 */
export async function openAccessCandidates(workspaceId: string, paperId: string): Promise<PdfSource[]> {
  const paper = await getVisiblePaper(workspaceId, paperId);
  const ids = await identifiersOf(paperId);
  const urls = [
    ids.arxiv ? `https://arxiv.org/pdf/${ids.arxiv}` : null,
    paper.openAccessPdfUrl,
    ...(ids.doi && !ids.doi.startsWith("10.48550/") ? await scholarly().unpaywallPdfs(ids.doi) : []),
  ].filter((u): u is string => serverCanFetchPdf(u));
  const sources: PdfSource[] = [...new Set(urls)].map((url) => ({ kind: "url", url }));
  if (ids.openreview && env().OPENREVIEW_USERNAME && env().OPENREVIEW_PASSWORD) {
    sources.push({ kind: "openreview", forumId: ids.openreview });
  }
  return sources;
}

async function fetchSource(source: PdfSource): Promise<{ bytes: Uint8Array; url: string }> {
  if (source.kind === "url") return { bytes: await downloadPdf(source.url), url: source.url };
  const bytes = await scholarly().openReviewPdf(source.forumId);
  if (!bytes || !isPdf(bytes)) throw new AppError(502, "pdf_unavailable", "OpenReview did not return the PDF.");
  if (bytes.byteLength > maxBytes()) throw badRequest(`PDFs must be smaller than ${env().MAX_PDF_MB} MB.`);
  return { bytes, url: `https://openreview.net/pdf?id=${source.forumId}` };
}

/**
 * A paper's PDF for looking at its pages: the workspace's newest file, else its legal open-access copy
 * (downloaded, not stored). Null when neither exists.
 */
export async function paperPdfBytes(workspaceId: string, paperId: string): Promise<Uint8Array | null> {
  const [file] = await db
    .select()
    .from(paperFiles)
    .where(and(eq(paperFiles.workspaceId, workspaceId), eq(paperFiles.paperId, paperId)))
    .orderBy(desc(paperFiles.createdAt))
    .limit(1);
  if (file) return fileBytes(file);
  for (const source of await openAccessCandidates(workspaceId, paperId)) {
    try {
      return (await fetchSource(source)).bytes;
    } catch {
      /* try the next copy */
    }
  }
  return null;
}

/** The per-page text of the PDF at a URL (downloaded through the safe fetch, not stored). */
export async function pdfTextAt(url: string): Promise<string[]> {
  return pdfPageTexts(await downloadPdf(url));
}

/** Per-page text of a PDF. */
async function pdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js may take ownership of the buffer it is given, so it gets a copy.
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).map((t) =>
    t
      .replace(/\u0000/g, "")
      .replace(/[ \t]+/g, " ")
      .slice(0, 100_000),
  );
}

const oaTextCache = (g.__pwOaText ??= new Map());
const OA_TEXT_TTL_MS = 60 * 60_000;

/**
 * The text of a paper's open-access PDF, fetched for reading by the AI assistant without storing the
 * file (kept briefly in memory). Returns null when no open-access copy can be read.
 */
export async function openAccessPageTexts(workspaceId: string, paperId: string): Promise<string[] | null> {
  const cached = oaTextCache.get(paperId);
  if (cached && Date.now() - cached.at < OA_TEXT_TTL_MS) return cached.pages;
  let pages: string[] | null = null;
  for (const source of await openAccessCandidates(workspaceId, paperId)) {
    try {
      pages = await pdfPageTexts((await fetchSource(source)).bytes);
      break;
    } catch {
      /* try the next copy */
    }
  }
  oaTextCache.set(paperId, { pages, at: Date.now() });
  if (oaTextCache.size > 50) oaTextCache.delete(oaTextCache.keys().next().value!);
  return pages;
}

/**
 * Adds a paper's PDF from a link. The paper's free, legal copy (the canonical arXiv PDF first when the
 * paper is on arXiv, then the links reported by scholarly sources) is live: it is read from its source
 * each time, so it is always the current version and takes no storage. A link supplied by the user is
 * stored, since such links often stop working. OpenReview copies need a login and are stored too.
 */
export async function attachPdfFromUrl(
  workspaceId: string,
  userId: string,
  paperId: string,
  url?: string,
): Promise<FileRow> {
  if (!url) {
    // The free copy is added once; reading it again opens the same PDF and its highlights.
    const [existing] = await db
      .select()
      .from(paperFiles)
      .where(
        and(
          eq(paperFiles.workspaceId, workspaceId),
          eq(paperFiles.paperId, paperId),
          eq(paperFiles.source, "open_access"),
        ),
      )
      .orderBy(desc(paperFiles.createdAt))
      .limit(1);
    if (existing) return existing;
  }
  const candidates: PdfSource[] = url ? [{ kind: "url", url }] : await openAccessCandidates(workspaceId, paperId);
  if (!candidates.length) {
    throw badRequest("No free, legal copy of this paper's PDF was found. You can upload one instead.");
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const arxivId = !url && candidate.kind === "url" ? arxivIdOfPdfUrl(candidate.url) : null;
      const newest = arxivId ? await newestArxivPdf(arxivId) : null;
      const { bytes, url: target } = await fetchSource(newest ? { kind: "url", url: newest.url } : candidate);
      const name =
        candidate.kind === "openreview"
          ? `${candidate.forumId}.pdf`
          : decodeURIComponent(new URL(target).pathname.split("/").pop() || "paper") || "paper";
      return await saveFile({
        workspaceId,
        userId,
        paperId,
        bytes,
        filename: name,
        source: url ? "external_url" : "open_access",
        sourceUrl: target,
        live: !url && candidate.kind === "url",
        version: newest?.version ?? null,
      });
    } catch (err) {
      // A user-supplied URL (or an invalid one) fails immediately; otherwise try the next copy.
      if (url || (err instanceof AppError && err.status === 400)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

export async function getWorkspaceFile(workspaceId: string, fileId: string): Promise<FileRow> {
  const [row] = await db
    .select()
    .from(paperFiles)
    .where(and(eq(paperFiles.id, fileId), eq(paperFiles.workspaceId, workspaceId)));
  if (!row) throw notFound("File");
  return row;
}

/**
 * A Content-Disposition value safe for any filename: header values must be Latin-1, so a plain
 * ASCII fallback goes in `filename` and the real name, percent-encoded, in `filename*` (RFC 6266).
 */
export function contentDisposition(type: "inline" | "attachment", filename: string) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "file.pdf";
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Streams a PDF, honoring HTTP range requests so pdf.js can load pages lazily. With `download`, the
 * browser saves it as a file instead of showing it.
 */
export async function streamFile(file: FileRow, rangeHeader: string | null, download = false): Promise<Response> {
  const disposition = contentDisposition(download ? "attachment" : "inline", file.filename);
  if (!file.storageKey) return streamLive(file, rangeHeader, disposition);
  const range = parseRange(rangeHeader, file.sizeBytes);
  if (range && (range.start >= file.sizeBytes || (range.end !== undefined && range.end < range.start))) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.sizeBytes}` } });
  }
  const obj = await storage().get(file.storageKey, range);
  const headers: Record<string, string> = {
    "Content-Type": "application/pdf",
    "Content-Length": String(obj.contentLength),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": disposition,
    "X-Content-Type-Options": "nosniff",
  };
  if (obj.partial && obj.contentRange) headers["Content-Range"] = obj.contentRange;
  return new Response(obj.body, { status: obj.partial ? 206 : 200, headers });
}

/** The first of these URLs that answers with a PDF (or the last one's response, whatever it is). */
async function fetchFirstOk(urls: string[], opts: Parameters<typeof safeFetch>[1]): Promise<Response> {
  for (const [i, url] of urls.entries()) {
    const last = i === urls.length - 1;
    try {
      const res = await safeFetch(url, opts);
      if (last || (res.ok && /pdf|octet-stream/i.test(res.headers.get("content-type") ?? ""))) return res;
      await res.body?.cancel();
    } catch (err) {
      if (last) throw err;
    }
  }
  throw new Error("no URL to fetch");
}

/**
 * Passes a live PDF through from its source without storing it (for sources that do not let the
 * browser load them directly). Range requests are forwarded when the source supports them.
 */
async function streamLive(file: FileRow, rangeHeader: string | null, disposition: string): Promise<Response> {
  const host = file.sourceUrl ? new URL(file.sourceUrl).hostname : "its source";
  let res: Response;
  try {
    if (!file.sourceUrl) throw new Error("no source");
    // A better version of the link first (Nature's final PDF instead of its "article in press" preview).
    res = await fetchFirstOk(pdfUrlVariants(file.sourceUrl), {
      timeoutMs: 120_000,
      headers: { ...PDF_REQUEST_HEADERS, ...(rangeHeader ? { Range: rangeHeader } : {}) },
    });
  } catch {
    throw new AppError(502, "pdf_unavailable", `The PDF could not be loaded from ${host}. Try again later.`);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    if (res.status === 416) return new Response(null, { status: 416 });
    throw new AppError(502, "pdf_unavailable", `${host} responded with an error (HTTP ${res.status}).`);
  }
  // A compressed response is decoded on the way in, so its length and byte ranges no longer apply.
  const encoded = !!res.headers.get("content-encoding");
  const headers: Record<string, string> = {
    "Content-Type": "application/pdf",
    "Cache-Control": "private, max-age=300",
    "Content-Disposition": disposition,
    "X-Content-Type-Options": "nosniff",
  };
  const length = res.headers.get("content-length");
  if (length && !encoded) headers["Content-Length"] = length;
  if (!encoded && res.headers.get("accept-ranges") === "bytes") headers["Accept-Ranges"] = "bytes";
  const contentRange = res.headers.get("content-range");
  if (res.status === 206 && contentRange && !encoded) headers["Content-Range"] = contentRange;
  let total = 0;
  const limit = maxBytes();
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limit) controller.error(new Error("The PDF is too large."));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: res.status === 206 && !encoded ? 206 : 200, headers });
}

export async function deleteFile(workspaceId: string, fileId: string) {
  const file = await getWorkspaceFile(workspaceId, fileId);
  await db.delete(paperFiles).where(eq(paperFiles.id, file.id));
  if (file.storageKey) await deleteObject(file.storageKey);
}

function deleteObject(key: string) {
  return storage()
    .delete(key)
    .catch((err) => console.error("[files] could not delete object", key, err));
}

// ---------------------------------------------------------------------------
// New versions
// ---------------------------------------------------------------------------

/** How long a check for a newer version is trusted. arXiv answers cheaply; other sources mean a download. */
function checkInterval(file: FileRow, arxivId: string | null) {
  if (arxivId) return 60 * 60_000;
  return file.storageKey ? 24 * 60 * 60_000 : 10 * 60_000;
}

/** The source's current PDF for a file: the newest arXiv version, or whatever its link serves now. */
async function currentSource(file: FileRow, fresh: boolean): Promise<{ url: string; version: string | null }> {
  const arxivId = arxivIdOfPdfUrl(file.sourceUrl);
  if (arxivId) return newestArxivPdf(arxivId, fresh);
  return { url: file.sourceUrl!, version: null };
}

/** Runs `fn` unless another request is already doing it for this file (then returns null). */
async function withFileLock<T>(fileId: string, fn: (tx: Executor) => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${"paperweave:file:" + fileId})) as locked`,
    );
    return row?.locked ? fn(tx) : null;
  });
}

export interface VersionCheck {
  file: FileRow;
  /** The PDF was replaced by a newer version. */
  updated: boolean;
}

/**
 * Checks a free PDF's source for a newer version and, when there is one, moves to it: its text is
 * re-extracted and each highlight is found again by its text (those whose text is gone are marked
 * lost, never deleted). Uploads and user-supplied links are never checked. Without `force`, a recent
 * check is trusted; failures leave the PDF as it is.
 */
export async function checkForNewVersion(
  workspaceId: string,
  fileId: string,
  opts: { force?: boolean } = {},
): Promise<VersionCheck> {
  const file = await getWorkspaceFile(workspaceId, fileId);
  if (file.source !== "open_access" || !file.sourceUrl) return { file, updated: false };
  const arxivId = arxivIdOfPdfUrl(file.sourceUrl);
  const due = !file.checkedAt || Date.now() - file.checkedAt.getTime() > checkInterval(file, arxivId);
  if (!opts.force && !due) return { file, updated: false };
  try {
    const result = await withFileLock(file.id, async (tx) => {
      const [current] = await tx.select().from(paperFiles).where(eq(paperFiles.id, file.id));
      if (!current) throw notFound("File");
      const source = await currentSource(current, !!opts.force);
      // arXiv numbers its versions: the same number means the same PDF, without downloading it.
      if (arxivId && source.version && source.version === current.version) {
        const [row] = await tx
          .update(paperFiles)
          .set({ checkedAt: new Date() })
          .where(eq(paperFiles.id, file.id))
          .returning();
        return { file: row, updated: false };
      }
      const bytes = await downloadPdf(source.url);
      return moveToVersion(tx, current, { bytes, ...source }, { live: !current.storageKey });
    });
    return result ?? { file, updated: false };
  } catch (err) {
    if (opts.force) throw err;
    console.warn("[files] version check failed", file.id, err instanceof Error ? err.message : err);
    return { file, updated: false };
  }
}

/**
 * Points a file at a (possibly) new PDF from its source. The same bytes only update the link and
 * version; different bytes become the file's new version, with its text and highlights moved over.
 * `live` decides whether the PDF is stored.
 */
async function moveToVersion(
  tx: Executor,
  file: FileRow,
  next: { bytes: Uint8Array; url: string; version: string | null },
  opts: { live: boolean },
): Promise<VersionCheck> {
  assertPdf(next.bytes);
  const sha256 = sha256Of(next.bytes);
  const now = new Date();
  const changed = sha256 !== file.sha256;
  if (changed) {
    // Another copy of this paper already holds exactly this PDF (e.g. it was uploaded): keep both as they are.
    const [twin] = await tx
      .select({ id: paperFiles.id })
      .from(paperFiles)
      .where(
        and(
          eq(paperFiles.workspaceId, file.workspaceId),
          eq(paperFiles.paperId, file.paperId),
          eq(paperFiles.sha256, sha256),
          ne(paperFiles.id, file.id),
        ),
      );
    if (twin) {
      const [row] = await tx.update(paperFiles).set({ checkedAt: now }).where(eq(paperFiles.id, file.id)).returning();
      return { file: row, updated: false };
    }
  }
  const key = opts.live
    ? null
    : changed || !file.storageKey
      ? objectKey(file.workspaceId, file.paperId)
      : file.storageKey;
  const stored = key && key !== file.storageKey ? key : null;
  if (stored) await storage().put(stored, next.bytes, "application/pdf");
  try {
    const row = await applyVersion(tx, file, next, { sha256, changed, key, now });
    rememberBytes(file.id, next.bytes);
    if (changed) await queueFileEmbedding(file.workspaceId, file.id);
    if (file.storageKey && file.storageKey !== key) await deleteObject(file.storageKey);
    return { file: row, updated: changed };
  } catch (err) {
    if (stored) await deleteObject(stored);
    throw err;
  }
}

/** The database side of `moveToVersion`: re-anchored highlights, new page texts and the file row. */
async function applyVersion(
  tx: Executor,
  file: FileRow,
  next: { bytes: Uint8Array; url: string; version: string | null },
  { sha256, changed, key, now }: { sha256: string; changed: boolean; key: string | null; now: Date },
): Promise<FileRow> {
  let notice: VersionNotice | null = file.versionNotice ?? null;
  let pageCount = file.pageCount;
  if (changed) {
    const { texts, layouts } = await readPdfContents(next.bytes);
    const rows = await tx.select().from(highlights).where(eq(highlights.fileId, file.id));
    let moved = 0;
    for (const h of rows) {
      const placed = anchorHighlight(layouts, h);
      if (placed) moved++;
      await tx
        .update(highlights)
        .set(placed ? { pageNumber: placed.pageNumber, rects: placed.rects, anchorLost: false } : { anchorLost: true })
        .where(eq(highlights.id, h.id));
    }
    await tx.delete(paperFilePages).where(eq(paperFilePages.fileId, file.id));
    const pages = texts.map((text, i) => ({ fileId: file.id, pageNumber: i + 1, text }));
    for (let i = 0; i < pages.length; i += 50) await tx.insert(paperFilePages).values(pages.slice(i, i + 50));
    pageCount = texts.length;
    notice = {
      // An earlier change the reader has not shown yet: the notice still starts from what was last read.
      from: file.versionNotice ? file.versionNotice.from : file.version,
      to: next.version,
      moved,
      lost: rows.length - moved,
      at: now.toISOString(),
    };
  }
  const [row] = await tx
    .update(paperFiles)
    .set({
      storageKey: key,
      sourceUrl: next.url,
      version: next.version,
      checkedAt: now,
      ...(changed
        ? {
            sha256,
            sizeBytes: next.bytes.byteLength,
            pageCount,
            textStatus: "ready" as const,
            textError: null,
            versionNotice: notice,
          }
        : {}),
    })
    .where(eq(paperFiles.id, file.id))
    .returning();
  return row;
}

/**
 * Switches a free PDF between live (read from its source each time, always current, no storage) and
 * stored (a copy kept here, e.g. for offline reading). Either way it moves to the source's current
 * version first, so the switch never strands highlights on a different PDF.
 */
export async function setFileLive(workspaceId: string, fileId: string, live: boolean): Promise<VersionCheck> {
  const file = await getWorkspaceFile(workspaceId, fileId);
  if (file.source !== "open_access" || !file.sourceUrl) {
    throw badRequest("Only free PDFs found by Paperweave can be read live; uploads are always stored.");
  }
  if (live === !file.storageKey) return { file, updated: false };
  const result = await withFileLock(file.id, async (tx) => {
    const [current] = await tx.select().from(paperFiles).where(eq(paperFiles.id, file.id));
    if (!current) throw notFound("File");
    const source = await currentSource(current, true);
    return moveToVersion(tx, current, { bytes: await downloadPdf(source.url), ...source }, { live });
  });
  if (!result) throw new AppError(409, "busy", "This PDF is being updated. Try again in a moment.");
  return result;
}

/** The reader has shown the "updated to a newer version" notice. */
export async function dismissVersionNotice(workspaceId: string, fileId: string) {
  const file = await getWorkspaceFile(workspaceId, fileId);
  await db.update(paperFiles).set({ versionNotice: null }).where(eq(paperFiles.id, file.id));
}

/** Background job: extracts per-page text used for workspace search and AI context. */
export async function extractPdfText(fileId: string) {
  const [file] = await db.select().from(paperFiles).where(eq(paperFiles.id, fileId));
  if (!file) return { skipped: "file deleted" };
  await db.update(paperFiles).set({ textStatus: "processing", textError: null }).where(eq(paperFiles.id, fileId));
  try {
    const texts = await pdfPageTexts(await fileBytes(file));
    const totalPages = texts.length;
    const pages = texts.map((text, i) => ({ fileId, pageNumber: i + 1, text }));
    await db.transaction(async (tx) => {
      await tx.delete(paperFilePages).where(eq(paperFilePages.fileId, fileId));
      for (let i = 0; i < pages.length; i += 50) await tx.insert(paperFilePages).values(pages.slice(i, i + 50));
      await tx
        .update(paperFiles)
        .set({ pageCount: totalPages, textStatus: "ready", textError: null })
        .where(eq(paperFiles.id, fileId));
    });
    await queueFileEmbedding(file.workspaceId, fileId);
    return { pages: totalPages };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(paperFiles)
      .set({ textStatus: "failed", textError: `Text could not be extracted: ${message}`.slice(0, 500) })
      .where(eq(paperFiles.id, fileId));
    // A malformed PDF will not get better on retry; the reader still works without text.
    return { failed: message };
  }
}
