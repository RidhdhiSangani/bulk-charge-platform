# Database guide

The database is PostgreSQL 16. It's the source of truth for every shipment, charge, job, batch and per-entity log row. The schema is defined in [prisma/schema.prisma](../prisma/schema.prisma), and the SQL that creates it is in [prisma/migrations/](../prisma/migrations/).

## Connecting (local Docker stack)

| Setting | Value |
|---|---|
| Host / Port | `localhost` / **`5433`** |
| Database | `bulk_charge` |
| User / Password | `shipmnts` / `shipmnts` |
| URL | `postgresql://shipmnts:shipmnts@localhost:5433/bulk_charge` |

```bash
npx prisma studio                                                        # browser UI at http://localhost:5555
PGPASSWORD=shipmnts psql -h localhost -p 5433 -U shipmnts -d bulk_charge  # terminal
docker compose exec postgres psql -U shipmnts -d bulk_charge             # without a local psql
```

In pgAdmin, DBeaver or TablePlus, use the settings above. The tables are under **bulk_charge → Schemas → public → Tables**. The `postgres` database is the empty default one.

On Render, open the database in the dashboard. "Connect" shows an External Database URL you can paste into any of these tools.

## Tables

```
tenants ─┬─< shipments ──< shipment_charges        UNIQUE(shipment_id, charge_code)
         └─< bulk_jobs ─┬─< job_batches             UNIQUE(job_id, batch_no)
                        └─< job_entries >─ job_batches   UNIQUE(job_id, entity_id)
fx_rates                                            UNIQUE(base_currency, quote_currency)
```

### Business data

| Table | What a row is | Notable columns |
|---|---|---|
| `tenants` | A customer of the platform (`tnt_demo`, `tnt_acme`) | `id`, `name` |
| `shipments` | One shipment | `id` (BIGSERIAL, used as the keyset cursor), `shipment_no`, `trade_type`, `origin_port`, `destination_port`, `container_count`, `chargeable_weight` (nullable), `customer_id`, `status`, **`billing_currency`** (the FX target), **`is_billed`** (invoiced shipments can't be charged) |
| `shipment_charges` | **One charge line on a shipment**; this is where `apply_charge` writes | `shipment_id`, `charge_code`, `basis`, `rate`, `currency`, `amount` (in the rate currency), `fx_rate`, `amount_billing` + `billing_currency` (what the customer pays), `bulk_job_id` (which job added it) |
| `fx_rates` | Static exchange rates | `base_currency`, `quote_currency`, `rate`. Deliberately, no AED pairs. |

### Job bookkeeping

| Table | What a row is | Notable columns |
|---|---|---|
| `bulk_jobs` | One submitted job (the "ticket") | `action_type`, `entity_type`, `filter` + `params` (JSONB, snapshotted), `status`, timestamps, `total_matched`, `success_count` / `failed_count` / `skipped_count`, `cursor_after_id` + `next_batch_no` + `scan_complete` (orchestrator progress), `idempotency_key` + `request_hash`, `orchestrate_job_id`, `error_message` |
| `job_batches` | A slice of ≤100 entities of a job | `batch_no`, `entity_ids BIGINT[]` (frozen at scan time), `status` (`pending` → `leased` → `done` \| `cancelled`), `leased_at`, `lease_owner` (the fencing token), `attempt_count`, `queue_job_id`, `checked_at` |
| `job_entries` | **What happened to one entity in one job** (the per-entity log) | `entity_id`, `entity_ref` (the shipment number), `outcome` (`success` \| `failed` \| `skipped`), `reason`, `batch_id`, `processed_at` |
| `_prisma_migrations` | Prisma's record of which migrations have run | — |

### Constraints that carry the guarantees
- **`shipment_charges UNIQUE(shipment_id, charge_code)`**: a charge can never be applied twice, whatever happens in the application.
- **`job_entries UNIQUE(job_id, entity_id)`**: an entity is processed and counted at most once per job.
- **`bulk_jobs UNIQUE(tenant_id, idempotency_key)`**: request-level idempotency. Concurrent retries can't create two jobs.
- **`job_batches UNIQUE(job_id, batch_no)`**: an orchestrator that restarts can't create duplicate batches.

## What "applying a charge" writes

For each matching shipment, `apply_charge`:
1. **reads** the `shipments` row (weight, containers, billing currency, `is_billed`);
2. **inserts one row** into `shipment_charges`;
3. writes one `job_entries` row.

The `shipments` row itself isn't modified. (`transition_status` is the opposite: it *updates* `shipments.status` and inserts no charge.)

Worked example: SHP-000001 has 4,550.422 kg and bills in INR. FSC at 0.12 USD/kg:
```
amount          = 0.12 × 4550.422          = 546.0506 USD
fx_rate         = USD→INR                   = 83.25
amount_billing  = 546.0506 × 83.25          = 45,458.7125 INR   ← what the customer is billed
```

## Useful queries

```sql
-- Latest jobs and their scoreboard
SELECT id, action_type, status, total_matched, success_count, failed_count, skipped_count, created_at
FROM bulk_jobs ORDER BY created_at DESC LIMIT 10;

-- Why things failed or were skipped in a job
SELECT outcome, reason, count(*) FROM job_entries
WHERE job_id = '<job-id>' AND outcome <> 'success' GROUP BY 1, 2 ORDER BY 3 DESC;

-- A shipment and its charge lines
SELECT s.shipment_no, s.status, c.charge_code, c.amount, c.currency, c.fx_rate, c.amount_billing, c.billing_currency
FROM shipments s LEFT JOIN shipment_charges c ON c.shipment_id = s.id
WHERE s.tenant_id = 'tnt_demo' AND s.shipment_no = 'SHP-000001';

-- Batch states of a job (what is it doing right now?)
SELECT status, count(*), max(attempt_count) FROM job_batches WHERE job_id = '<job-id>' GROUP BY 1;

-- Proof of "never charged twice" (must return 0 rows)
SELECT shipment_id, charge_code, count(*) FROM shipment_charges GROUP BY 1, 2 HAVING count(*) > 1;

-- Counters agree with the log (must return 0 rows)
SELECT j.id FROM bulk_jobs j
WHERE j.success_count <> (SELECT count(*) FROM job_entries e WHERE e.job_id = j.id AND e.outcome = 'success');
```

## Resetting demo data

| Goal | Command |
|---|---|
| Re-run the FSC charge and SGSIN transition Postman demos from a clean state | `npm run reset:demo` (runs [scripts/reset-demo.sql](../scripts/reset-demo.sql)) |
| Back to the original 5,000 shipments, with no jobs or charges | `docker compose run --rm migrate node dist/seed/seed.js --reset` |
| Wipe everything, including the Docker volume | `docker compose down -v && docker compose up -d --build` |

`reset-demo.sql` does the following in one transaction:
- deletes the FSC jobs' `job_entries` → `job_batches` → `bulk_jobs` (child tables first, because of the foreign keys) and the FSC `shipment_charges`;
- puts every SGSIN shipment moved by a transition job back to its previous status, read from that job's own success log, and deletes those jobs.
