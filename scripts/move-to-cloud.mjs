/**
 * Copies this computer's Paperweave data to the cloud: the database (local Docker Postgres → e.g. Neon)
 * and the PDFs (local S3 / folder → e.g. Cloudflare R2), then compares both sides.
 *
 * Usage:  node scripts/move-to-cloud.mjs            — checks both sides and shows what it would copy
 *         node scripts/move-to-cloud.mjs --apply    — copies, then verifies
 *
 * Reads the source from .env and the target from .env.cloud (see .env.cloud.example). Nothing is
 * deleted on either side; the target database must be empty. The database copy uses pg_dump/pg_restore
 * inside the local "postgres" Docker container, so Docker Compose must be running.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const read = (file) => (existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : null);
const source = read(".env");
// --target <file> reads the cloud settings from another file (used to test the script).
const targetFile = process.argv.includes("--target")
  ? process.argv[process.argv.indexOf("--target") + 1]
  : ".env.cloud";
const target = read(targetFile);
if (!source || !target) {
  console.error("Both .env (this computer) and .env.cloud (the cloud) are needed; see .env.cloud.example.");
  process.exit(1);
}
for (const key of ["DATABASE_URL", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
  if (!target[key]) {
    console.error(`.env.cloud is missing ${key}.`);
    process.exit(1);
  }
}

const postgresUrl = (raw) => {
  const u = new URL(raw);
  for (const p of ["channel_binding", "gssencmode", "target_session_attrs"]) u.searchParams.delete(p);
  return u.toString();
};
const hostOf = (raw) => new URL(raw).host;
const step = (msg) => console.log(`\n› ${msg}`);

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function tableCounts(url) {
  const sql = postgres(postgresUrl(url), { max: 1, onnotice: () => {} });
  try {
    const tables = await sql`
      select table_schema as schema, table_name as name from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema in ('public', 'drizzle') order by 1, 2`;
    const counts = {};
    for (const t of tables) {
      const [{ n }] = await sql`select count(*)::int as n from ${sql(t.schema)}.${sql(t.name)}`;
      counts[`${t.schema}.${t.name}`] = n;
    }
    return counts;
  } finally {
    await sql.end();
  }
}

/** Runs a command and resolves when it exits successfully. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", opts.stdout ?? "inherit", "inherit"], env: opts.env });
    child.on("error", reject);
    child.on("exit", (code) =>
      code ? reject(new Error(`${args[0]} ${args[1] ?? ""} exited with ${code}`)) : resolve(),
    );
  });
}

/**
 * pg_dump in the local container into a temporary file, then pg_restore from that file in a throwaway
 * container on the host network (it reaches both this computer and the cloud). A file rather than a
 * pipe: a slow network on the restore side must not cut the dump short. The cloud address is passed
 * as an environment variable, not on the command line.
 */
