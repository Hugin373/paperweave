/** Queues embedding work (kept separate from index.ts so callers do not load the model code). */
import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { enqueueJob } from "@/server/jobs/queue";

/** Embeds a PDF after its text was extracted (or it moved to a new version). */
export function queueFileEmbedding(workspaceId: string, fileId: string) {
  return enqueueJob({ type: "embed_file", payload: { fileId }, workspaceId, dedupeKey: `embed_file:${fileId}` });
}

/** Brings a workspace's embeddings up to date shortly (notes and saved papers change often; one run covers them). */
export function queueWorkspaceEmbedding(workspaceId: string, delayMs = 60_000) {
  return enqueueJob({
    type: "embed_workspace",
    workspaceId,
    dedupeKey: `embed_workspace:${workspaceId}`,
    runAt: new Date(Date.now() + delayMs),
  });
}

/** Queues an update for every workspace that has saved papers or notes. */
export async function queueEmbeddingBackfill() {
  const rows = await db.execute<{ id: string }>(sql`
    select w.id from workspaces w
    where exists (select 1 from library_items li where li.workspace_id = w.id)
       or exists (select 1 from notes n where n.workspace_id = w.id)`);
  for (const r of rows) await queueWorkspaceEmbedding(r.id, 0);
  return rows.length;
}
