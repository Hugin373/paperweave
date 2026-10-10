/**
 * Server start-up on the Node.js runtime (imported from instrumentation.ts only there, so Node-only
 * APIs like process.exit never reach the Edge build).
 */
import { env } from "@/server/env";

export async function startNodeServer() {
  if (env().AUTO_MIGRATE) {
    // The schema must match this copy of the code before anything touches the database.
    const { ensureSchema, SchemaTooNewError } = await import("@/server/db/migrate");
    try {
      const { applied } = await ensureSchema(env().DATABASE_URL, { apply: true });
      if (applied) console.log("[db] applied pending database migrations");
    } catch (err) {
      if (err instanceof SchemaTooNewError) {
        console.error(`\n[db] ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
  }
  if (env().RUN_WORKER_IN_PROCESS) {
    const { startWorker } = await import("@/server/jobs/worker");
    startWorker();
  }
}
