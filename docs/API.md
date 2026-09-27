# API reference

The base URL is `http://localhost:3000` locally, or the Render URL when deployed. There's interactive documentation at **`/docs`** (Swagger UI) and the raw OpenAPI JSON at `/docs-json`. The Postman collection is at [postman/Bulk-Jobs.postman_collection.json](../postman/Bulk-Jobs.postman_collection.json).

**Tenancy.** There's no authentication (out of scope). The create body carries `tenant_id`. Read and cancel endpoints can be scoped with `?tenant_id=` or an `X-Tenant-Id` header (the header wins); a job belonging to another tenant then returns **404**. The seeded tenants are `tnt_demo` (≈4,500 shipments) and `tnt_acme` (≈500).

---

## `POST /v1/bulk-jobs`: create a job

```http
POST /v1/bulk-jobs
Content-Type: application/json
Idempotency-Key: 7f3c1b2e-...        (optional; client-generated, reused on retries)

{
  "tenant_id": "tnt_demo",
  "action_type": "apply_charge",
  "entity_type": "shipment",
  "filter": { "origin_port": "INNSA", "status": "in_transit" },
  "params": { "charge_code": "FSC", "basis": "per_kg", "rate": 0.12, "currency": "USD" },
  "scheduled_at": "2030-11-22T23:15:00+05:30"      (optional)
}
```

| Field | Rules |
|---|---|
| `action_type` / `entity_type` | A registered pair: `shipment` + `apply_charge` or `transition_status` |
| `filter` | Exact match on the allowlisted keys `origin_port`, `destination_port`, `status`, `trade_type`, `customer_id`. **An unknown key returns 400.** `{}` means every shipment of the tenant. |
| `params` (apply_charge) | `charge_code` (1–64 chars `[A-Za-z0-9_-]`), `basis` (`per_container` \| `per_kg` \| `flat`), `rate` (> 0), `currency` (ISO code, e.g. `USD`) |
| `params` (transition_status) | `target_status` (`booked` \| `in_transit` \| `arrived` \| `delivered`) |
| `scheduled_at` | ISO-8601. A future time gives status `scheduled`; a past time or no value runs now (`queued`). |

| Response | When |
|---|---|
| **201** + job | Created |
| **200** + the original job, header `Idempotent-Replayed: true` | Same `Idempotency-Key` and same body (a retry) |
| **422** | Same `Idempotency-Key` with a *different* body |
| **400** | Invalid filter or params, unsupported action, unknown tenant |

The response is the job object (see below), returned immediately. Processing happens in the background.

## `GET /v1/bulk-jobs/{id}`: detail and live progress

```json
{
  "id": "4e9da986-…",
  "tenant_id": "tnt_demo",
  "action_type": "apply_charge",
  "entity_type": "shipment",
  "filter": { "origin_port": "INNSA", "status": "in_transit" },
  "params": { "charge_code": "FSC", "basis": "per_kg", "rate": 0.12, "currency": "USD" },
  "status": "running",
  "idempotency_key": "fsc-demo-1",
  "scheduled_at": null, "started_at": "…", "completed_at": null, "cancel_requested_at": null,
  "created_at": "…", "error_message": null,
  "total_matched": 598,
  "progress": {
    "processed": 300, "total": 598, "remaining": 298, "percent": 50.17,
    "success": 262, "failed": 38, "skipped": 0,
    "throughput_per_min": 59110, "elapsed_ms": 304,
    "estimated_completion_at": "2026-09-27T05:31:34.100Z"
  },
  "batches": { "total": 6, "pending": 2, "leased": 1, "done": 3, "cancelled": 0 },
  "tenant_rate": { "limit_per_min": 5000, "used_last_60s": 400 }
}
```

- **`status`** is one of `scheduled`, `queued`, `running`, `completed`, `cancelled` or `failed`. `failed` means the *engine* couldn't run the job (for example the database was unreachable during the count after 5 attempts), and `error_message` explains why. Per-shipment problems never fail the job.
- **`estimated_completion_at`** is a linear estimate: remaining ÷ observed throughput since `started_at`, including time spent waiting on the rate limit. It's `null` when the job isn't running.
- **`batches`** and **`tenant_rate`** answer "what is it doing right now?". For example, lots of `pending` with `used_last_60s` at the limit means the job is being rate-limited.

