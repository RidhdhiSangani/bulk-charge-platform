# Scaling to millions, and what was deliberately not built

This build was tested with 5,000 seeded shipments and a 50,000-shipment load tenant. This page covers what already holds at a million shipments per job, what I would change first, and what's out of scope.

## What already holds at 1M

- **Memory is bounded.** The orchestrator only ever holds one page of ids (100). Workers hold one batch per concurrency slot.
- **The scan cost is flat.** Keyset pages on an indexed `(tenant_id, <filter col>, id)` cost the same on page 1 and page 10,000. OFFSET would get quadratically slower.
- **Redis stays small.** A 1M-shipment job is 10,000 BullMQ jobs and 10,000 `job_batches` rows, not a million of either.
- **Horizontal scaling works.** Any number of worker replicas claim batches atomically. The job row is locked only briefly per batch, so batches of one job run in parallel. Measured: 1 → 3 workers gave 110k → 195k entities/min on one laptop.
- **Resume is cheap.** The orchestrator resumes from `cursor_after_id`. A batch resumes by skipping ids that are already logged. No crash ever restarts a job from the beginning.
- **Throughput is limited by the tenant, not the system.** At 5,000/min, a 1M job for one tenant takes about 200 minutes by design. Other tenants aren't affected.

## What I'd change first at real production scale

| Area | Now | At scale |
|---|---|---|
| Log writes | One `createMany` per batch through Prisma | `INSERT … SELECT unnest(...)` or `COPY`, and `UNLOGGED` staging if needed |
| `job_entries` growth | One table | **Partition by `job_id`** (or by created month) and drop old partitions for retention; about 1M rows per large job |
| Postgres | A single primary | PgBouncer in transaction mode (each batch holds a connection for about 1 s); read replicas for the list/summary/entries reads; Postgres becomes the ceiling before the workers do |
| `COUNT(*)` on huge sets | Exact, on the index | Keep it exact (the spec needs a meaningful total), or show an estimate from the planner first and backfill; the scan already reconciles the total |
| Hot shipment rows | `FOR UPDATE` per batch | Fine; contention only happens when two jobs touch the same shipments, and ordered locking prevents deadlocks |
| Batch size | Static at 100 | Adaptive, sized per action cost (targeting about 1 s per batch), plus admission control across tenants |
| Tenant fairness | Rate cap per tenant | Also cap concurrent batches per tenant, so one tenant's backlog can't fill the queue ahead of others (BullMQ groups, or a per-tenant queue) |
| Redis | A single node with AOF | A managed HA Redis; losing it loses only in-flight scheduling, which the watchdog rebuilds from Postgres |
| Observability | API only (detail, summary, entries, tenant rate) | Prometheus `/metrics` (entities/s by outcome, queue depth, lease expiries, rate-limit delays), OpenTelemetry traces per batch, structured JSON logs |
| Filters | Exact match on 5 allowlisted keys | Operators (`in`, `gte`, date ranges) behind the same allowlist, compiled only inside the adapter |

## Real-time progress at scale
Today each open `/events` stream re-reads the job row once a second, which is fine for tens of viewers. At scale, workers would publish a progress message to Redis pub/sub after each batch commit, and the API would fan it out to connected streams. There'd be no per-viewer database reads.

## Deployment path

**Live demo (implemented):** Render free plan, one web service in combined mode (`RUN_WORKERS_IN_API=true`), plus free Postgres and Key Value, via [render.yaml](../render.yaml). See [DEPLOYMENT.md](DEPLOYMENT.md).

**Production shape:** two services from the same image on Railway, Render or ECS:
- `api` runs `node dist/main.js`, with health check `/health`;
- `worker` runs `node dist/worker.js`, with N replicas;

plus managed Postgres and Redis. Configure with `DATABASE_URL` and `REDIS_URL` (`rediss://` supported). Run migrations as a release step: `npx prisma migrate deploy && node dist/seed/seed.js`. No Kafka.

## Deliberately not built

| Not built | Why | How I'd do it |
|---|---|---|
| **Kafka / exactly-once semantics** | Exactly-once is already enforced in Postgres (leases, fencing, unique keys). This workload is "do each task once", not "replay an event log". | — |
| **Auth / RBAC / tenant isolation beyond `tenant_id`** | Out of scope | JWT carrying the tenant claim; API guards; Postgres row-level security keyed on `tenant_id` |
| **Live FX** | Out of scope | Rates snapshotted per job at creation (for reproducibility), refreshed from a provider into `fx_rates` |
| **Billing ledger** | Out of scope | Charges feed an append-only ledger; `is_billed` set by invoicing |
| **UI** | The spec asks for API only | — |
| **True 1M-row soak test** | 50k tested; the design is page-bounded | Same load script on a 1M-row tenant against managed Postgres |
| **Charge template catalogue** | Params JSON is enough for the spec | A `charge_templates` table, with jobs referencing a template id and version |
