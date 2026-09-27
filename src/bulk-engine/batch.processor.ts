import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { config } from '../config';
import { AdapterRegistry } from './adapter-registry';
import { ActionRegistry } from './action-registry';
import { JobFinalizer } from './job-finalizer.service';
import { TenantRateLimiter } from './tenant-rate-limiter.service';
import { BatchJobData, QUEUE_BATCHES } from './queues';
import { EntityOutcome, JsonMap, TERMINAL_JOB_STATUSES } from './types';

type ClaimedBatch = { id: bigint; entity_ids: bigint[] };

class LeaseLostError extends Error {
  constructor(batchId: bigint) {
    super(`Lease on batch ${batchId} was lost before commit; rolled back`);
  }
}

/**
 * Processes one batch (≤ BATCH_SIZE entities) exactly once:
 *
 *  1. cheap pre-checks (batch already closed? job cancelled?)
 *  2. tenant rate limit — if over the ceiling, the BullMQ job is re-delayed, never dropped
 *  3. claim a lease with a single conditional UPDATE (pending, or leased-but-expired)
 *  4. ONE transaction for the batch; each entity inside its own SAVEPOINT so a failing entity
 *     never rolls back its neighbours. Entity rows are locked FOR UPDATE (ordered by id).
 *  5. commit entries + side effects + counters + batch=done atomically, fenced by the lease
 *     token: if another worker stole an expired lease meanwhile, this commit is rolled back.
 *
 * Crash anywhere before commit → nothing of this batch is persisted except the lease, which
 * expires and is re-claimed. Crash after commit → batch is `done` and every redelivery acks.
 * job_entries UNIQUE(job_id, entity_id) + action-level unique keys are the final backstop.
 */
@Processor(QUEUE_BATCHES, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) })
export class BatchProcessor extends WorkerHost {
  private readonly log = new Logger(BatchProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdapterRegistry,
    private readonly actions: ActionRegistry,
    private readonly limiter: TenantRateLimiter,
    private readonly finalizer: JobFinalizer,
  ) {
    super();
  }

