-- Which bulk job applied a charge (audit / traceability).
ALTER TABLE "shipment_charges" ADD COLUMN "bulk_job_id" UUID;

-- Request-level idempotency: detect a reused Idempotency-Key with a different body.
ALTER TABLE "bulk_jobs" ADD COLUMN "request_hash" TEXT;
-- BullMQ id of the current orchestrate job (for cancel removal + watchdog reconciliation).
ALTER TABLE "bulk_jobs" ADD COLUMN "orchestrate_job_id" TEXT;
CREATE INDEX "bulk_jobs_status_created_at_idx" ON "bulk_jobs"("status", "created_at");

-- Batch bookkeeping: BullMQ job id (watchdog checks it is still alive), last watchdog check,
-- completion time.
ALTER TABLE "job_batches" ADD COLUMN "queue_job_id" TEXT;
ALTER TABLE "job_batches" ADD COLUMN "checked_at" TIMESTAMP(3);
ALTER TABLE "job_batches" ADD COLUMN "completed_at" TIMESTAMP(3);
