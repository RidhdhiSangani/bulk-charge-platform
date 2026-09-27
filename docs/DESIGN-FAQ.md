# Design FAQ

Short answers to the questions this design usually raises, with pointers into the code.

---

### Why PostgreSQL + Redis/BullMQ, and not Kafka?
- **Postgres** holds everything that must be correct: shipments, charges, jobs, batches and the per-entity log. Its unique constraints and transactions are what make "exactly once" true.
- **BullMQ on Redis** gives discrete tasks, delayed jobs (for `scheduled_at`), retries with backoff, stalled-job detection and a worker pool. That's exactly the shape of the problem: "do each piece of work once".
- **Kafka** is built for replayable event logs and partitioned stream processing. Its exactly-once semantics would add significant operational work without replacing the database constraints we need anyway.

### How is a filter processed without loading a million rows?
- The client sends a *filter*, never an id list. Keys are allowlisted ([shipment.adapter.ts](../src/actions/shipment.adapter.ts)), and an unknown key is a **400**, so a typo can't silently widen the match to every shipment.
- The orchestrator reads **ids only, 100 at a time, by keyset**: `WHERE <filter> AND id > :cursor ORDER BY id LIMIT 100`. Each page costs the same at any depth, unlike `OFFSET`. Memory is one page, whatever the job size.
- `total_matched` comes from one `COUNT(*)` on the same indexed predicate. It's reconciled with what was actually batched when the scan finishes.

### What happens if a worker crashes mid-job?
- **Orchestrator crash:** `cursor_after_id` and `next_batch_no` are saved after every page, so it resumes from there. Batch rows are upserted on `(job_id, batch_no)`, so a replayed page can't duplicate one.
- **Batch worker crash:** the batch runs in one transaction, so nothing of it is committed and there's no partial state. Its lease expires (`LEASE_TTL_SECONDS`), and the same queue job (redelivered by BullMQ) or the watchdog re-claims it and runs it again. Entities already logged for the job are skipped, and the unique constraints are the final backstop.
- **Proof:** `npm run chaos` (`kill -9` mid-batch) → exactly-once, 0 double charges.

### What is the lease fencing token?
Every claim writes a unique token (`host:pid:random`) into `job_batches.lease_owner`. The commit is conditional:
```sql
UPDATE job_batches SET status='done' WHERE id=:id AND status='leased' AND lease_owner=:myToken
```
If a worker stalls for longer than the lease (a GC pause or a network partition) and another worker takes the batch over, the stalled worker's commit matches 0 rows. It throws, and its **whole transaction rolls back**, so a "zombie" can never commit. See [batch.processor.ts](../src/bulk-engine/batch.processor.ts).

### Where is the rate limit enforced, and why not BullMQ's limiter?
- The decision is made in [tenant-rate-limiter.service.ts](../src/bulk-engine/tenant-rate-limiter.service.ts): a Lua script, atomic inside Redis, over a per-tenant sorted set. It's a **strict sliding window**: no more than N entities in any 60 s. It uses the Redis clock, so workers with drifting clocks agree.
- It's enforced at the start of every batch in [batch.processor.ts](../src/bulk-engine/batch.processor.ts). If refused, the batch is moved back to *delayed* for exactly the time the window needs (plus jitter). That isn't a failure and doesn't use up a retry attempt. Tokens that turn out to be unused are refunded.
- BullMQ's built-in limiter counts *jobs* per queue. The requirement is *entities* per *tenant* across all of that tenant's jobs.

### What's the difference between the Idempotency-Key and "never charge twice"?
| | Request level: `Idempotency-Key` | Entity level: `(shipment_id, charge_code)` |
|---|---|---|
| Catches | The same request sent twice (a network retry, a double-click) | A shipment that already has the charge, whichever job tries |
| Mechanism | `UNIQUE(tenant_id, idempotency_key)` + a request hash (a different body → 422) | `UNIQUE(shipment_id, charge_code)` + a check in the action → `skipped / charge_already_applied` |

Sending the **same body with a new key** creates a new job, on purpose: the client might really mean "run it again", for example after fixing missing weights. Every shipment that already has the charge is skipped, so no money is added twice.

### Where should the Idempotency-Key come from?
From the **client**, once per user intention, reused for every retry of that intention. That's usually `crypto.randomUUID()` generated when the user clicks. For scheduled or automated callers, derive it from the business intent (for example `fsc-INNSA-2026-11`), so a cron firing twice still creates one job. Don't generate a new key per retry. In production, keys would expire after 24 hours to 7 days; here they're kept forever.

### What exactly does cancel do, and can it undo processed work?
- Scheduled or queued → cancelled at once; the delayed start is removed.
- Running → `cancel_requested_at` is set and every pending batch is closed immediately. In-flight batches (a handful) stop at their next check, every `CANCEL_CHECK_EVERY` shipments, and commit what they finished. The job becomes `cancelled` when they drain.
- **Processed work is kept.** That's what the spec asks for, and each batch is committed independently.

**If processed work had to be reverted**, I'd use a **compensating job** (the saga pattern), not a rollback, because a million-row transaction isn't viable:
1. Cancel, and wait until no batch is leased.
2. Create a `revert` job whose input is the original job's `success` rows in `job_entries`.
3. It runs on the same engine: batching, leases, crash safety, logging.
4. Each action implements `compensate()`:
   - charges: void or delete the lines with that `bulk_job_id` (already stored);
   - status: restore a stored before-image with a guarded update (`WHERE status = <what we set>`), so newer changes are never overwritten.
5. Entities that can't be reverted (for example, invoiced since) become per-entity failures with a reason.

The alternative, for strict all-or-nothing semantics, is to write charges as *provisional* and publish them only when the job completes; cancel then just discards them.

### How was the second action added without touching the engine?
The engine only knows two interfaces, `EntityAdapter` (count, scan ids, lock rows, re-check the filter) and `BulkAction` (`validateParams`, `execute`), plus registries keyed by `entity_type:action_type`. `transition_status` is one class, a 20-line state machine, and one `register()` line in [shipment.module.ts](../src/actions/shipment.module.ts). Adding an entity (for example Invoice) means one adapter, its actions, and one module in `CoreModule`.

### How are illegal transitions handled?
Two layers:
1. At creation, an unknown `target_status` returns **400**.
2. Per shipment, the action returns `failed / illegal_transition:<from>-><to>` unless the target is exactly the next step, `skipped / already_in_target_status` if there's nothing to do, and otherwise updates the status. It *returns* the failure instead of throwing, so the job carries on and completes. A job is `failed` only when the engine itself can't run.

### Why is money computed with Decimal?
`0.1 + 0.2 ≠ 0.3` in binary floating point. Amounts use `Prisma.Decimal` (decimal.js), round half up to 4 decimal places, and are stored as `NUMERIC`. FX rates are cached in memory for 60 s, so pricing a batch doesn't cost one query per shipment.

### Why is there a "combined mode"?
Render's free plan has no background workers. `RUN_WORKERS_IN_API=true` loads the same queue consumers into the API process. Nothing else changes: the same engine, queues and guarantees. Production would run `api` and `worker` separately, as `docker-compose.yml` does, and scale the workers.

### How does real-time progress work?
`GET /v1/bulk-jobs/{id}/events` is a Server-Sent Events stream. It pushes the job's progress every second (reusing the detail query), sends a final `done` event and closes. At larger scale, workers would publish progress over Redis pub/sub and the API would fan it out, instead of each open stream polling Postgres.
