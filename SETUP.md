# Setting up Paperweave

Start with the [quick start](README.md#quick-start), then pick a setup:

- [One computer + Tailscale](#one-computer--tailscale) — everything on one computer, opened from your other
  devices over a private network. Fast, nothing in the cloud; the computer must be on.
- [Several computers, cloud data](#several-computers-cloud-data) — every computer runs Paperweave against a
  shared cloud database and PDF storage.
- [Server deployment](#server-deployment) — a shared instance for several users.

Also: [phone and tablet](#phone-and-tablet-tailscale) · [backups](#backups) · [updating](#updating)

---

## One computer + Tailscale

The database runs in Docker and PDFs are kept in a folder. Phones, tablets and other computers open
Paperweave through [Tailscale](https://tailscale.com).

1. Start the database (it restarts with Docker from then on):

   ```bash
   docker compose up -d postgres
   ```

2. In `.env`:

   ```bash
   DATABASE_URL=postgres://paperweave:paperweave@localhost:5433/paperweave
   STORAGE_DRIVER=local
   STORAGE_LOCAL_DIR=/home/<you>/paperweave-data/files   # outside the project folder, so git never touches it
   ```

3. `npm run db:migrate && npm run build && npm start`, open http://localhost:3300 and create your account.
   Then set `ALLOW_REGISTRATION=false`.
4. Make it reachable from your devices: [phone and tablet](#phone-and-tablet-tailscale).

`npm start` only accepts connections from the computer itself (`HOST=0.0.0.0` changes that); Tailscale passes
requests from your devices on to it, so others on the same Wi-Fi cannot reach Paperweave.

Never run `docker compose down -v`: `-v` deletes the database volume, i.e. your library. `docker compose down`
without `-v` is safe.

### Single-user mode

With `SINGLE_USER_EMAIL=<your account's email>` in `.env`, there is no sign-in page: requests addressed to
this computer (`localhost`), `APP_URL` or a `TRUSTED_ORIGINS` address act as that account. Requests under any
other host name (a website pointing its own domain at your computer) are not signed in. Sign-out and the
password settings are hidden; remove the line and restart to bring sign-in back. Set or reset the password
from the terminal with `npm run set-password`.

Only use it when nobody else can reach the computer: anyone on your tailnet can open your library.

### Starting automatically (Linux / WSL)

```bash
bash scripts/autostart.sh install
sudo loginctl enable-linger $USER      # once: lets the service run without an open terminal
systemctl --user start paperweave      # stop an `npm start` you run yourself first
```

This installs a user service that waits for the database and runs `npm start` (restarting it if it crashes).
On WSL it also adds a Windows startup file that starts WSL hidden at sign-in and keeps it running. Logs:
`journalctl --user -u paperweave -f`. After updating: `npm run build && systemctl --user restart paperweave`.
Remove it with `bash scripts/autostart.sh uninstall`. The service records the Node path at install time, so
install again after switching Node versions.

To use Paperweave from other devices while away, set the computer not to sleep.

### Other computers

Open the Tailscale address in a browser — no copy of Paperweave is needed. A device can be on only one tailnet
at a time; one that is also on another tailnet (e.g. at work) switches with `tailscale switch <account>`.

---

## Several computers, cloud data

Every computer runs its own copy of Paperweave against the same cloud database ([Neon](https://neon.tech)) and
PDF storage ([Cloudflare R2](https://developers.cloudflare.com/r2/)). Refresh the page to see changes from
another computer; editing the same note on two at once gives a "changed elsewhere" warning.

### 1. Create the cloud storage

**Neon (database):** create a project (Postgres 17 or newer, the region closest to you). Open **Connect**,
turn **Connection pooling off** and copy the connection string. The free plan is enough: everything except
PDFs is small.

**Cloudflare R2 (PDFs):** create a bucket (e.g. `paperweave`), then **Manage API tokens → Create API token**
with **Object Read & Write** on that bucket. Copy the Access Key ID, Secret Access Key and S3 endpoint
(`https://<account-id>.r2.cloudflarestorage.com`). The free plan includes 10 GB.

### 2. Move your data to the cloud

On the computer that has your library (database in Docker):

1. Copy `.env.cloud.example` to `.env.cloud` and fill in the values from step 1.
2. `npm run cloud:move` checks both sides and shows what would be copied (the cloud database must be empty).
3. `npm run cloud:move -- --apply` copies the database and PDFs, then compares every table and file.
4. In `.env`, replace `DATABASE_URL`, `STORAGE_DRIVER` and the `S3_*` lines with those from `.env.cloud`, and
   restart Paperweave.

### 3. Set up another computer

Requirements: Git and Node.js 24 (Docker is not needed). On a Mac: `xcode-select --install` for Git, and
Node.js from [nodejs.org](https://nodejs.org) or `brew install node@24`.

```bash
git clone https://github.com/Hugin373/paperweave.git && cd paperweave
# copy .env from your first computer here (USB drive or password manager — never by email or chat)
chmod 600 .env
npm install
npm run build && npm start      # http://localhost:3300
```

`.env` must be the same on every computer: besides the cloud settings it holds `APP_ENCRYPTION_KEY` (another
value could not read saved AI keys) and `BETTER_AUTH_SECRET`. For AI through your subscriptions, install and
sign in to `claude` / `codex` on each computer and set `AI_ENABLE_SUBSCRIPTION_CLI=true`.

Before using a computer, update it: `git pull && npm install && npm run build && npm start`. A copy older than
the database refuses to start, since older code could misread newer data.

---

## Phone and tablet (Tailscale)

Phones and tablets can't run Paperweave, but they can open it on a computer that runs it, over Tailscale (a
private network between your own devices; nothing is exposed to the internet).

1. Create a free account at [tailscale.com](https://tailscale.com). Install Tailscale on the computer (on
   Windows the Windows app, not inside WSL) and on the phone, signed in to the same account.
2. Run Paperweave in production mode (`npm run build && npm start`; development mode refuses other addresses)
   and check http://localhost:3300 on the computer.
3. Give it a private HTTPS address (PowerShell on Windows, Terminal elsewhere):

   ```
   tailscale serve --bg 3300
   ```

   The first time, it may print a link to enable HTTPS certificates: open it, enable, and run the command
   again. It prints an address like `https://my-pc.tailnet-name.ts.net`.

4. Add that address to `.env` exactly as printed and restart Paperweave:

   ```
   TRUSTED_ORIGINS=https://my-pc.tailnet-name.ts.net
   ```

5. Open the address on the phone; add it to the home screen to open it like an app.

Stop sharing with `tailscale serve reset`. Never use `tailscale funnel` — that puts Paperweave on the public
internet.

**Windows / WSL:** if the phone can't connect, run `curl.exe -I http://127.0.0.1:3300` in PowerShell. If that
fails, Windows cannot reach WSL: create `%UserProfile%\.wslconfig` with

```ini
[wsl2]
networkingMode=mirrored
```

then `wsl --shutdown` and start WSL and Paperweave again. **"Invalid origin" on sign-in:** `TRUSTED_ORIGINS`
does not match the address exactly, or Paperweave was not restarted.

---

## Local model

Paperweave can use a model running on your own computer: an open-weight model or your own fine-tune. Start it
with any server that speaks the OpenAI chat API, then choose **Local model** in **Settings → AI**: Paperweave
finds the server on its own (it looks on the ports local model servers usually use) and uses whatever model
it runs. If the server lists several models, pick one there. For example, with
[uv](https://docs.astral.sh/uv/) and Hugging Face transformers (any model id from huggingface.co, or a folder
with your own weights):

```bash
uvx --from "transformers[serving]" --with requests transformers serve Qwen/Qwen3-8B --port 8000
```

Under **Advanced**:

- **Address** — only if the server runs on another computer or on an unusual port.
- **Context: Full** sends the model exactly what Claude and GPT get: whole papers, every assistant tool and
  playbook. **Low** is for models with a short context window: less text per request, only the core assistant
  tools, no playbooks, and smaller budgets for Deep research and Field analysis. When the server reports the
  model's context window, Paperweave suggests one.
- **The model can read images** lets the assistant look at pages of PDFs (figures, tables, equations). Leave
  it off for text-only models.

Answers are only as good as the model: smaller models may struggle with the assistant's longer tasks.

## Server deployment

Paperweave is one Node.js service plus PostgreSQL 15+ and S3-compatible storage (AWS S3, R2, Backblaze B2,
SeaweedFS, MinIO… — the bucket stays private). Terminate HTTPS in front of it and set `APP_URL` to the
`https://` address; secure cookies and the cross-site check depend on it.

**Docker Compose on a server** — a self-contained stack (app, PostgreSQL, SeaweedFS):

```bash
cp .env.example .env.production       # set APP_URL, both secrets, S3 keys, AI_ALLOW_PRIVATE_ENDPOINTS=false
cp docker/seaweedfs/s3.json docker/seaweedfs/s3.production.json   # same access / secret keys
export POSTGRES_PASSWORD=$(openssl rand -hex 24)
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Then a reverse proxy, e.g. Caddy: `research.example.com { reverse_proxy localhost:3300 }`.

**Container image with managed services:** `docker build -t paperweave .` and run it with `APP_URL`,
`DATABASE_URL`, the secrets and `S3_*` as environment variables (port 3300). For AWS S3 leave `S3_ENDPOINT`
empty and set `S3_FORCE_PATH_STYLE=false`.

**Plain Node.js:** `npm ci && npm run build && npm run db:migrate && HOST=0.0.0.0 npm start`.

Notes:

- Migrations run on start (`AUTO_MIGRATE` / the image's `MIGRATE_ON_START`). With several replicas, run them
  once per release instead: `node scripts/migrate.mjs`.
- Background jobs (PDF text, references, imports, saved searches) run inside the web process; keep at least
  one instance running on scale-to-zero platforms.
- `GET /api/health` returns 200 when the database is reachable.
- Rate limits and source circuit breakers are per instance.
- The subscription AI providers are off by default in production and unavailable in the image: they would
  share your plan with every user.

Checklist: HTTPS and an `https://` `APP_URL` · strong secrets from a secret manager ·
`AI_ALLOW_PRIVATE_ENDPOINTS=false` · `AI_ENABLE_MOCK_PROVIDER` unset · private bucket ·
`ALLOW_REGISTRATION=false` if private · tested backups.

---

## Backups

```bash
npm run backup                          # into ~/paperweave-backups
npm run backup -- --dir <folder>        # e.g. an external or cloud-synced drive
```

It saves the whole database as `paperweave-<date>-<time>.dump` and copies stored PDFs (from the bucket or
`STORAGE_LOCAL_DIR`) to `<folder>/files/`, only new ones each time. The newest 12 database backups are kept
(`--keep 20` for more). Live PDFs are not stored, so there is nothing to back up for them. It needs `pg_dump`
at least as new as the database server; Docker is used automatically when available. **Settings → Export**
gives a readable copy (JSON, Markdown, BibTeX) on top. Keep `APP_ENCRYPTION_KEY` safe too: without it, saved
AI API keys cannot be decrypted.

**Restore** into an empty database:

```bash
# local Docker database
docker compose exec -T postgres pg_restore -U paperweave -d paperweave --no-owner --no-privileges \
  < ~/paperweave-backups/paperweave-<date>-<time>.dump
# any other database (PGPASSWORD set in your shell)
docker run --rm -e PGPASSWORD -v ~/paperweave-backups:/b postgres:18-alpine \
  pg_restore --no-owner --no-privileges -h <host> -U <user> -d <database> /b/paperweave-<date>-<time>.dump
```

Then copy `files/` back into `STORAGE_LOCAL_DIR` (or upload it to the bucket with the same folder structure).

## Updating

```bash
git pull && npm install && npm run build
```

Then restart Paperweave (`systemctl --user restart paperweave` with autostart). Database changes are applied
automatically on start.
