#!/bin/sh
# Container entrypoint for single-service hosting (e.g. Render free plan).
#   MIGRATE_ON_START=true  → apply migrations + idempotent seed before starting
#   RUN_WORKERS_IN_API=true → the API process also runs the queue workers (combined mode)
# docker-compose does not use this: it runs `migrate`, `api` and `worker` as separate services.
set -e
if [ "$MIGRATE_ON_START" = "true" ]; then
  echo "[start] applying migrations"
  ./node_modules/.bin/prisma migrate deploy
  echo "[start] seeding (idempotent)"
  node dist/seed/seed.js
fi
exec node dist/main.js
