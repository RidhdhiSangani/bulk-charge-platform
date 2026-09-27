# Testing guide

| Layer | Command | Needs | What it proves |
|---|---|---|---|
| Unit (16) | `npm test` | nothing | Charge maths (Decimal), FX (direct, inverse, unknown), state machine, filter allowlist, param validation |
| Integration (17) | `npm run test:e2e` | Postgres + Redis (`docker compose up -d postgres redis`) | The real API + workers in-process against a real database (list below) |
| Chaos | `npm run chaos` | The full stack (`docker compose up -d --build`) | `kill -9` mid-batch → exactly-once after recovery |
| Load | `npm run loadtest` | The full stack | Throughput in entities/min |
| API walkthrough | Postman collection (34 requests) | The full stack or the live URL | Every endpoint and the error cases |

CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) runs the typecheck, build, unit and integration tests against Postgres and Redis service containers, plus a Docker image build, on every push and pull request.

## Integration tests ([test/bulk-jobs.e2e-spec.ts](../test/bulk-jobs.e2e-spec.ts))

Each run creates its own tenant and 140 shipments (90 priceable, 10 missing weight, 10 billed, 10 AED, 20 booked), uses its own BullMQ key prefix so a running local stack can't interfere, and deletes everything afterwards.

- **Validation:** an unknown filter key, an unsupported action, invalid params, an unknown tenant → 400.
- **Request idempotency:** a replay returns 200 with the same job and `Idempotent-Replayed`; a different body with the same key → 422.
- **Partial failure:** 120 matched → 90 success + 30 failed with the exact reasons; the job completes; the amount is correct.
- **Log:** the outcome filter and cursor pagination.
- **Entity idempotency:** re-running the same charge → 90 skipped `charge_already_applied`, and still 90 charges.
- **Crash redelivery:** a batch with an expired lease from a "dead worker" is redelivered → claimed (attempt +1) → counters, entries and charges unchanged.
- **Second action:** illegal transitions are per-entity failures; legal ones succeed.
- **Scheduling and cancel:** a scheduled job is listed as `scheduled`; cancel → `cancelled`; a second cancel → 409; nothing processed.
- **Tenant scoping:** another tenant's job → 404.
- **SSE:** a `text/event-stream` of `progress` events, ending with `done` and `processed = total`; an unknown job → 404.
- **Swagger:** `/docs-json` lists every bulk-job route.
- **Rate limiter:** grants within the limit, refuses above it with a retry-after of about 60 s, and a release frees capacity.

## Chaos test ([scripts/chaos-test.sh](../scripts/chaos-test.sh))

```bash
docker compose up -d --build
npm run chaos
```
1. Restarts the worker slowed down (`BULK_DEBUG_ENTITY_DELAY_MS=20`, lease TTL 10 s).
2. Starts a charge job on all ~4,500 `tnt_demo` shipments.
3. After 6 s, runs **`kill -9`** on the worker. Typically 4 batches are caught `leased`, mid-transaction.
4. Restarts the worker and waits. There's a ~30–40 s pause while BullMQ detects the stalled jobs and the leases expire.
5. Verifies that `processed = total`, success entries = the success counter = charges, **0 shipments double-charged**, and reports how many batches were retried.

Expected output:
```
✅ PASS  processed 4511/4511 · success entries 4080 = counter 4080 = charges 4080 · double-charged 0 · batches retried 4
```
It restores the worker to normal settings on exit, even if it fails.

## Load test ([loadtest/run.ts](../loadtest/run.ts), or k6: [loadtest/bulk-charge.js](../loadtest/bulk-charge.js))

```bash
TENANT_RATE_LIMIT_PER_MIN=1000000 docker compose up -d --scale worker=3     # raise the cap to measure the engine
docker compose exec -T postgres psql -U shipmnts -d bulk_charge < loadtest/seed-load-tenant.sql   # 50k shipments
TENANT=tnt_load npm run loadtest
docker compose up -d --scale worker=1                                        # back to the default 5,000/min
```
Each run uses a fresh charge code, so nothing is skipped. Measured on a laptop: **≈110k/min with 1 worker, ≈195k/min with 3.** With the default limit, a tenant is capped at 5,000/min by design.

**To observe the rate limit:** run `TENANT_RATE_LIMIT_PER_MIN=1500 docker compose up -d worker`, then start a job over all `tnt_demo` shipments. It processes about 1,500 and holds until the 60 s window rolls; `GET /v1/bulk-jobs/{id}` shows the batches `pending` and `tenant_rate.used_last_60s` at 1,500.

## Postman

Import [postman/Bulk-Jobs.postman_collection.json](../postman/Bulk-Jobs.postman_collection.json) and one environment ([Local](../postman/Local.postman_environment.json) or [Live](../postman/Live.postman_environment.json); set its `baseUrl` to the deployed URL). Run the folders top to bottom; job ids are captured automatically. Headless:
```bash
npx newman run postman/Bulk-Jobs.postman_collection.json -e postman/Local.postman_environment.json --delay-request 700
```

## Manual scenarios (a good demo order)

Run `npm run reset:demo` first so the numbers match.

| # | Do | Expect |
|---|---|---|
| 1 | Folder 1 → *Create charge job* | 201; summary 598 matched → **524 success / 74 failed** (`missing_weight` 30, `unknown_currency_pair:USD->AED` 25, `already_billed` 19) |
| 2 | *Replay same Idempotency-Key* | 200, same job id |
| 3 | *Same key, different body* | 422 |
| 4 | *Live progress stream* (or `curl -N …/events`) | `progress` events, then `done` |
| 5 | *Re-run same charge (new key)* | 0 success / 74 failed / **524 skipped** `charge_already_applied` |
| 6 | *Inspect a shipment* (SHP-000001) | An FSC line: 546.0506 USD × 83.25 = 45,458.7125 INR |
| 7 | Folder 2 → illegal transition | 175 failed `illegal_transition:booked->delivered` |
| 8 | Folder 2 → legal transition | 175 success; the shipments are now `in_transit` |
| 9 | Folder 3 → schedule, list, cancel, cancel again | `scheduled` → 202 `cancelled` → 409 |
| 10 | Cancel mid-run: `BULK_DEBUG_ENTITY_DELAY_MS=20 docker compose up -d worker`, then folder 3 → *Start a big job* → *Cancel running job* | `cancelling` → `cancelled`; processed < total; batches mostly `cancelled`; processed shipments keep their charges. Afterwards: `docker compose up -d worker` |
| 11 | Folder 5 | Clear 400s, including the filter typo |
| 12 | `npm run chaos` | ✅ PASS |
