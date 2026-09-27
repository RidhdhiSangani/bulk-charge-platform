-- Resets the two Postman demos so they can be run again from a clean state:
--   Part A: the FSC bulk charge   (tnt_demo, apply_charge, charge_code FSC)
--   Part B: the SGSIN transitions (tnt_demo, transition_status, filter origin_port SGSIN)
--
-- Run:
--   PGPASSWORD=shipmnts psql -h localhost -p 5433 -U shipmnts -d bulk_charge -f scripts/reset-demo.sql
--
-- Everything else (other jobs, other charge codes, other ports, tnt_acme) is kept.
-- Delete order matters: job_entries -> job_batches -> bulk_jobs (foreign keys).

BEGIN;

-- =====================================================================================
-- Part A: FSC bulk charge
-- =====================================================================================

CREATE TEMP TABLE fsc_jobs ON COMMIT DROP AS
SELECT id FROM bulk_jobs
WHERE tenant_id = 'tnt_demo'
  AND action_type = 'apply_charge'
  AND params->>'charge_code' = 'FSC';

-- A1. Per-shipment log rows of those jobs
DELETE FROM job_entries WHERE job_id IN (SELECT id FROM fsc_jobs);
-- A2. Their batches
DELETE FROM job_batches WHERE job_id IN (SELECT id FROM fsc_jobs);
-- A3. The jobs (also frees their Idempotency-Keys, e.g. fsc-demo-1)
DELETE FROM bulk_jobs WHERE id IN (SELECT id FROM fsc_jobs);
-- A4. The FSC charge lines on tnt_demo shipments, so the next run applies them again
DELETE FROM shipment_charges
WHERE charge_code = 'FSC'
  AND shipment_id IN (SELECT id FROM shipments WHERE tenant_id = 'tnt_demo');

-- =====================================================================================
-- Part B: SGSIN status transitions
-- =====================================================================================

-- Transition jobs on SGSIN whose filter names the status they moved shipments FROM.
CREATE TEMP TABLE sgsin_jobs ON COMMIT DROP AS
SELECT id, filter->>'status' AS from_status, created_at
FROM bulk_jobs
WHERE tenant_id = 'tnt_demo'
  AND action_type = 'transition_status'
  AND filter->>'origin_port' = 'SGSIN'
  AND filter ? 'status';

-- B1. Put every shipment those jobs moved back to the status it had before the FIRST job
--     that moved it (read from that job's own success log in job_entries).
UPDATE shipments s
SET status = r.from_status
FROM (
  SELECT DISTINCT ON (e.entity_id) e.entity_id, j.from_status
  FROM job_entries e
  JOIN sgsin_jobs j ON j.id = e.job_id
  WHERE e.outcome = 'success'
  ORDER BY e.entity_id, j.created_at
) r
WHERE s.id = r.entity_id;

-- B2..B4. Remove those jobs' log rows, batches and job rows
DELETE FROM job_entries WHERE job_id IN (SELECT id FROM sgsin_jobs);
DELETE FROM job_batches WHERE job_id IN (SELECT id FROM sgsin_jobs);
DELETE FROM bulk_jobs   WHERE id IN (SELECT id FROM sgsin_jobs);

COMMIT;

-- =====================================================================================
-- Check: first three should be 0, sgsin_booked should be 175 with the seed data
-- =====================================================================================
SELECT
  (SELECT count(*) FROM bulk_jobs WHERE tenant_id = 'tnt_demo' AND params->>'charge_code' = 'FSC') AS fsc_jobs_left,
  (SELECT count(*) FROM shipment_charges c JOIN shipments s ON s.id = c.shipment_id
     WHERE s.tenant_id = 'tnt_demo' AND c.charge_code = 'FSC')                                 AS fsc_charges_left,
  (SELECT count(*) FROM bulk_jobs WHERE tenant_id = 'tnt_demo' AND action_type = 'transition_status'
     AND filter->>'origin_port' = 'SGSIN')                                                     AS sgsin_jobs_left,
  (SELECT count(*) FROM shipments WHERE tenant_id = 'tnt_demo' AND origin_port = 'SGSIN'
     AND status = 'booked')                                                                    AS sgsin_booked;
