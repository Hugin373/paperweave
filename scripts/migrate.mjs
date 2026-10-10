/**
 * Applies pending database migrations from ./drizzle (idempotent).
 * Usage: npm run db:migrate   — or in the container: node scripts/migrate.mjs
 * Reads DATABASE_URL from the environment (or from .env when present).
 *
 * The app does the same on start (src/server/db/migrate.ts): migrations run under an advisory lock so
 * two computers sharing one database never migrate at once, and an older copy of the code refuses to
 * touch a database that a newer copy has already migrated.
 */
import { existsSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

if (existsSync(".env")) process.loadEnvFile(".env");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

/** Drops libpq-only options (e.g. Neon's channel_binding) that postgres.js would send to the server. */
function postgresUrl(raw) {
  try {
    const u = new URL(raw);
    for (const p of ["channel_binding", "gssencmode", "target_session_attrs"]) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return raw;
  }
}

const LOCK_ID = 7_239_001;
const journal = JSON.parse(readFileSync("./drizzle/meta/_journal.json", "utf8"));
const known = Math.max(...journal.entries.map((e) => e.when));

const sql = postgres(postgresUrl(url), { max: 1, onnotice: () => {} });
try {
  await sql`select pg_advisory_lock(${LOCK_ID})`;
  const [{ exists }] = await sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
  const applied = exists
    ? Number((await sql`select max(created_at)::text as at from drizzle.__drizzle_migrations`)[0].at ?? 0)
    : 0;
  if (applied > known) {
    console.error(
      "This database was updated by a newer version of Paperweave than this copy. Update this copy first (git pull, then npm install).",
    );
    process.exitCode = 1;
  } else {
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    console.log("Database migrations are up to date.");
  }
} catch (err) {
  console.error("Migration failed:", err);
  process.exitCode = 1;
} finally {
  await sql`select pg_advisory_unlock(${LOCK_ID})`.catch(() => {});
  await sql.end();
}
