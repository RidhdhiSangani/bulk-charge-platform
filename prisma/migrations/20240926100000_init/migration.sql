-- CreateSchema
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shipments" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shipment_no" TEXT NOT NULL,
    "trade_type" TEXT NOT NULL,
    "origin_port" TEXT NOT NULL,
    "destination_port" TEXT NOT NULL,
    "container_count" INTEGER NOT NULL,
    "chargeable_weight" DECIMAL(12,3),
    "customer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "billing_currency" TEXT NOT NULL,
    "is_billed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shipment_charges" (
    "id" BIGSERIAL NOT NULL,
    "shipment_id" BIGINT NOT NULL,
    "charge_code" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "amount_billing" DECIMAL(14,4) NOT NULL,
    "billing_currency" TEXT NOT NULL,
    "fx_rate" DECIMAL(18,8) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shipment_charges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fx_rates" (
    "id" SERIAL NOT NULL,
    "base_currency" TEXT NOT NULL,
    "quote_currency" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bulk_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "params" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancel_requested_at" TIMESTAMP(3),
    "total_matched" INTEGER,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "cursor_after_id" BIGINT,
    "next_batch_no" INTEGER NOT NULL DEFAULT 0,
    "scan_complete" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bulk_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "job_batches" (
    "id" BIGSERIAL NOT NULL,
    "job_id" UUID NOT NULL,
    "batch_no" INTEGER NOT NULL,
    "cursor_from_id" BIGINT NOT NULL,
    "cursor_to_id" BIGINT NOT NULL,
    "entity_ids" BIGINT[],
    "status" TEXT NOT NULL,
    "leased_at" TIMESTAMP(3),
    "lease_owner" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "job_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "job_entries" (
    "id" BIGSERIAL NOT NULL,
    "job_id" UUID NOT NULL,
    "batch_id" BIGINT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" BIGINT NOT NULL,
    "entity_ref" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "job_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipments_tenant_id_shipment_no_key" ON "shipments"("tenant_id", "shipment_no");
CREATE INDEX "shipments_tenant_id_origin_port_status_id_idx" ON "shipments"("tenant_id", "origin_port", "status", "id");
CREATE INDEX "shipments_tenant_id_status_id_idx" ON "shipments"("tenant_id", "status", "id");
CREATE INDEX "shipments_tenant_id_destination_port_id_idx" ON "shipments"("tenant_id", "destination_port", "id");

CREATE UNIQUE INDEX "shipment_charges_shipment_id_charge_code_key" ON "shipment_charges"("shipment_id", "charge_code");
CREATE UNIQUE INDEX "fx_rates_base_currency_quote_currency_key" ON "fx_rates"("base_currency", "quote_currency");
CREATE UNIQUE INDEX "bulk_jobs_tenant_id_idempotency_key_key" ON "bulk_jobs"("tenant_id", "idempotency_key");
CREATE INDEX "bulk_jobs_tenant_id_status_idx" ON "bulk_jobs"("tenant_id", "status");
CREATE UNIQUE INDEX "job_batches_job_id_batch_no_key" ON "job_batches"("job_id", "batch_no");
CREATE INDEX "job_batches_status_id_idx" ON "job_batches"("status", "id");
CREATE INDEX "job_batches_job_id_status_idx" ON "job_batches"("job_id", "status");
CREATE UNIQUE INDEX "job_entries_job_id_entity_id_key" ON "job_entries"("job_id", "entity_id");
CREATE INDEX "job_entries_job_id_outcome_id_idx" ON "job_entries"("job_id", "outcome", "id");

ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_charges" ADD CONSTRAINT "shipment_charges_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bulk_jobs" ADD CONSTRAINT "bulk_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_batches" ADD CONSTRAINT "job_batches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "bulk_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_entries" ADD CONSTRAINT "job_entries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "bulk_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_entries" ADD CONSTRAINT "job_entries_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "job_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