async function copyDatabase(sourceUrl, targetUrl) {
  const src = new URL(sourceUrl);
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-move-"));
  const file = path.join(dir, "paperweave.dump");
  try {
    const out = openSync(file, "w");
    try {
      await run(
        "docker",
        [
          "compose",
          "exec",
          "-T",
          "-e",
          `PGPASSWORD=${decodeURIComponent(src.password)}`,
          "postgres",
          "pg_dump",
          "-Fc",
          "--no-owner",
          "--no-privileges",
          "--no-comments",
          "-U",
          decodeURIComponent(src.username),
          "-d",
          src.pathname.slice(1),
        ],
        { stdout: out },
      );
    } finally {
      closeSync(out);
    }
    console.log(`  dumped ${(statSync(file).size / 1024 / 1024).toFixed(1)} MB; restoring in the cloud…`);
    await run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "host",
        "-v",
        `${dir}:/dump:ro`,
        "-e",
        "TARGET_URL",
        "postgres:17-alpine",
        "sh",
        "-c",
        'pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -d "$TARGET_URL" /dump/paperweave.dump',
      ],
      { env: { ...process.env, TARGET_URL: targetUrl } },
    );
  } catch (err) {
    throw new Error(`the database copy failed (${err.message}); nothing was written to the cloud database`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function s3(env) {
  return new S3Client({
    region: env.S3_REGION || "auto",
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true") !== "false",
    credentials:
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
        : undefined,
  });
}

async function listObjects(client, bucket) {
  const out = new Map();
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of page.Contents ?? []) out.set(o.Key, o.Size ?? 0);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** The source files: the local S3 bucket, or the local storage folder. */
async function sourceFiles() {
  if ((source.STORAGE_DRIVER ?? "s3") === "local") {
    const root = path.resolve(source.STORAGE_LOCAL_DIR || "./data/files");
    const out = new Map();
    const walk = (dir) => {
      for (const name of existsSync(dir) ? readdirSync(dir) : []) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else out.set(path.relative(root, full).split(path.sep).join("/"), statSync(full).size);
      }
    };
    walk(root);
    return { files: out, get: async (key) => readFileSync(path.join(root, key)) };
  }
  const client = s3(source);
  const bucket = source.S3_BUCKET || "paperweave";
  return {
    files: await listObjects(client, bucket),
    get: async (key) =>
      Buffer.from(
        await (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body.transformToByteArray(),
      ),
  };
}

const totalSize = (m) => [...m.values()].reduce((a, b) => a + b, 0);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------------------

step(`Database: ${hostOf(source.DATABASE_URL)} → ${hostOf(target.DATABASE_URL)}`);
const before = await tableCounts(source.DATABASE_URL);
let targetCounts;
try {
  targetCounts = await tableCounts(target.DATABASE_URL);
} catch (err) {
  console.error(`Cannot connect to the cloud database: ${err.message}`);
  process.exit(1);
}
const targetRows = Object.values(targetCounts).reduce((a, b) => a + b, 0);
console.log(
  `  this computer: ${Object.keys(before).length} tables, ${Object.values(before).reduce((a, b) => a + b, 0)} rows`,
);
console.log(`  cloud: ${Object.keys(targetCounts).length} tables, ${targetRows} rows`);
if (Object.keys(targetCounts).length) {
  console.error("  The cloud database is not empty. Use a fresh (empty) database; nothing was copied.");
  process.exit(1);
}

step(
  `Files: ${source.STORAGE_DRIVER === "local" ? "local folder" : `${source.S3_ENDPOINT}/${source.S3_BUCKET}`} → ${target.S3_ENDPOINT}/${target.S3_BUCKET}`,
);
const src = await sourceFiles();
const dest = s3(target);
try {
  await dest.send(new HeadBucketCommand({ Bucket: target.S3_BUCKET }));
} catch (err) {
  if (err?.$metadata?.httpStatusCode === 404 && APPLY)
    await dest.send(new CreateBucketCommand({ Bucket: target.S3_BUCKET }));
  else if (err?.$metadata?.httpStatusCode !== 404) {
    console.error(`  Cannot reach the cloud bucket: ${err.name} ${err.message ?? ""}`);
    process.exit(1);
  }
}
const existing = await listObjects(dest, target.S3_BUCKET).catch(() => new Map());
const toCopy = [...src.files].filter(([key, size]) => existing.get(key) !== size);
console.log(`  this computer: ${src.files.size} files, ${mb(totalSize(src.files))}`);
console.log(`  cloud: ${existing.size} files already there; ${toCopy.length} to copy`);

if (!APPLY) {
  console.log("\nDry run — nothing was copied. Run again with --apply to copy.");
  process.exit(0);
}

step("Copying the database (one transaction; nothing is written if it fails)…");
try {
  await copyDatabase(source.DATABASE_URL, target.DATABASE_URL);
} catch (err) {
  console.error(`  ${err.message}`);
  process.exit(1);
}

step(`Copying ${toCopy.length} files…`);
let done = 0;
for (const [key] of toCopy) {
  await dest.send(new PutObjectCommand({ Bucket: target.S3_BUCKET, Key: key, Body: await src.get(key) }));
  if (++done % 10 === 0 || done === toCopy.length) process.stdout.write(`\r  ${done}/${toCopy.length}`);
}
if (toCopy.length) process.stdout.write("\n");

step("Verifying…");
const after = await tableCounts(target.DATABASE_URL);
const mismatched = Object.keys(before).filter((t) => before[t] !== after[t]);
const finalFiles = await listObjects(dest, target.S3_BUCKET);
const missing = [...src.files].filter(([key, size]) => finalFiles.get(key) !== size);
for (const [key] of missing.slice(0, 5)) {
  const head = await dest.send(new HeadObjectCommand({ Bucket: target.S3_BUCKET, Key: key })).catch(() => null);
  console.log(`  missing or different: ${key}${head ? ` (${head.ContentLength} bytes)` : ""}`);
}
console.log(
  `  tables: ${Object.keys(before).length - mismatched.length}/${Object.keys(before).length} with identical row counts`,
);
for (const t of mismatched) console.log(`    ${t}: ${before[t]} here, ${after[t] ?? "missing"} in the cloud`);
console.log(`  files: ${src.files.size - missing.length}/${src.files.size} present with the same size`);
if (mismatched.length || missing.length) {
  console.error("\nSomething differs — keep using this computer's data and look at the lines above.");
  process.exit(1);
}
console.log(
  "\nDone. To switch this computer to the cloud data, copy the values from .env.cloud into .env " +
    "(DATABASE_URL and the S3_* lines, STORAGE_DRIVER=s3), then restart Paperweave. The local data stays as a backup.",
);
