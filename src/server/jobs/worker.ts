/**
 * In-process job worker. Started from instrumentation.ts when RUN_WORKER_IN_PROCESS=true.
 */
import { purgeExpiredCache } from "@/server/scholarly/cache";
import { claimJob, completeJob, enqueueJob, failJob, type JobRow } from "./queue";
import { runInBackground } from "@/server/scholarly/http";

type JobHandler = (job: JobRow) => Promise<unknown>;

const handlers: Record<string, JobHandler> = {
  async sync_references(job) {
    const { syncCitationPage, REFERENCE_PAGE } = await import("@/server/papers/citations");
    const { paperId } = job.payload as { paperId: string };
    const { resolved } = await syncCitationPage(paperId, "references", 0, REFERENCE_PAGE);
    return { references: resolved.length };
  },
  async extract_pdf_text(job) {
    const { extractPdfText } = await import("@/server/files/service");
    return extractPdfText((job.payload as { fileId: string }).fileId);
  },
  async import(job) {
    const { runImport } = await import("@/server/import/import");
    return runImport(job.id, job.payload as never);
  },
  async purge_cache() {
    return { purged: await purgeExpiredCache() };
  },
  async find_open_access(job) {
    const { checkOpenAccess } = await import("@/server/papers/open-access");
    return { found: await checkOpenAccess((job.payload as { paperId: string }).paperId) };
  },
  async open_access_backfill() {
    const { queueOpenAccessBackfill } = await import("@/server/papers/open-access");
    return { queued: await queueOpenAccessBackfill() };
  },
  async embed_file(job) {
    const { indexFile } = await import("@/server/embeddings/index");
    return indexFile((job.payload as { fileId: string }).fileId);
  },
  async embed_workspace(job) {
    const { indexWorkspace } = await import("@/server/embeddings/index");
    return indexWorkspace(job.workspaceId!);
  },
  async find_arxiv_twin(job) {
    const { findArxivTwin } = await import("@/server/papers/arxiv-twin");
    return { arxiv: await findArxivTwin((job.payload as { paperId: string }).paperId) };
  },
  async arxiv_twin_backfill() {
    const { queueArxivTwinBackfill } = await import("@/server/papers/arxiv-twin");
    return { queued: await queueArxivTwinBackfill() };
  },
  async screen_papers(job) {
    const { screenBatch } = await import("@/server/screening/service");
    return screenBatch((job.payload as { screeningId: string }).screeningId);
  },
  async run_saved_search(job) {
    const { runSavedSearch } = await import("@/server/alerts/service");
    const { searchId, baseline } = job.payload as { searchId: string; baseline?: boolean };
    return runSavedSearch(searchId, baseline);
  },
  async saved_searches_daily() {
    const { queueAllSavedSearches } = await import("@/server/alerts/service");
    return { queued: await queueAllSavedSearches() };
  },
  async topic_suggestions(job) {
    const { generateTopicSuggestions } = await import("@/server/search/suggestions");
    return generateTopicSuggestions((job.payload as { workspaceId: string }).workspaceId);
  },
  async embed_backfill() {
    const { queueEmbeddingBackfill } = await import("@/server/embeddings/queue");
    return { queued: await queueEmbeddingBackfill() };
  },
};

export async function runOneJob(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`Unknown job type: ${job.type}`);
    await completeJob(job.id, await runInBackground(() => handler(job)));
  } catch (err) {
    console.error(`[jobs] ${job.type} #${job.id} failed (attempt ${job.attempts})`, err);
    await failJob(job, err);
  }
  return true;
}

let started = false;

export function startWorker({ idleMs = 2000, concurrency = 2 } = {}) {
  if (started) return;
  started = true;
  const loop = async () => {
    for (;;) {
      try {
        const worked = await runOneJob();
        if (!worked) await new Promise((r) => setTimeout(r, idleMs));
      } catch (err) {
        console.error("[jobs] worker loop error", err);
        await new Promise((r) => setTimeout(r, idleMs * 5));
      }
    }
  };
  for (let i = 0; i < concurrency; i++) void loop();
  const schedulePurge = () =>
    enqueueJob({ type: "purge_cache", dedupeKey: "purge_cache" }).catch((err) =>
      console.error("[jobs] could not schedule cache purge", err),
    );
  void schedulePurge();
  setInterval(schedulePurge, 6 * 3600_000).unref();
  // Free-PDF checks for saved journal papers (only does work when Unpaywall is enabled).
  const scheduleOpenAccess = () =>
    enqueueJob({ type: "open_access_backfill", dedupeKey: "open_access_backfill" }).catch((err) =>
      console.error("[jobs] could not schedule open-access checks", err),
    );
  void scheduleOpenAccess();
  setInterval(scheduleOpenAccess, 24 * 3600_000).unref();
  // Meaning-based search: keep every workspace's embeddings current (only changed texts are embedded).
  const scheduleEmbeddings = () =>
    enqueueJob({ type: "embed_backfill", dedupeKey: "embed_backfill" }).catch((err) =>
      console.error("[jobs] could not schedule embedding updates", err),
    );
  void scheduleEmbeddings();
  setInterval(scheduleEmbeddings, 3600_000).unref();
  // Saved searches look for new papers once a day.
  const scheduleAlerts = () =>
    enqueueJob({ type: "saved_searches_daily", dedupeKey: "saved_searches_daily" }).catch((err) =>
      console.error("[jobs] could not schedule saved searches", err),
    );
  void scheduleAlerts();
  setInterval(scheduleAlerts, 24 * 3600_000).unref();
  // Papers from OpenReview: look for their arXiv versions again (new postings take a while to be searchable).
  const scheduleTwins = () =>
    enqueueJob({ type: "arxiv_twin_backfill", dedupeKey: "arxiv_twin_backfill" }).catch((err) =>
      console.error("[jobs] could not schedule arXiv lookups", err),
    );
  void scheduleTwins();
  setInterval(scheduleTwins, 24 * 3600_000).unref();
}
