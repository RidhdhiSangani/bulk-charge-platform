import { Prisma } from '@prisma/client';

// Engine-level types only. Nothing in this folder may know about a concrete entity
// (Shipment, Invoice, ...). Entity/action specific types live next to their adapters/actions.

export type EntityOutcome = 'success' | 'failed' | 'skipped';

export const ENTITY_OUTCOMES: readonly EntityOutcome[] = ['success', 'failed', 'skipped'];

export type ActionResult = {
  outcome: EntityOutcome;
  reason?: string;
};

export type ActionContext = {
  jobId: string;
  tenantId: string;
  batchId: bigint;
  // The batch transaction. Actions must write through it so their side effects commit
  // (or roll back) atomically with the per-entity log entry.
  tx: Prisma.TransactionClient;
};

export type JsonMap = Record<string, unknown>;

export type BulkJobStatus = 'scheduled' | 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export const BULK_JOB_STATUSES: readonly BulkJobStatus[] = [
  'scheduled',
  'queued',
  'running',
  'completed',
  'cancelled',
  'failed',
];

export const TERMINAL_JOB_STATUSES: readonly BulkJobStatus[] = ['completed', 'cancelled', 'failed'];

export type BatchStatus = 'pending' | 'leased' | 'done' | 'cancelled';
