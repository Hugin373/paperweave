/**
 * Backs up Paperweave's data to this computer: the whole database (a pg_dump file) and the stored PDFs
 * (uploads and kept copies; live PDFs are not stored anywhere, so there is nothing to copy for them).
 *
 * Usage:  npm run backup                     — into ~/paperweave-backups
 *         npm run backup -- --dir <folder>   — somewhere else (or set BACKUP_DIR)
 *         npm run backup -- --keep 20        — keep the newest 20 database backups (default 12)
 *         npm run backup -- --no-files       — the database only
 *
 * Reads DATABASE_URL and the S3/R2 settings (or STORAGE_LOCAL_DIR) from .env. The database is dumped with a local `pg_dump` when
 * one at least as new as the server is installed, otherwise with Docker (`postgres:<version>-alpine`).
 * PDFs are copied incrementally: files already in the backup folder are skipped. Nothing is ever deleted
 * from the database or storage; only database backups older than the newest `--keep` are removed.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const BACKUP_PATTERN = /^paperweave-\d{4}-\d{2}-\d{2}-\d{4}\.dump$/;

/** libpq environment variables for a connection URL, so the password never appears on a command line. */
export function pgEnv(raw) {
  const u = new URL(raw);
  const env = {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** `paperweave-2026-10-10-1532.dump` for the given local time. */
export function backupName(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `paperweave-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.dump`;
}

/** Database backups to remove so that only the newest `keep` remain (only files this script names). */
export function backupsToPrune(names, keep) {
  return names
    .filter((n) => BACKUP_PATTERN.test(n))
    .sort()
    .reverse()
    .slice(Math.max(1, keep));
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Lets pg_dump in a Docker container reach a database on this computer: inside a container "localhost" is
 * the container itself, so it shares this computer's network (Linux) or uses Docker's name for it.
 */
export function dockerNetwork(env, platform = process.platform) {
  if (!LOCAL_HOSTS.has(env.PGHOST)) return { args: [], env };
  if (platform === "linux") return { args: ["--network", "host"], env };
  return { args: [], env: { ...env, PGHOST: "host.docker.internal" } };
}

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const step = (msg) => console.log(`\n› ${msg}`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The major version of a `pg_dump` on PATH, or 0 when there is none. */
function localPgDumpVersion() {
  const r = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? Number(/(\d+)\./.exec(r.stdout)?.[1] ?? 0) : 0;
}

const hasDocker = () => spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;

/** Runs a command with stdout written to `file`; rejects on a non-zero exit. */
function runToFile(cmd, args, env, file) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } });
    child.stdout.pipe(out);
    child.on("error", reject);
    child.on("close", (code) => {
      out.close();
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function backupDatabase(databaseUrl, dir, keep) {
  const { default: postgres } = await import("postgres");
  const url = new URL(databaseUrl);
  for (const p of ["channel_binding", "gssencmode", "target_session_attrs"]) url.searchParams.delete(p);
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  let major;
  try {
    const [{ v }] = await sql`select current_setting('server_version_num')::int / 10000 as v`;
    major = v;
  } finally {
    await sql.end();
  }

  let env = pgEnv(url.toString());
  const local = localPgDumpVersion();
  let cmd;
  let args;
  if (local >= major) {
    cmd = "pg_dump";
    args = ["--format=custom", "--no-owner", "--no-privileges"];
    console.log(`  Database: ${url.host} (Postgres ${major}), with pg_dump ${local}`);
  } else if (hasDocker()) {
    const network = dockerNetwork(env);
    env = network.env;
    cmd = "docker";
    args = [
      "run",
      "--rm",
      ...network.args,
      ...Object.keys(env).flatMap((k) => ["-e", k]), // values come from this process's environment
      `postgres:${major}-alpine`,
      "pg_dump",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
    ];
    console.log(`  Database: ${url.host} (Postgres ${major}), with Docker postgres:${major}-alpine`);
  } else {
    throw new Error(
      `pg_dump ${major} or newer is needed${local ? ` (found ${local})` : ""}. Install it ` +
        `(Mac: brew install postgresql@${major}; Ubuntu: the postgresql-client-${major} package) or start Docker.`,
    );
  }

  const name = backupName();
  const partial = path.join(dir, `${name}.partial`);
  try {
    await runToFile(cmd, args, env, partial);
    // A custom-format dump starts with "PGDMP".
    const head = readFileSync(partial).subarray(0, 5).toString("latin1");
    if (head !== "PGDMP" || statSync(partial).size < 1024) throw new Error("the dump file is not a valid backup");
    renameSync(partial, path.join(dir, name));
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  console.log(`  Saved ${name} (${mb(statSync(path.join(dir, name)).size)})`);

  for (const old of backupsToPrune(readdirSync(dir), keep)) {
    rmSync(path.join(dir, old));
    console.log(`  Removed old backup ${old}`);
  }
}

/** Copies a folder of stored PDFs (STORAGE_DRIVER=local) into the backup, skipping files already there. */
function backupLocalFiles(from, dir) {
  const root = path.join(dir, "files");
  if (!existsSync(from)) {
    console.log(`  No stored PDFs yet (${from} does not exist)`);
    return;
  }
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  for (const entry of readdirSync(from, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = path.join(entry.parentPath, entry.name);
    const target = path.join(root, path.relative(from, source));
    const { size } = statSync(source);
    if (existsSync(target) && statSync(target).size === size) {
      skipped++;
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, `${target}.partial`);
    renameSync(`${target}.partial`, target);
    copied++;
    bytes += size;
  }
  console.log(`  PDFs (${from}): ${copied} copied (${mb(bytes)}), ${skipped} already backed up`);
}

async function backupFiles(env, dir) {
  if ((env.STORAGE_DRIVER ?? "s3") === "local") {
    backupLocalFiles(path.resolve(env.STORAGE_LOCAL_DIR || "./data/files"), dir);
    return;
  }
  if (!env.S3_BUCKET) {
    console.log("  No storage settings in .env; skipped.");
    return;
  }
  const { GetObjectCommand, ListObjectsV2Command, S3Client } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || "auto",
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  const root = path.join(dir, "files");
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: env.S3_BUCKET, ContinuationToken: token }));
    for (const obj of page.Contents ?? []) {
      const target = path.join(root, ...obj.Key.split("/"));
      if (!target.startsWith(root + path.sep)) continue; // never write outside the backup folder
      if (existsSync(target) && statSync(target).size === obj.Size) {
        skipped++;
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: obj.Key }));
      await pipeline(res.Body, createWriteStream(`${target}.partial`));
      renameSync(`${target}.partial`, target);
      copied++;
      bytes += obj.Size ?? 0;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  console.log(`  PDFs: ${copied} copied (${mb(bytes)}), ${skipped} already backed up`);
}

async function main() {
  const fileEnv = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
  const env = { ...fileEnv, ...process.env };
  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (run this in the project folder, next to .env).");
    process.exit(1);
  }
  const dir = path.resolve(arg("--dir") ?? env.BACKUP_DIR ?? path.join(homedir(), "paperweave-backups"));
  const keep = Number(arg("--keep") ?? 12);
  mkdirSync(dir, { recursive: true });
  console.log(`Backing up to ${dir}`);

  step("Database");
  await backupDatabase(env.DATABASE_URL, dir, keep);
  if (!process.argv.includes("--no-files")) {
    step("Stored PDFs");
    await backupFiles(env, dir);
  }
  console.log("\nDone. To restore, see SETUP.md (Backups).");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`\nBackup failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
