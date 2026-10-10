#!/bin/sh
# Container entrypoint: apply migrations (unless disabled), then start the server.
set -e
if [ "${MIGRATE_ON_START:-true}" = "true" ]; then
  node scripts/migrate.mjs
fi
exec node server.js
