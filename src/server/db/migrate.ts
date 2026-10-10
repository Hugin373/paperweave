/**
 * Keeps the database schema and this copy of the code in step. On start: applies pending migrations
 * (under an advisory lock, so two computers starting at once do not both migrate), and refuses to run
 * when the database was migrated by a newer version of Paperweave — e.g. another computer that pulled
 * newer code — because this older code would misread it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { postgresUrl } from "./url";

const MIGRATIONS = path.join(process.cwd(), "drizzle");
const LOCK_ID = 7_239_001;

export class SchemaTooNewError extends Error {}

/** The newest migration this code knows (its creation time, as drizzle records it). */
function latestKnownMigration(): number {
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: { when: number }[];
  };
  return Math.max(...journal.entries.map((e) => e.when));
}

export async function ensureSchema(databaseUrl: string, opts: { apply: boolean }) {
  const sql = postgres(postgresUrl(databaseUrl), { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    const [{ exists }] = await sql<{ exists: boolean }[]>`
      select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
    const applied = exists
      ? Number(
          (await sql<{ at: string | null }[]>`select max(created_at)::text as at from drizzle.__drizzle_migrations`)[0]
            .at ?? 0,
        )
      : 0;
    const known = latestKnownMigration();
    if (applied > known) {
      throw new SchemaTooNewError(
        "This database was updated by a newer version of Paperweave than this copy. " +
          "Update this copy first (git pull, then npm install), then start it again.",
      );
    }
    if (applied < known && opts.apply) await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
    return { applied: applied < known && opts.apply };
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_ID})`.catch(() => {});
    await sql.end();
  }
}
