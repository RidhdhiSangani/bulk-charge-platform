import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { config } from '../config';
import { AdapterRegistry } from './adapter-registry';
import { JobFinalizer } from './job-finalizer.service';
import {
  BATCH_JOB_OPTS,
  BatchJobData,
  batchQueueJobId,
  OrchestrateJobData,
  QUEUE_BATCHES,
  QUEUE_ORCHESTRATE,
} from './queues';
import { JsonMap, TERMINAL_JOB_STATUSES } from './types';

/**
 * Turns one bulk job into bounded batches without ever holding the matched set in memory:
 * COUNT once, then keyset-scan ids page by page, writing one job_batches row + one BullMQ
 * job per page. Progress (cursor_after_id, next_batch_no) is persisted after every page so
 * a crashed orchestrator resumes where it stopped instead of rescanning or duplicating.
 */
@Processor(QUEUE_ORCHESTRATE, { concurrency: 2 })
export class OrchestratorProcessor extends WorkerHost {
  private readonly log = new Logger(OrchestratorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdapterRegistry,
    private readonly finalizer: JobFinalizer,
    @InjectQueue(QUEUE_BATCHES) private readonly batchQueue: Queue<BatchJobData>,
  ) {
    super();
  }

  async process(job: Job<OrchestrateJobData>): Promise<void> {
    try {
      await this.run(job.data.jobId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      this.log.error(`Orchestration of ${job.data.jobId} failed (attempt ${job.attemptsMade + 1}): ${message}`);
      if (finalAttempt) {
        // Engine-level failure (cannot count/scan). Per-entity errors never get here.
        await this.prisma.bulkJob.updateMany({
          where: { id: job.data.jobId, status: { in: ['scheduled', 'queued', 'running'] } },
          data: { status: 'failed', errorMessage: message.slice(0, 1000), completedAt: new Date() },
        });
        await this.prisma.jobBatch.updateMany({
          where: { jobId: job.data.jobId, status: 'pending' },
          data: { status: 'cancelled', completedAt: new Date() },
        });
      }
      throw err;
    }
  }

  private async run(jobId: string): Promise<void> {
    const bulk = await this.prisma.bulkJob.findUnique({ where: { id: jobId } });
    if (!bulk || (TERMINAL_JOB_STATUSES as string[]).includes(bulk.status)) {
      return;
    }
    if (bulk.cancelRequestedAt) {
      await this.finalizer.tryFinish(jobId);
      return;
    }

    if (bulk.status === 'scheduled' || bulk.status === 'queued') {
      // Conditional so a concurrent cancel always wins.
      const started = await this.prisma.bulkJob.updateMany({
        where: { id: jobId, status: { in: ['scheduled', 'queued'] }, cancelRequestedAt: null },
        data: { status: 'running', startedAt: new Date() },
      });
      if (started.count === 0) {
        return;
      }
    }

    const adapter = this.adapters.get(bulk.entityType);
    const filter = (bulk.filter ?? {}) as JsonMap;
    const batchSize = config.batchSize();

    if (bulk.totalMatched == null) {
      const total = await adapter.count(bulk.tenantId, filter);
      await this.prisma.bulkJob.update({ where: { id: jobId }, data: { totalMatched: total } });
    }

    let afterId = bulk.cursorAfterId ?? 0n;
    let batchNo = bulk.nextBatchNo;
    let pages = 0;

    while (!bulk.scanComplete) {
      const live = await this.prisma.bulkJob.findUnique({
        where: { id: jobId },
        select: { cancelRequestedAt: true, status: true },
      });
      if (!live || live.cancelRequestedAt || live.status !== 'running') {
        await this.finalizer.tryFinish(jobId);
        return;
      }

      const ids = await adapter.scanPage(bulk.tenantId, filter, afterId, batchSize);
      if (ids.length === 0) {
        break;
      }

      // Idempotent on (job_id, batch_no): after a crash we get the row written last time,
      // including its original ids, and continue from its cursor.
      const queueJobId = batchQueueJobId(jobId, batchNo);
      const batch = await this.prisma.jobBatch.upsert({
        where: { jobId_batchNo: { jobId, batchNo } },
        create: {
          jobId,
          batchNo,
          cursorFromId: ids[0],
          cursorToId: ids[ids.length - 1],
          entityIds: ids,
          status: 'pending',
          queueJobId,
        },
        update: {},
      });

      // Enqueue before advancing the cursor: if we crash in between, the resume re-enqueues
      // the same deterministic job id (a no-op if it is still queued).
      await this.batchQueue.add(
        'process-batch',
        {
          jobId,
          batchId: batch.id.toString(),
          tenantId: bulk.tenantId,
          entityCount: batch.entityIds.length,
        },
        { ...BATCH_JOB_OPTS, jobId: batch.queueJobId ?? queueJobId },
      );

      afterId = batch.cursorToId;
      batchNo += 1;
      pages += 1;
      await this.prisma.bulkJob.update({
        where: { id: jobId },
        data: { cursorAfterId: afterId, nextBatchNo: batchNo },
      });

      if (ids.length < batchSize) {
        break;
      }
    }

    // Reconcile total with what was actually batched (rows may change between COUNT and scan),
    // so processed always converges to total.
    await this.prisma.$executeRaw`
      UPDATE bulk_jobs
      SET scan_complete = true,
          total_matched = (SELECT COALESCE(SUM(cardinality(entity_ids)), 0)::int FROM job_batches WHERE job_id = ${jobId}::uuid),
          updated_at = timezone('utc', now())
      WHERE id = ${jobId}::uuid
    `;
    await this.finalizer.tryFinish(jobId);
    this.log.log(`Job ${jobId}: scan complete, ${pages} batch(es) enqueued in this run`);
  }
}
