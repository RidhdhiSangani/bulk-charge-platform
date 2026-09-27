import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { BulkJob, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { exhaustMap, from, map, Observable, takeWhile, timer } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { ActionRegistry } from '../bulk-engine/action-registry';
import { AdapterRegistry } from '../bulk-engine/adapter-registry';
import { CancelService } from '../bulk-engine/cancel.service';
import { ProgressService } from '../bulk-engine/progress.service';
import { TenantRateLimiter } from '../bulk-engine/tenant-rate-limiter.service';
import {
  ORCHESTRATE_JOB_OPTS,
  OrchestrateJobData,
  orchestrateQueueJobId,
  QUEUE_ORCHESTRATE,
} from '../bulk-engine/queues';
import { TERMINAL_JOB_STATUSES } from '../bulk-engine/types';
import { config } from '../config';
import { CreateBulkJobDto, EntriesQuery, ListJobsQuery } from './dto';

export type JobEvent = { type: 'progress' | 'done'; id: string; data: Record<string, unknown> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable JSON (sorted keys) so the same logical request always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

@Injectable()
export class BulkJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: ActionRegistry,
    private readonly adapters: AdapterRegistry,
    private readonly progress: ProgressService,
    private readonly cancelService: CancelService,
    private readonly limiter: TenantRateLimiter,
    @InjectQueue(QUEUE_ORCHESTRATE) private readonly orchestrateQueue: Queue<OrchestrateJobData>,
  ) {}

  /** Returns the job and whether it was newly created (false = idempotent replay). */
  async create(dto: CreateBulkJobDto, idempotencyKey?: string): Promise<{ job: BulkJob; created: boolean }> {
    const key = idempotencyKey?.trim() || null;
    if (key && key.length > 255) {
      throw new BadRequestException('Idempotency-Key must be at most 255 characters');
    }
    const requestHash = createHash('sha256')
      .update(
        canonical({
          tenant_id: dto.tenant_id,
          action_type: dto.action_type,
          entity_type: dto.entity_type,
          filter: dto.filter,
          params: dto.params,
          scheduled_at: dto.scheduled_at ?? null,
        }),
      )
      .digest('hex');

    if (key) {
      const existing = await this.prisma.bulkJob.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: dto.tenant_id, idempotencyKey: key } },
      });
      if (existing) {
        return { job: this.assertSameRequest(existing, requestHash), created: false };
      }
    }

    this.validate(dto);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: dto.tenant_id }, select: { id: true } });
    if (!tenant) {
      throw new BadRequestException(`Unknown tenant_id: ${dto.tenant_id}`);
    }

    const scheduledAt = dto.scheduled_at ? new Date(dto.scheduled_at) : null;
    const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : 0;

    let job: BulkJob;
    try {
      job = await this.prisma.bulkJob.create({
        data: {
          tenantId: dto.tenant_id,
          actionType: dto.action_type,
          entityType: dto.entity_type,
          filter: dto.filter as Prisma.InputJsonValue,
          params: dto.params as Prisma.InputJsonValue,
          status: delay > 0 ? 'scheduled' : 'queued',
          scheduledAt,
          idempotencyKey: key,
          requestHash,
        },
      });
    } catch (err) {
      // Two concurrent requests with the same key: the unique index lets exactly one win.
      if (key && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.bulkJob.findUniqueOrThrow({
          where: { tenantId_idempotencyKey: { tenantId: dto.tenant_id, idempotencyKey: key } },
        });
        return { job: this.assertSameRequest(winner, requestHash), created: false };
      }
      throw err;
    }

    // If Redis is briefly unavailable the row stays scheduled/queued and the watchdog
    // re-enqueues it; the API response is still correct.
    const queueJobId = orchestrateQueueJobId(job.id);
    job = await this.prisma.bulkJob.update({ where: { id: job.id }, data: { orchestrateJobId: queueJobId } });
    await this.orchestrateQueue.add('orchestrate', { jobId: job.id }, { ...ORCHESTRATE_JOB_OPTS, jobId: queueJobId, delay });

    return { job, created: true };
  }

  async list(q: ListJobsQuery) {
    const limit = q.limit ?? 20;
    if (q.cursor && !UUID_RE.test(q.cursor)) {
      throw new BadRequestException('cursor must be a job id');
    }
    const rows = await this.prisma.bulkJob.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.tenant_id ? { tenantId: q.tenant_id } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map((j) => this.present(j)),
      next_cursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async detail(jobId: string, tenantId?: string) {
    const job = await this.find(jobId, tenantId);
    const batchGroups = await this.prisma.jobBatch.groupBy({
      by: ['status'],
      where: { jobId },
      _count: { _all: true },
    });
    const batches = { total: 0, pending: 0, leased: 0, done: 0, cancelled: 0 };
    for (const g of batchGroups) {
      batches[g.status as keyof typeof batches] = g._count._all;
      batches.total += g._count._all;
    }
    const tenantRate = await this.limiter.usage(job.tenantId).catch(() => null);
    return { ...this.present(job), batches, tenant_rate: tenantRate };
  }

  async summary(jobId: string, tenantId?: string) {
    const job = await this.find(jobId, tenantId);
    const p = this.progress.snapshot(job);
    const reasons = await this.prisma.jobEntry.groupBy({
      by: ['outcome', 'reason'],
      where: { jobId, outcome: { in: ['failed', 'skipped'] } },
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
      take: 50,
    });
    return {
      job_id: job.id,
      status: job.status,
      total_matched: job.totalMatched,
      processed: p.processed,
      success: job.successCount,
      failed: job.failedCount,
      skipped: job.skippedCount,
      pending: p.remaining,
      reasons: reasons.map((r) => ({ outcome: r.outcome, reason: r.reason, count: r._count._all })),
    };
  }

  async entries(jobId: string, q: EntriesQuery) {
    await this.find(jobId, q.tenant_id);
    const limit = q.limit ?? 50;
    const rows = await this.prisma.jobEntry.findMany({
      where: {
        jobId,
        ...(q.outcome ? { outcome: q.outcome } : {}),
        ...(q.cursor ? { id: { gt: BigInt(q.cursor) } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      job_id: jobId,
      outcome: q.outcome ?? null,
      data: page.map((e) => ({
        id: e.id,
        entity_type: e.entityType,
        entity_id: e.entityId,
        entity_ref: e.entityRef,
        outcome: e.outcome,
        reason: e.reason,
        batch_id: e.batchId,
        processed_at: e.processedAt,
      })),
      next_cursor: rows.length > limit ? page[page.length - 1].id.toString() : null,
    };
  }

  /**
   * Live progress as Server-Sent Events: one `progress` event per interval (which doubles as a
   * keep-alive for proxies), then a final `done` event when the job reaches a terminal state, after
   * which the stream closes. The job is looked up first, so an unknown id is a normal 404.
   * Reads go through detail() — the same data as GET /:id. At larger scale the workers would
   * publish progress over Redis pub/sub instead of each open stream polling Postgres.
   */
  async events(jobId: string, tenantId?: string, intervalMs = config.sseIntervalMs()): Promise<Observable<JobEvent>> {
    await this.find(jobId, tenantId);
    let seq = 0;
    return timer(0, intervalMs).pipe(
      // exhaustMap: never stack queries if one is slower than the interval
      exhaustMap(() => from(this.detail(jobId, tenantId))),
      takeWhile((d) => !(TERMINAL_JOB_STATUSES as string[]).includes(d.status), true),
      map((d) => ({
        type: (TERMINAL_JOB_STATUSES as string[]).includes(d.status) ? ('done' as const) : ('progress' as const),
        id: String(++seq),
        data: {
          id: d.id,
          status: d.status,
          total_matched: d.total_matched,
          progress: d.progress,
          batches: d.batches,
          tenant_rate: d.tenant_rate,
          error_message: d.error_message,
        },
      })),
    );
  }

  async cancel(jobId: string, tenantId?: string) {
    await this.find(jobId, tenantId);
    const outcome = await this.cancelService.cancel(jobId);
    const job = await this.find(jobId);
    if (outcome === 'already_terminal') {
      throw new ConflictException({ message: `Job is already ${job.status} and cannot be cancelled`, job: this.present(job) });
    }
    return { cancel: outcome, job: this.present(job) };
  }

  present(job: BulkJob) {
    return {
      id: job.id,
      tenant_id: job.tenantId,
      action_type: job.actionType,
      entity_type: job.entityType,
      filter: job.filter,
      params: job.params,
      status: job.status,
      idempotency_key: job.idempotencyKey,
      scheduled_at: job.scheduledAt,
      started_at: job.startedAt,
      completed_at: job.completedAt,
      cancel_requested_at: job.cancelRequestedAt,
      created_at: job.createdAt,
      error_message: job.errorMessage,
      total_matched: job.totalMatched,
      progress: this.progress.snapshot(job),
    };
  }

  private async find(jobId: string, tenantId?: string): Promise<BulkJob> {
    if (!UUID_RE.test(jobId)) {
      throw new NotFoundException(`Bulk job ${jobId} not found`);
    }
    const job = await this.prisma.bulkJob.findUnique({ where: { id: jobId } });
    // A tenant-scoped caller must not learn that another tenant's job exists.
    if (!job || (tenantId && job.tenantId !== tenantId)) {
      throw new NotFoundException(`Bulk job ${jobId} not found`);
    }
    return job;
  }

  private validate(dto: CreateBulkJobDto): void {
    const adapter = this.adapters.find(dto.entity_type);
    const action = this.actions.find(dto.entity_type, dto.action_type);
    if (!adapter || !action) {
      const supported = this.actions.list().map((a) => `${a.entity_type}:${a.action_type}`);
      throw new BadRequestException({
        message: `Unsupported entity_type/action_type ${dto.entity_type}:${dto.action_type}`,
        supported,
      });
    }
    const errors = [...adapter.validateFilter(dto.filter), ...action.validateParams(dto.params)];
    if (errors.length) {
      throw new BadRequestException({ message: 'Invalid bulk job', errors });
    }
  }

  private assertSameRequest(job: BulkJob, requestHash: string): BulkJob {
    if (job.requestHash && job.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'Idempotency-Key was already used with a different request body; use a new key for a new job',
      );
    }
    return job;
  }
}
