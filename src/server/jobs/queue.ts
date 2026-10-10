/**
 * Minimal durable job queue on PostgreSQL.
 *
 * Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so any number of worker loops (in one or
 * many app instances) can run safely. Failed jobs are retried with exponential backoff up to
 * `max_attempts`; the last error is stored for display. Jobs left "running" by a crashed
 * process are re-queued after a timeout. Handlers must be idempotent.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { JobDto } from "@/lib/types";
import { db } from "@/server/db/client";
import { jobs } from "@/server/db/schema";

export interface EnqueueInput {
  type: string;
  payload?: Record<string, unknown>;
  workspaceId?: string | null;
  dedupeKey?: string;
  maxAttempts?: number;
  runAt?: Date;
}

export async function enqueueJob(input: EnqueueInput): Promise<number | null> {
  const rows = await db
    .insert(jobs)
    .values({
      type: input.type,
      payload: input.payload ?? {},
      workspaceId: input.workspaceId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      maxAttempts: input.maxAttempts ?? 3,
      runAt: input.runAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

export type JobRow = typeof jobs.$inferSelect;

const STALE_LOCK = "15 minutes";

/** Claims the next runnable job, or returns null. */
export async function claimJob(): Promise<JobRow | null> {
  const rows = await db.execute<{ id: number }>(sql`
    update ${jobs} set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
    where id = (
      select id from ${jobs}
      where (status = 'queued' and run_at <= now())
         or (status = 'running' and locked_at < now() - interval '${sql.raw(STALE_LOCK)}')
      order by run_at
      for update skip locked
      limit 1
    )
    returning id`);
  const id = rows[0]?.id;
  if (!id) return null;
  const [job] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.id, Number(id)));
  return job ?? null;
}

export async function completeJob(id: number, result: unknown) {
  await db
    .update(jobs)
    .set({ status: "succeeded", result: result ?? null, lockedAt: null, lastError: null })
    .where(eq(jobs.id, id));
}

export async function failJob(job: JobRow, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const retry = job.attempts < job.maxAttempts;
  const backoffSeconds = Math.min(30 * 2 ** (job.attempts - 1), 3600);
  await db
    .update(jobs)
    .set({
      status: retry ? "queued" : "failed",
      lastError: message.slice(0, 2000),
      lockedAt: null,
      runAt: retry ? new Date(Date.now() + backoffSeconds * 1000) : job.runAt,
    })
    .where(eq(jobs.id, job.id));
}

export function toJobDto(j: JobRow): JobDto {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    lastError: j.lastError,
    result: j.result,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

export async function getWorkspaceJob(workspaceId: string, id: number) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.workspaceId, workspaceId)));
  return job ?? null;
}

export async function listWorkspaceJobs(workspaceId: string, limit = 20) {
  return db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId)).orderBy(desc(jobs.createdAt)).limit(limit);
}
