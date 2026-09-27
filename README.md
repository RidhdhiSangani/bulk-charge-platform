# Bulk Charge Application Platform

[![CI](https://github.com/<your-github-user>/bulk-charge-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/<your-github-user>/bulk-charge-platform/actions/workflows/ci.yml)

A bulk action engine for a freight-forwarding system. A job selects shipments **by filter**, and the engine applies an action to every match **independently, durably and exactly once**. The engine is entity-agnostic, and actions are plug-ins. Two actions ship with it:

| Action | What it does |
|---|---|
| `apply_charge` | Prices a charge template (`per_container`, `per_kg` or `flat`), converts it to the shipment's billing currency, and appends a charge line |
| `transition_status` | Moves shipments along `booked → in_transit → arrived → delivered` |

**Stack:** NestJS (TypeScript), **PostgreSQL 16** (source of truth; exactly-once is enforced here), and **Redis 7 + BullMQ** (queues, delays, retries, the per-tenant rate limit). One Docker image runs in two roles: `api` and `worker`.

| | |
|---|---|
| 🌐 **Live demo** | `https://<your-service>.onrender.com`: [`/docs`](https://<your-service>.onrender.com/docs) (Swagger) · [`/health`](https://<your-service>.onrender.com/health). Free tier: the first request after ~15 min idle takes ~50 s to wake. |
| 📮 **Postman** | [postman/Bulk-Jobs.postman_collection.json](postman/Bulk-Jobs.postman_collection.json): 34 requests, plus Local and Live environments |
| 🎥 **Loom** | `<link>` |

## Documentation

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Processes, job lifecycle, plugin model, orchestrator and batch algorithm, why exactly-once holds, schema |
| [docs/API.md](docs/API.md) | Every endpoint with request and response examples, status codes, and reason codes |
| [docs/DATABASE.md](docs/DATABASE.md) | Connecting, each table explained, what "applying a charge" writes, useful queries |
| [docs/TESTING.md](docs/TESTING.md) | Unit and integration tests, chaos (crash) test, load test, Postman, demo reset scripts, manual scenarios |
| [docs/DESIGN-FAQ.md](docs/DESIGN-FAQ.md) | Design Q&A: idempotency keys, cancel vs rollback, fencing tokens, rate limiting, why Postgres + BullMQ |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | GitHub, Render (one-click Blueprint), Railway alternative, troubleshooting |
| [docs/SCALE.md](docs/SCALE.md) | What changes at 1M+ shipments, and what was deliberately not built |

---

## Run it locally

Prerequisite: Docker with Compose v2.

```bash
docker compose up -d --build     # postgres, redis, migrate (+seed), api, worker
curl localhost:3000/health       # {"status":"ok","db":"ok","redis":"ok",...}
open http://localhost:3000/docs  # Swagger UI
```

`migrate` is a one-shot container. It applies the migrations and seeds 2 tenants, 6 FX rates and 5,000 shipments from [data/shipments.seed.csv](data/shipments.seed.csv), then exits.

Host ports: API on **3000**, Postgres on **5433**, Redis on **6380**. The non-default ports avoid clashing with a local Postgres or Redis.

```bash
# Apply a per-kg fuel surcharge to every INNSA shipment that is in transit
curl -s -X POST localhost:3000/v1/bulk-jobs \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"tenant_id":"tnt_demo","action_type":"apply_charge","entity_type":"shipment",
       "filter":{"origin_port":"INNSA","status":"in_transit"},
       "params":{"charge_code":"FSC","basis":"per_kg","rate":0.12,"currency":"USD"}}'

curl -N  localhost:3000/v1/bulk-jobs/<id>/events                    # live progress stream (SSE)
curl -s  localhost:3000/v1/bulk-jobs/<id>/summary                   # counts + failure reasons
curl -s 'localhost:3000/v1/bulk-jobs/<id>/entries?outcome=failed'   # per-shipment log
```

| Task | Command |
|---|---|
| Scale workers | `docker compose up -d --scale worker=3` |
| Crash test (kill -9 mid-job, verify exactly-once) | `npm run chaos` |
| Reset the Postman demos (FSC charge + SGSIN transitions) | `npm run reset:demo` |
| Reset all data | `docker compose run --rm migrate node dist/seed/seed.js --reset` |
| Stop / stop and wipe | `docker compose down` / `docker compose down -v` |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/bulk-jobs` | Create a job (filter + action + params, optional `scheduled_at`). Honours `Idempotency-Key`. |
| `GET` | `/v1/bulk-jobs` | List jobs, filterable by `status` and `tenant_id` |
| `GET` | `/v1/bulk-jobs/{id}` | Detail with live progress (processed/total, %, throughput, ETA), batches and tenant rate |
| `GET` | `/v1/bulk-jobs/{id}/events` | **Real-time progress stream** (Server-Sent Events) until the job ends |
| `GET` | `/v1/bulk-jobs/{id}/summary` | Success / failed / skipped counts, plus reasons |
| `GET` | `/v1/bulk-jobs/{id}/entries?outcome=failed` | Paginated per-entity log, filterable by outcome |
| `POST` | `/v1/bulk-jobs/{id}/cancel` | Cancel a scheduled, queued or running job |
| `GET` | `/v1/shipments/{shipmentNo}` | Demo helper: a shipment with its charge lines |
| `GET` | `/health`, `/docs` | Health; Swagger UI |

Full examples are in [docs/API.md](docs/API.md).

## Measured results

Measured on a MacBook laptop in Docker, with every container on one machine. Details and how to reproduce are in [docs/TESTING.md](docs/TESTING.md).

| Scenario | Result |
|---|---|
| Throughput, 1 worker, 50,000 shipments | 27.2 s → **≈110,000 entities/min** |
| Throughput, 3 workers, 50,000 shipments | 15.4 s → **≈195,000 entities/min**, 50,000 entries for 50,000 distinct entities, no batch retried |
| Tenant limit 1,500/min | Never more than 1,500 in any 60 s window; the excess was delayed, not dropped or failed |
| `kill -9` the worker mid-batch (`npm run chaos`) | 4,511/4,511 processed · success entries = counter = charges = 4,080 · **0 double charges** · 4 interrupted batches re-claimed |
| Tests | 16 unit + 17 integration (real Postgres + Redis), run in CI on every push |

## Key design decisions

1. **Postgres enforces exactly-once; the queue doesn't.** BullMQ delivers at least once. A duplicate delivery is made a no-op by four things:
   - an atomic lease claim;
   - a **fencing token** checked at commit;
   - `UNIQUE(job_id, entity_id)` on the per-entity log;
   - `UNIQUE(shipment_id, charge_code)` on charges.
2. **One transaction per batch, with a savepoint per entity.** A failing entity never rolls back its batch. A crash loses at most one uncommitted batch, which is re-run.
3. **Keyset pagination, not OFFSET.** The orchestrator streams ids 100 at a time (`id > cursor`), so memory stays flat at any job size, and the cursor is saved so a crash resumes where it stopped.
4. **One queue job per batch, not per shipment.** A million shipments means 10,000 Redis jobs, not a million.
5. **The rate limit is a strict sliding window per tenant, counted in entities** (a Lua script in Redis). A batch over the limit is re-delayed for exactly as long as the window needs.
6. **Counters are updated once per batch**, in the same transaction as the log, so they can't drift and the job row's lock stays short.
7. **Money uses decimals, never floats.** Unpriceable shipments are per-entity failures with reason codes.
8. **Cancellation is cooperative.** Pending batches close immediately, in-flight batches stop at their next check, and processed work is kept. Reverting processed work would be a compensating job; see [docs/DESIGN-FAQ.md](docs/DESIGN-FAQ.md).
9. **Filter keys are allowlisted.** A typo returns 400 instead of silently matching every shipment.

More detail, and what was deliberately not built, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SCALE.md](docs/SCALE.md).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection (`rediss://` and `/db` supported) |
| `BATCH_SIZE` | 100 | Entities per batch |
| `TENANT_RATE_LIMIT_PER_MIN` | 5000 | Per-tenant ceiling across all of that tenant's jobs |
| `WORKER_CONCURRENCY` | 4 | Batches in parallel per worker process |
| `LEASE_TTL_SECONDS` | 60 | After this, a leased batch's worker is presumed dead |
| `WATCHDOG_EVERY_MS` | 15000 | Reconciliation sweep interval |
| `CANCEL_CHECK_EVERY` | 10 | In-flight batches re-check for cancel every N entities |
| `SSE_INTERVAL_MS` | 1000 | Default push interval of the progress stream |
| `QUEUE_PREFIX` | `bull` | BullMQ key prefix, so environments can share one Redis |
| `RUN_WORKERS_IN_API` | `false` | Combined mode: the API process also runs the workers (single-service hosting) |
| `MIGRATE_ON_START` | `false` | The container runs migrations + seed before starting (hosts without a release step) |
| `BULK_DEBUG_ENTITY_DELAY_MS` | 0 | **Demo only.** Slows each entity so a crash or cancel can land mid-batch |

## Project layout

```
src/
  main.ts / worker.ts            two entrypoints, one image
  app.module.ts / worker.module.ts / core.module.ts
  bulk-engine/                   the entity-agnostic engine (no shipment imports)
  actions/                       the Shipment plugin: adapter + apply_charge + transition_status
  bulk-jobs/                     HTTP controller, DTOs, service (incl. SSE)
  fx/ prisma/ redis/ health/ shipments/ seed/
prisma/                          schema + SQL migrations
data/shipments.seed.csv          5,000 deterministic sample shipments
scripts/                         chaos test, demo reset SQL, CSV generator, container start script
test/                            integration tests
loadtest/                        Node runner, k6 script, 50k-row SQL
postman/                         collection + Local/Live environments
docs/                            architecture, API, database, testing, design FAQ, deployment, scale
.github/workflows/ci.yml         typecheck, build, unit + integration tests, Docker build
render.yaml                      one-click Render Blueprint (free plan, combined mode)
```

## Loom outline (~5 min)
1. **Architecture (2 min):**
   - the API and worker split, with Postgres as the source of truth and BullMQ for orchestration;
   - the keyset scan into batches;
   - how a batch runs: lease, transaction, savepoints, fenced commit;
   - the plugin model, with `transition_status` as the proof.
2. **Demo (3 min):**
   - create a job and replay its key;
   - watch the live `/events` stream;
   - show the summary reasons and the failed entries;
   - re-run the charge and show it's all skipped;
   - an illegal transition;
   - schedule and cancel;
   - `npm run chaos` for the crash test.
