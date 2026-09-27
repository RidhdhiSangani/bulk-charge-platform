import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Moves a job to its terminal state once no batch is outstanding.
 * Safe to call from anywhere, any number of times, concurrently: every transition is a
 * conditional UPDATE, so only the first caller wins and terminal states are never overwritten.
 */
@Injectable()
export class JobFinalizer {
  constructor(private readonly prisma: PrismaService) {}

  async tryFinish(jobId: string): Promise<void> {
    const outstanding = await this.prisma.jobBatch.count({
      where: { jobId, status: { in: ['pending', 'leased'] } },
    });
    if (outstanding > 0) {
      return;
    }
    const job = await this.prisma.bulkJob.findUnique({
      where: { id: jobId },
      select: { status: true, cancelRequestedAt: true, scanComplete: true },
    });
    if (!job) {
      return;
    }
    if (job.cancelRequestedAt) {
      await this.prisma.bulkJob.updateMany({
        where: { id: jobId, status: { in: ['scheduled', 'queued', 'running'] } },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      return;
    }
    if (job.scanComplete) {
      await this.prisma.bulkJob.updateMany({
        where: { id: jobId, status: 'running' },
        data: { status: 'completed', completedAt: new Date() },
      });
    }
  }
}