  async process(job: Job<BatchJobData>, token?: string): Promise<void> {
    const batchId = BigInt(job.data.batchId);
    const { jobId, tenantId, entityCount } = job.data;

    const batchRow = await this.prisma.jobBatch.findUnique({ where: { id: batchId }, select: { status: true } });
    if (!batchRow || batchRow.status === 'done' || batchRow.status === 'cancelled') {
      return;
    }
    const bulk = await this.prisma.bulkJob.findUnique({ where: { id: jobId } });
    if (!bulk) {
      return;
    }
    if (bulk.cancelRequestedAt || (TERMINAL_JOB_STATUSES as string[]).includes(bulk.status)) {
      // Close the batch unless a live worker holds it (that worker stops at its next cancel check).
      const leaseExpiredBefore = new Date(Date.now() - config.leaseTtlSeconds() * 1000);
      await this.prisma.jobBatch.updateMany({
        where: {
          id: batchId,
          OR: [{ status: 'pending' }, { status: 'leased', leasedAt: { lt: leaseExpiredBefore } }],
        },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      await this.finalizer.tryFinish(jobId);
      return;
    }

    const grant = await this.limiter.acquire(tenantId, entityCount);
    if (!grant.granted) {
      // Over the tenant ceiling: push the whole batch into the future. Jitter spreads
      // competing batches so they do not all wake up on the same millisecond.
      const delay = grant.retryAfterMs + Math.floor(Math.random() * 500);
      await job.moveToDelayed(Date.now() + delay, token);
      throw new DelayedError();
    }

    const leaseToken = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    const claimed = await this.claim(batchId, leaseToken);
    if (!claimed) {
      await this.limiter.release(tenantId, grant.member);
      const current = await this.prisma.jobBatch.findUnique({ where: { id: batchId }, select: { status: true } });
      if (!current || current.status === 'done' || current.status === 'cancelled') {
        return;
      }
      // Another worker holds a live lease. Do not ack: if that worker dies, this same BullMQ
      // job will steal the lease once it expires.
      await job.moveToDelayed(Date.now() + 5_000, token);
      throw new DelayedError();
    }

    const counts = await this.processClaimed(bulk.id, bulk.tenantId, bulk.entityType, bulk.actionType,
      (bulk.filter ?? {}) as JsonMap, bulk.params, batchId, claimed.entity_ids, leaseToken);

    this.log.debug(
      `Batch ${batchId} of job ${jobId}: ${counts.success} ok / ${counts.failed} failed / ${counts.skipped} skipped`,
    );
    await this.finalizer.tryFinish(jobId);
  }

  private async processClaimed(
    jobId: string,
    tenantId: string,
    entityType: string,
    actionType: string,
    filter: JsonMap,
    params: unknown,
    batchId: bigint,
    ids: bigint[],
    leaseToken: string,
  ): Promise<Record<EntityOutcome, number>> {
    const adapter = this.adapters.get(entityType);
    const action = this.actions.get(entityType, actionType);
    const cancelCheckEvery = Math.max(1, config.cancelCheckEvery());
    // Demo/testing only: slows each entity so a crash or cancel can be landed mid-batch.
    const debugDelayMs = config.debugEntityDelayMs();
    const counts: Record<EntityOutcome, number> = { success: 0, failed: 0, skipped: 0 };

    await this.prisma.$transaction(
      async (tx) => {
        // Resume safety: entities already logged for this job (by an earlier attempt that
        // committed) are never touched again.
        const already = await tx.jobEntry.findMany({
          where: { jobId, entityId: { in: ids } },
          select: { entityId: true },
        });
        const done = new Set(already.map((e) => e.entityId.toString()));
        const todo = ids.filter((id) => !done.has(id.toString()));

        const entities = await adapter.lockByIds(tx, todo);
        const byId = new Map(entities.map((e) => [adapter.entityId(e).toString(), e]));
        const entries: {
          jobId: string;
          batchId: bigint;
          entityType: string;
          entityId: bigint;
          entityRef: string;
          outcome: EntityOutcome;
          reason: string | null;
        }[] = [];
        let cancelled = false;

        for (let i = 0; i < todo.length; i++) {
          if (i > 0 && i % cancelCheckEvery === 0) {
            const live = await tx.bulkJob.findUnique({ where: { id: jobId }, select: { cancelRequestedAt: true } });
            if (live?.cancelRequestedAt) {
              cancelled = true;
              break;
            }
          }

          if (debugDelayMs > 0) {
            await new Promise((r) => setTimeout(r, debugDelayMs));
          }

          const entityId = todo[i];
          const entity = byId.get(entityId.toString());
          let outcome: EntityOutcome;
          let reason: string | undefined;
          let entityRef = `id:${entityId.toString()}`;

          if (!entity) {
            outcome = 'skipped';
            reason = 'entity_not_found';
          } else {
            entityRef = adapter.entityRef(entity);
            if (!adapter.matchesFilter(entity, tenantId, filter)) {
              outcome = 'skipped';
              reason = 'no_longer_matches_filter';
            } else {
              await tx.$executeRawUnsafe('SAVEPOINT bulk_entity');
              try {
                const result = await action.execute(entity, params, { jobId, tenantId, batchId, tx });
                await tx.$executeRawUnsafe('RELEASE SAVEPOINT bulk_entity');
                outcome = result.outcome;
                reason = result.reason;
              } catch (err) {
                // Undo only this entity's partial writes; the batch carries on.
                await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT bulk_entity');
                const message = err instanceof Error ? err.message : String(err);
                outcome = 'failed';
                reason = `unexpected_error:${message}`.slice(0, 500);
                this.log.warn(`Entity ${entityRef} in job ${jobId} threw: ${message}`);
              }
            }
          }

          entries.push({ jobId, batchId, entityType, entityId, entityRef, outcome, reason: reason ?? null });
          counts[outcome] += 1;
        }

        if (entries.length) {
          await tx.jobEntry.createMany({ data: entries });
          // One counter update per batch (not per entity): keeps the bulk_jobs row lock short
          // so batches of the same job run in parallel across workers.
          await tx.bulkJob.update({
            where: { id: jobId },
            data: {
              successCount: { increment: counts.success },
              failedCount: { increment: counts.failed },
              skippedCount: { increment: counts.skipped },
            },
          });
        }

        const fenced = await tx.jobBatch.updateMany({
          where: { id: batchId, status: 'leased', leaseOwner: leaseToken },
          data: { status: cancelled ? 'cancelled' : 'done', leaseOwner: null, completedAt: new Date() },
        });
        if (fenced.count !== 1) {
          throw new LeaseLostError(batchId);
        }
      },
      { timeout: 120_000, maxWait: 15_000 },
    );

    return counts;
  }

  /** Atomic claim: pending, or leased with an expired lease (its worker is presumed dead). */
  private async claim(batchId: bigint, leaseToken: string): Promise<ClaimedBatch | null> {
    const ttl = config.leaseTtlSeconds();
    const rows = await this.prisma.$queryRaw<ClaimedBatch[]>`
      UPDATE job_batches
      SET status = 'leased',
          leased_at = timezone('utc', now()),
          lease_owner = ${leaseToken},
          attempt_count = attempt_count + 1
      WHERE id = ${batchId}
        AND (status = 'pending'
             OR (status = 'leased' AND leased_at < timezone('utc', now()) - make_interval(secs => ${ttl}::int)))
      RETURNING id, entity_ids
    `;
    return rows[0] ?? null;
  }
}