## `GET /v1/bulk-jobs/{id}/events`: real-time progress (Server-Sent Events)

It keeps the connection open and pushes the progress every `interval_ms` (default 1000, range 250–10000). When the job reaches a terminal state it sends one `done` event and closes the stream.

```bash
curl -N http://localhost:3000/v1/bulk-jobs/<id>/events
```
```
id: 1
event: progress
data: {"id":"…","status":"running","total_matched":4511,"progress":{"processed":1200,…},"batches":{…},"tenant_rate":{…}}

id: 2
event: progress
data: {"id":"…","status":"running","total_matched":4511,"progress":{"processed":2400,…},…}

id: 3
event: done
data: {"id":"…","status":"completed","total_matched":4511,"progress":{"processed":4511,…},…}
```
From a browser: `new EventSource('/v1/bulk-jobs/<id>/events').addEventListener('progress', e => …)`. An unknown job returns a normal **404** instead of an empty stream.

## `GET /v1/bulk-jobs/{id}/summary`

```json
{
  "job_id": "…", "status": "completed", "total_matched": 598, "processed": 598,
  "success": 524, "failed": 74, "skipped": 0, "pending": 0,
  "reasons": [
    { "outcome": "failed", "reason": "missing_weight", "count": 30 },
    { "outcome": "failed", "reason": "unknown_currency_pair:USD->AED", "count": 25 },
    { "outcome": "failed", "reason": "already_billed", "count": 19 }
  ]
}
```

## `GET /v1/bulk-jobs/{id}/entries`: per-entity log

Query: `outcome` (`success` \| `failed` \| `skipped`), `limit` (1–500, default 50), `cursor` (the `next_cursor` from the previous page).

```json
{
  "job_id": "…", "outcome": "failed",
  "data": [
    { "id": "13", "entity_type": "shipment", "entity_id": "893", "entity_ref": "SHP-000893",
      "outcome": "failed", "reason": "already_billed", "batch_id": "2", "processed_at": "…" }
  ],
  "next_cursor": "16"
}
```
`next_cursor: null` means this is the last page.

## `GET /v1/bulk-jobs`: list

Query: `status`, `tenant_id` (or `X-Tenant-Id`), `limit` (1–100, default 20), `cursor`. Newest first; the response is `{ data: [job…], next_cursor }`.

## `POST /v1/bulk-jobs/{id}/cancel`

| Job state | Effect | Response |
|---|---|---|
| `scheduled` / `queued` | Cancelled immediately; the delayed start is removed; nothing is processed | **202** `{ "cancel": "cancelled", "job": … }` |
| `running` | Pending batches are closed at once; in-flight batches stop at their next check; processed entities stay processed; the job becomes `cancelled` once they drain | **202** `{ "cancel": "cancelling" \| "cancelled", "job": … }` |
| `completed` / `cancelled` / `failed` | No change | **409** |

## `GET /v1/shipments/{shipmentNo}?tenant_id=tnt_demo` (demo helper)
Returns the shipment with its status and every charge line (`charge_code`, `amount`, `fx_rate`, `amount_billing`, `bulk_job_id`, and so on), so you can see a job's effect.

## `GET /health`
`{"status":"ok","db":"ok","redis":"ok","actions":[{"entity_type":"shipment","action_type":"apply_charge"},…]}`. Returns **503** if Postgres or Redis is down.

---

## Per-entity reason codes

| Outcome | Reason | Meaning |
|---|---|---|
| `failed` | `missing_weight` | `per_kg` charge on a shipment with no chargeable weight |
| `failed` | `invalid_weight` / `missing_container_count` | The weight or container count isn't positive |
| `failed` | `already_billed` | The shipment has been invoiced; charges can't be added |
| `failed` | `unknown_currency_pair:USD->AED` | No FX rate for the pair (none are seeded for AED, on purpose) |
| `failed` | `illegal_transition:booked->delivered` | Not the next step in `booked → in_transit → arrived → delivered` |
| `failed` | `unexpected_error:…` | The action threw; only that entity was rolled back |
| `skipped` | `charge_already_applied` | `(shipment_id, charge_code)` already exists (entity-level idempotency) |
| `skipped` | `already_in_target_status` | Nothing to do |
| `skipped` | `no_longer_matches_filter` | The shipment changed after the scan, so it isn't acted on |
| `skipped` | `entity_not_found` | The shipment was deleted after the scan |
