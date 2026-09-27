import { Injectable } from '@nestjs/common';
import { BulkJob } from '@prisma/client';

@Injectable()
export class ProgressService {
  /**
   * Linear estimate: observed throughput since started_at, extrapolated over what is left.
   * Includes time spent waiting on the tenant rate limit, so it reflects real completion time.
   */
  snapshot(job: BulkJob, now = Date.now()) {
    const processed = job.successCount + job.failedCount + job.skippedCount;
    const total = job.totalMatched;
    const end = job.completedAt ? job.completedAt.getTime() : now;
    const elapsedMs = job.startedAt ? Math.max(end - job.startedAt.getTime(), 1) : null;
    const perMin = elapsedMs && processed > 0 ? Math.round((processed / elapsedMs) * 60_000) : null;

    let eta: string | null = null;
    if (job.status === 'running' && elapsedMs && processed > 0 && total != null && processed < total) {
      const remainingMs = ((total - processed) / processed) * elapsedMs;
      eta = new Date(now + remainingMs).toISOString();
    }

    return {
      processed,
      total,
      remaining: total == null ? null : Math.max(total - processed, 0),
      percent: total ? Math.min(100, Math.round((processed / total) * 10000) / 100) : total === 0 ? 100 : 0,
      success: job.successCount,
      failed: job.failedCount,
      skipped: job.skippedCount,
      throughput_per_min: perMin,
      elapsed_ms: elapsedMs,
      estimated_completion_at: eta,
    };
  }
}
