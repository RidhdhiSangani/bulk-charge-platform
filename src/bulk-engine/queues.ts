export const QUEUE_ORCHESTRATE = 'bulk-orchestrate';
export const QUEUE_BATCHES = 'bulk-batches';
export const QUEUE_WATCHDOG = 'bulk-watchdog';

export type OrchestrateJobData = { jobId: string };

export type BatchJobData = {
  jobId: string;
  batchId: string;
  tenantId: string;
  entityCount: number;
};

// BullMQ custom job ids must not contain ':'. Deterministic ids make enqueues idempotent:
// adding the same id twice while the first is still waiting/active is a no-op.
export const orchestrateQueueJobId = (jobId: string) => `orch-${jobId}`;
export const batchQueueJobId = (jobId: string, batchNo: number) => `b-${jobId}-${batchNo}`;

export const ORCHESTRATE_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const BATCH_JOB_OPTS = {
  attempts: 10,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};
