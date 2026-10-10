#!/usr/bin/env bash
# Runs the browser end-to-end suite:
#   1. resets the e2e database and applies migrations
#   2. builds and starts the production server on :3100 with test settings
#   3. runs Playwright inside the official Playwright Docker image (no local browser deps needed)
# Requires: docker compose services running (docker compose up -d), network access to scholarly APIs.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${E2E_PORT:-3100}
PW_VERSION=$(node -p "require('@playwright/test/package.json').version")
export DATABASE_URL=${E2E_DATABASE_URL:-postgres://paperweave:paperweave@localhost:5433/paperweave_e2e}

echo "› Resetting e2e database"
node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
sql.unsafe('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;').then(() => sql.end());
"
node scripts/migrate.mjs

if [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then
  echo "› Building"
  npm run build >/dev/null
fi

if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  echo "Port $PORT is already in use; stop the other server first." >&2
  exit 1
fi

echo "› Starting server on :$PORT"
# Always local: test data must never reach the database or file storage your .env points at
# (e.g. the cloud). DATABASE_URL is set above; PDFs go to a temporary folder.
E2E_FILES=$(mktemp -d)
APP_URL="http://localhost:$PORT" \
AI_ENABLE_MOCK_PROVIDER=true \
EMBEDDINGS=false \
ALLOW_REGISTRATION=true \
SINGLE_USER_EMAIL= \
STORAGE_DRIVER=local \
STORAGE_LOCAL_DIR="$E2E_FILES" \
RUN_WORKER_IN_PROCESS=true \
AUTH_RATE_LIMIT=false \
NODE_ENV=production \
setsid node node_modules/next/dist/bin/next start -p "$PORT" > test-results-server.log 2>&1 &
SERVER_PID=$!
trap 'kill -- -$SERVER_PID 2>/dev/null || true; rm -rf "$E2E_FILES"' EXIT

for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/api/health" >/dev/null && break
  sleep 1
done
curl -sf "http://localhost:$PORT/api/health" >/dev/null || { echo "Server did not start"; cat test-results-server.log; exit 1; }

echo "› Running Playwright $PW_VERSION"
docker run --rm --network host --ipc=host \
  -v "$PWD":/work -w /work \
  -e PLAYWRIGHT_BASE_URL="http://localhost:$PORT" -e CI="${CI:-}" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  "mcr.microsoft.com/playwright:v$PW_VERSION-noble" \
  npx playwright test "$@"
