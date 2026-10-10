/**
 * Sets an account's sign-in password from the terminal (e.g. a forgotten one, or one that came with a demo
 * account). The password is typed without being shown and never appears on a command line.
 *
 * Usage:  npm run set-password                      — for SINGLE_USER_EMAIL, or the only account
 *         npm run set-password -- --email <email>   — for another account
 *
 * Reads DATABASE_URL from .env. Signs the account out on every device (single-user mode is unaffected).
 */
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseEnv } from "node:util";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

const fileEnv = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
const env = { ...fileEnv, ...process.env };
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

/** Reads a line from the terminal without echoing it. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(prompt)) process.stdout.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  if (!process.stdin.isTTY) throw new Error("run this in a terminal (it asks for the password)");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set (run this in the project folder, next to .env)");
  const url = new URL(env.DATABASE_URL);
  for (const p of ["channel_binding", "gssencmode", "target_session_attrs"]) url.searchParams.delete(p);
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    const email = (arg("--email") ?? env.SINGLE_USER_EMAIL)?.toLowerCase();
    const users = email
      ? await sql`select id, name, email from "user" where email = ${email}`
      : await sql`select id, name, email from "user"`;
    if (users.length !== 1) {
      throw new Error(email ? `there is no account with the email ${email}` : "several accounts: pass --email <email>");
    }
    const [user] = users;
    console.log(`Setting the password for ${user.name} <${user.email}>`);
    const password = await askHidden("New password (at least 8 characters): ");
    if (password.length < 8 || password.length > 128) throw new Error("the password must be 8–128 characters");
    if ((await askHidden("Type it again: ")) !== password) throw new Error("the two passwords differ");

    const hash = await hashPassword(password);
    const updated = await sql`
      update account set password = ${hash}, updated_at = now()
      where user_id = ${user.id} and provider_id = 'credential' returning id`;
    if (!updated.length) {
      await sql`
        insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
        values (${crypto.randomUUID()}, ${user.id}, 'credential', ${user.id}, ${hash}, now(), now())`;
    }
    await sql`delete from session where user_id = ${user.id}`;
    console.log("Password set. Sign in with it whenever sign-in is on (it is skipped in single-user mode).");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(`\nThe password was not changed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
