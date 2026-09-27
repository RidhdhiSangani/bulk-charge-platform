import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { JobFinalizer } from './job-finalizer.service';
import { OrchestrateJobData, QUEUE_ORCHESTRATE } from './queues';
import { TERMINAL_JOB_STATUSES } from './types';

export type CancelOutcome = 'cancelled' | 'cancelling' | 'already_terminal' | 'not_found';

@Injectable()
export class CancelService {
  private readonly log = new Logger(CancelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly finalizer: JobFinalizer,
    @InjectQueue(QUEUE_ORCHESTRATE) private readonly orchestrateQueue: Queue<OrchestrateJobData>,
  ) {}

  /**
   * scheduled/queued → cancelled immediately and the delayed orchestrate job is removed.
   * running → cancel_requested_at is set, pending batches are closed right away, and the
   * (at most CONCURRENCY) in-flight batches stop at their next cancel check. Entities already
   * processed stay processed. The job flips to `cancelled` when the last in-flight batch ends.
   */
  async cancel(jobId: string): Promise<CancelOutcome> {
    const job = await this.prisma.bulkJob.findUnique({ where: { id: jobId } });
    if (!job) {
      return 'not_found';
    }
    if ((TERMINAL_JOB_STATUSES as string[]).includes(job.status)) {
      return 'already_terminal';
    }

    const now = new Date();
    const notStarted = await this.prisma.bulkJob.updateMany({
      where: { id: jobId, status: { in: ['scheduled', 'queued'] } },
      data: { status: 'cancelled', cancelRequestedAt: now, completedAt: now },
    });
    if (notStarted.count === 1) {
      await this.removeOrchestrateJob(job.orchestrateJobId);
      return 'cancelled';
    }

    // Running (or it just started between our read and update).
    await this.prisma.$transaction([
      this.prisma.bulkJob.updateMany({
        where: { id: jobId, cancelRequestedAt: null },
        data: { cancelRequestedAt: now },
      }),
      this.prisma.jobBatch.updateMany({
        where: { jobId, status: 'pending' },
        data: { status: 'cancelled', completedAt: now },
      }),
    ]);
    await this.finalizer.tryFinish(jobId);
    const after = await this.prisma.bulkJob.findUnique({ where: { id: jobId }, select: { status: true } });
    return after?.status === 'cancelled' ? 'cancelled' : 'cancelling';
  }

  private async removeOrchestrateJob(queueJobId: string | null): Promise<void> {
    if (!queueJobId) return;
    try {
      await this.orchestrateQueue.remove(queueJobId);
    } catch (err) {
      // Active/locked jobs cannot be removed; the orchestrator re-checks status and exits.
      this.log.debug(`Could not remove orchestrate job ${queueJobId}: ${(err as Error).message}`);
    }
  }
}
