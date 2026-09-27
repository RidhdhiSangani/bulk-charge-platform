import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { config } from '../config';
import { JobFinalizer } from './job-finalizer.service';
import {
  BATCH_JOB_OPTS,
  BatchJobData,
  ORCHESTRATE_JOB_OPTS,
  OrchestrateJobData,
  QUEUE_BATCHES,
  QUEUE_ORCHESTRATE,
  QUEUE_WATCHDOG,
} from './queues';

// A queue job in one of these states will never run (again) on its own.
const DEAD_STATES = new Set(['unknown', 'completed', 'failed']);

/**
 * Repeatable sweep (every WATCHDOG_EVERY_MS, one run at a time cluster-wide via BullMQ).
 * Postgres is the source of truth; this reconciles Redis with it so no work is ever lost:
 *
 *  1. expired leases → back to pending (their worker died mid-batch)
 *  2. pending batches whose BullMQ job is gone/failed → re-enqueued under a fresh job id
 *  3. scheduled/queued jobs past due, or running jobs whose scan stalled, whose orchestrate
 *     job is gone/failed → re-enqueued
 *  4. running jobs with nothing outstanding → finalised
 *
 * Duplicated deliveries are harmless: the batch claim is atomic and fenced.
 */
@Processor(QUEUE_WATCHDOG, { concurrency: 1 })
export class WatchdogProcessor extends WorkerHost {
  private readonly log = new Logger(WatchdogProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly finalizer: JobFinalizer,
    @InjectQueue(QUEUE_BATCHES) private readonly batchQueue: Queue<BatchJobData>,
    @InjectQueue(QUEUE_ORCHESTRATE) private readonly orchestrateQueue: Queue<OrchestrateJobData>,
  ) {
    super();
  }

  async process(): Promise<void> {
    await this.expireLeases();
    await this.requeueOrphanBatches();
    await this.requeueStalledOrchestrations();
    await this.finaliseDrainedJobs();
  }

  private async expireLeases(): Promise<void> {
    const ttl = config.leaseTtlSeconds();
    const n = await this.prisma.$executeRaw`
      UPDATE job_batches
      SET status = 'pending', lease_owner = NULL
      WHERE status = 'leased'
        AND leased_at < timezone('utc', now()) - make_interval(secs => ${ttl}::int)
    `;
    if (n > 0) this.log.warn(`Expired ${n} stale batch lease(s)`);
  }

  private async requeueOrphanBatches(): Promise<void> {
    // Rotate through pending batches (least recently checked first) so a large backlog of
    // legitimately rate-limited batches cannot starve the check of the others.
    const rows = await this.prisma.$queryRaw<
      { id: bigint; job_id: string; batch_no: number; tenant_id: string; n: number; queue_job_id: string | null }[]
    >`
      SELECT jb.id, jb.job_id, jb.batch_no, j.tenant_id, cardinality(jb.entity_ids) AS n, jb.queue_job_id
      FROM job_batches jb
      JOIN bulk_jobs j ON j.id = jb.job_id
      WHERE jb.status = 'pending'
        AND j.status = 'running'
        AND jb.created_at < timezone('utc', now()) - interval '30 seconds'
      ORDER BY jb.checked_at NULLS FIRST, jb.id
      LIMIT 200
    `;
    if (!rows.length) return;

    const now = new Date();
    let requeued = 0;
    for (const row of rows) {
      const state = row.queue_job_id ? await this.batchQueue.getJobState(row.queue_job_id) : 'unknown';
      let queueJobId = row.queue_job_id;
      if (DEAD_STATES.has(state)) {
        queueJobId = `b-${row.job_id}-${row.batch_no}-w${now.getTime()}`;
        await this.batchQueue.add(
          'process-batch',
          { jobId: row.job_id, batchId: row.id.toString(), tenantId: row.tenant_id, entityCount: Number(row.n) },
          { ...BATCH_JOB_OPTS, jobId: queueJobId },
        );
        requeued += 1;
      }
      await this.prisma.jobBatch.update({ where: { id: row.id }, data: { checkedAt: now, queueJobId } });
    }
    if (requeued) this.log.warn(`Re-enqueued ${requeued} orphaned batch(es)`);
  }

  private async requeueStalledOrchestrations(): Promise<void> {
    const cutoff = new Date(Date.now() - 60_000);
    const jobs = await this.prisma.bulkJob.findMany({
      where: {
        cancelRequestedAt: null,
        OR: [
          { status: { in: ['scheduled', 'queued'] }, OR: [{ scheduledAt: null }, { scheduledAt: { lt: cutoff } }], createdAt: { lt: cutoff } },
          { status: 'running', scanComplete: false, updatedAt: { lt: cutoff } },
        ],
      },
      select: { id: true, orchestrateJobId: true },
      take: 100,
    });
    for (const job of jobs) {
      const state = job.orchestrateJobId ? await this.orchestrateQueue.getJobState(job.orchestrateJobId) : 'unknown';
      if (!DEAD_STATES.has(state)) continue;
      const queueJobId = `orch-${job.id}-w${Date.now()}`;
      await this.orchestrateQueue.add('orchestrate', { jobId: job.id }, { ...ORCHESTRATE_JOB_OPTS, jobId: queueJobId });
      await this.prisma.bulkJob.update({ where: { id: job.id }, data: { orchestrateJobId: queueJobId } });
      this.log.warn(`Re-enqueued orchestration for job ${job.id} (previous queue state: ${state})`);
    }
  }

  private async finaliseDrainedJobs(): Promise<void> {
    const jobs = await this.prisma.bulkJob.findMany({
      where: {
        status: 'running',
        OR: [{ scanComplete: true }, { cancelRequestedAt: { not: null } }],
        batches: { none: { status: { in: ['pending', 'leased'] } } },
      },
      select: { id: true },
      take: 100,
    });
    for (const job of jobs) {
      await this.finalizer.tryFinish(job.id);
    }
  }
}
