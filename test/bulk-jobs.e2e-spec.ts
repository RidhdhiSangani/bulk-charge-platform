/**
 * Integration tests: real API + real workers (in-process) against real Postgres + Redis.
 * Prereq: `docker compose up -d postgres redis && npx prisma migrate deploy` (uses .env).
 * Each run creates its own tenant + shipments and deletes them afterwards.
 */
import '../src/load-env';
process.env.BATCH_SIZE = '25';
process.env.TENANT_RATE_LIMIT_PER_MIN = '100000';
process.env.WATCHDOG_EVERY_MS = '600000';
// Own BullMQ namespace: workers of a locally running stack must not pick up this run's jobs.
process.env.QUEUE_PREFIX = `bull-e2e-${Date.now().toString(36)}`;

import { INestApplication, Module } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { BulkEngineWorkersModule } from '../src/bulk-engine/bulk-engine-workers.module';
import { BATCH_JOB_OPTS, QUEUE_BATCHES } from '../src/bulk-engine/queues';
import { TenantRateLimiter } from '../src/bulk-engine/tenant-rate-limiter.service';
import { configureApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

@Module({ imports: [AppModule, BulkEngineWorkersModule] })
class TestModule {}

const TENANT = `tnt_e2e_${Date.now().toString(36)}`;
const PORT = 'E2EPT';

describe('Bulk jobs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  const post = (body: object, key?: string) => {
    const r = http.post('/v1/bulk-jobs').send(body);
    return key ? r.set('Idempotency-Key', key) : r;
  };
  const chargeJob = (code: string, extra: object = {}) => ({
    tenant_id: TENANT,
    action_type: 'apply_charge',
    entity_type: 'shipment',
    filter: { origin_port: PORT, status: 'in_transit' },
    params: { charge_code: code, basis: 'per_kg', rate: 0.1, currency: 'USD' },
    ...extra,
  });

  async function waitTerminal(jobId: string, timeoutMs = 45_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const res = await http.get(`/v1/bulk-jobs/${jobId}`);
      if (['completed', 'cancelled', 'failed'].includes(res.body.status)) return res.body;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`job ${jobId} did not finish`);
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer()) as unknown as ReturnType<typeof request>;
    prisma = app.get(PrismaService);

    await prisma.tenant.create({ data: { id: TENANT, name: 'e2e' } });
    const base = {
      tenantId: TENANT,
      tradeType: 'export',
      originPort: PORT,
      destinationPort: 'NLRTM',
      containerCount: 2,
      customerId: 'CUST-E2E',
    };
    const rows: Prisma.ShipmentCreateManyInput[] = [];
    for (let i = 0; i < 120; i++) {
      const kind = i < 90 ? 'ok' : i < 100 ? 'noweight' : i < 110 ? 'billed' : 'aed';
      rows.push({
        ...base,
        shipmentNo: `${TENANT}-${i}`,
        status: 'in_transit',
        chargeableWeight: kind === 'noweight' ? null : new Prisma.Decimal(1000),
        billingCurrency: kind === 'aed' ? 'AED' : 'USD',
        isBilled: kind === 'billed',
      });
    }
    for (let i = 0; i < 20; i++) {
      rows.push({ ...base, shipmentNo: `${TENANT}-b${i}`, status: 'booked', chargeableWeight: null, billingCurrency: 'USD' });
    }
    await prisma.shipment.createMany({ data: rows });
    await prisma.fxRate.upsert({
      where: { baseCurrency_quoteCurrency: { baseCurrency: 'USD', quoteCurrency: 'INR' } },
      create: { baseCurrency: 'USD', quoteCurrency: 'INR', rate: new Prisma.Decimal('83.25') },
      update: {},
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const jobs = await prisma.bulkJob.findMany({ where: { tenantId: TENANT }, select: { id: true } });
    const jobIds = jobs.map((j) => j.id);
    await prisma.jobEntry.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.jobBatch.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.bulkJob.deleteMany({ where: { tenantId: TENANT } });
    await prisma.shipmentCharge.deleteMany({ where: { shipment: { tenantId: TENANT } } });
    await prisma.shipment.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } });
    await app.close();
  });

  describe('validation', () => {
    it('rejects an unknown filter key instead of matching everything', async () => {
      const res = await post({ ...chargeJob('X'), filter: { origin_prot: PORT } }).expect(400);
      expect(JSON.stringify(res.body)).toContain('origin_prot');
    });

    it('rejects an unsupported action and invalid params', async () => {
      await post({ ...chargeJob('X'), action_type: 'nuke' }).expect(400);
      await post({ ...chargeJob('X'), params: { charge_code: 'X', basis: 'per_ton', rate: 1, currency: 'USD' } }).expect(400);
    });

    it('rejects an unknown tenant', async () => {
      await post({ ...chargeJob('X'), tenant_id: 'tnt_nope' }).expect(400);
    });
  });

  describe('request-level idempotency', () => {
    it('returns the original job for a retried Idempotency-Key', async () => {
      const key = `${TENANT}-idem`;
      const first = await post(chargeJob('IDEM', { scheduled_at: '2099-01-01T00:00:00Z' }), key).expect(201);
      const again = await post(chargeJob('IDEM', { scheduled_at: '2099-01-01T00:00:00Z' }), key).expect(200);
      expect(again.body.id).toBe(first.body.id);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(await prisma.bulkJob.count({ where: { tenantId: TENANT, idempotencyKey: key } })).toBe(1);
    });

    it('rejects the same key with a different body (422)', async () => {
      const key = `${TENANT}-idem2`;
      await post(chargeJob('IDEM2', { scheduled_at: '2099-01-01T00:00:00Z' }), key).expect(201);
      await post(chargeJob('OTHER', { scheduled_at: '2099-01-01T00:00:00Z' }), key).expect(422);
    });
  });

  describe('apply_charge', () => {
    let firstJobId: string;

    it('prices each shipment independently; failures never abort the job', async () => {
      const created = await post(chargeJob('E2EFSC')).expect(201);
      firstJobId = created.body.id;
      const job = await waitTerminal(firstJobId);
      expect(job.status).toBe('completed');
      expect(job.total_matched).toBe(120);
      expect(job.progress).toMatchObject({ processed: 120, success: 90, failed: 30, skipped: 0, percent: 100 });
      expect(job.batches.total).toBe(5); // 120 / BATCH_SIZE 25

      const summary = await http.get(`/v1/bulk-jobs/${firstJobId}/summary`).expect(200);
      const reasons = Object.fromEntries(summary.body.reasons.map((r: { reason: string; count: number }) => [r.reason, r.count]));
      expect(reasons).toEqual({ missing_weight: 10, already_billed: 10, 'unknown_currency_pair:USD->AED': 10 });

      const charge = await prisma.shipmentCharge.findFirstOrThrow({
        where: { chargeCode: 'E2EFSC', shipment: { tenantId: TENANT } },
      });
      expect(charge.amount.toString()).toBe('100'); // 0.1 USD/kg × 1000 kg
      expect(charge.bulkJobId).toBe(firstJobId);
    });

    it('paginates and filters the per-entity log by outcome', async () => {
      const page1 = await http.get(`/v1/bulk-jobs/${firstJobId}/entries?outcome=failed&limit=20`).expect(200);
      expect(page1.body.data).toHaveLength(20);
      expect(page1.body.data.every((e: { outcome: string; reason: string }) => e.outcome === 'failed' && e.reason)).toBe(true);
      const page2 = await http
        .get(`/v1/bulk-jobs/${firstJobId}/entries?outcome=failed&limit=20&cursor=${page1.body.next_cursor}`)
        .expect(200);
      expect(page2.body.data).toHaveLength(10);
      expect(page2.body.next_cursor).toBeNull();
    });

    it('never applies a charge twice: a second job skips (shipment_id, charge_code) that exist', async () => {
      const created = await post(chargeJob('E2EFSC')).expect(201);
      const job = await waitTerminal(created.body.id);
      expect(job.progress).toMatchObject({ processed: 120, success: 0, skipped: 90, failed: 30 });
      const skipped = await http.get(`/v1/bulk-jobs/${created.body.id}/entries?outcome=skipped&limit=1`).expect(200);
      expect(skipped.body.data[0].reason).toBe('charge_already_applied');
      expect(await prisma.shipmentCharge.count({ where: { chargeCode: 'E2EFSC', shipment: { tenantId: TENANT } } })).toBe(90);
    });

    it('a redelivered batch (crash after lease, expired lease) does not double-process', async () => {
      const batch = await prisma.jobBatch.findFirstOrThrow({ where: { jobId: firstJobId }, orderBy: { batchNo: 'asc' } });
      // Simulate: the job is still running, a worker leased this batch and died, the lease is
      // long expired, and BullMQ redelivers the batch. Its entities were already logged by an
      // earlier committed attempt, so the redelivery must be a no-op for counters and charges.
      await prisma.bulkJob.update({ where: { id: firstJobId }, data: { status: 'running', completedAt: null } });
      await prisma.jobBatch.update({
        where: { id: batch.id },
        data: { status: 'leased', leasedAt: new Date(Date.now() - 3600_000), leaseOwner: 'dead-worker' },
      });
      const queue = app.get<Queue>(getQueueToken(QUEUE_BATCHES));
      await queue.add(
        'process-batch',
        { jobId: firstJobId, batchId: batch.id.toString(), tenantId: TENANT, entityCount: batch.entityIds.length },
        { ...BATCH_JOB_OPTS, jobId: `e2e-redeliver-${batch.id}` },
      );
      const until = Date.now() + 20_000;
      let status = 'leased';
      while (status !== 'done' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 200));
        status = (await prisma.jobBatch.findUniqueOrThrow({ where: { id: batch.id } })).status;
      }
      expect(status).toBe('done');
      const job = await waitTerminal(firstJobId);
      expect(job.status).toBe('completed');
      expect([job.progress.success, job.progress.failed, job.progress.skipped]).toEqual([90, 30, 0]);
      const redelivered = await prisma.jobBatch.findUniqueOrThrow({ where: { id: batch.id } });
      expect(redelivered.attemptCount).toBe(batch.attemptCount + 1);
      expect(await prisma.jobEntry.count({ where: { jobId: firstJobId } })).toBe(120);
      expect(await prisma.shipmentCharge.count({ where: { chargeCode: 'E2EFSC', shipment: { tenantId: TENANT } } })).toBe(90);
    });
  });

  describe('transition_status (second action, same engine)', () => {
    const transition = (target: string) => ({
      tenant_id: TENANT,
      action_type: 'transition_status',
      entity_type: 'shipment',
      filter: { origin_port: PORT, status: 'booked' },
      params: { target_status: target },
    });

    it('records illegal transitions as per-entity failures', async () => {
      const created = await post(transition('delivered')).expect(201);
      const job = await waitTerminal(created.body.id);
      expect(job.status).toBe('completed');
      expect(job.progress).toMatchObject({ processed: 20, failed: 20, success: 0 });
      const e = await http.get(`/v1/bulk-jobs/${created.body.id}/entries?outcome=failed&limit=1`).expect(200);
      expect(e.body.data[0].reason).toBe('illegal_transition:booked->delivered');
    });

    it('applies legal transitions', async () => {
      const created = await post(transition('in_transit')).expect(201);
      const job = await waitTerminal(created.body.id);
      expect(job.progress).toMatchObject({ processed: 20, success: 20 });
      expect(await prisma.shipment.count({ where: { tenantId: TENANT, shipmentNo: { contains: '-b' }, status: 'in_transit' } })).toBe(20);
    });
  });

  describe('scheduling and cancellation', () => {
    it('a scheduled job is visible as scheduled and can be cancelled before it starts', async () => {
      const created = await post(chargeJob('SCHED', { scheduled_at: '2099-11-22T23:15:00+05:30' })).expect(201);
      expect(created.body.status).toBe('scheduled');
      const listed = await http.get(`/v1/bulk-jobs?tenant_id=${TENANT}&status=scheduled`).expect(200);
      expect(listed.body.data.map((j: { id: string }) => j.id)).toContain(created.body.id);

      const cancelled = await http.post(`/v1/bulk-jobs/${created.body.id}/cancel`).expect(202);
      expect(cancelled.body.job.status).toBe('cancelled');
      await http.post(`/v1/bulk-jobs/${created.body.id}/cancel`).expect(409);
      expect(await prisma.jobEntry.count({ where: { jobId: created.body.id } })).toBe(0);
    });

    it('hides other tenants\' jobs when scoped', async () => {
      const created = await post(chargeJob('SCOPE', { scheduled_at: '2099-01-01T00:00:00Z' })).expect(201);
      await http.get(`/v1/bulk-jobs/${created.body.id}`).set('X-Tenant-Id', 'tnt_other').expect(404);
      await http.get(`/v1/bulk-jobs/${created.body.id}`).set('X-Tenant-Id', TENANT).expect(200);
    });
  });

  describe('live progress stream (SSE)', () => {
    it('pushes progress events and closes with a final done event', async () => {
      const created = await post(chargeJob(`SSE${Date.now()}`)).expect(201);
      const res = await http
        .get(`/v1/bulk-jobs/${created.body.id}/events?interval_ms=250`)
        .buffer(true)
        .parse((r, cb) => {
          let body = '';
          r.on('data', (c: Buffer) => (body += c.toString()));
          r.on('end', () => cb(null, body));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      const events = (res.body as string)
        .split('\n\n')
        .filter((b) => b.includes('data:'))
        .map((b) => ({
          type: /event: (\w+)/.exec(b)?.[1],
          data: JSON.parse(/data: (.*)/.exec(b)![1]),
        }));
      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1];
      expect(last.type).toBe('done');
      expect(last.data.status).toBe('completed');
      expect(last.data.progress.processed).toBe(last.data.total_matched);
      expect(last.data.total_matched).toBeGreaterThan(0);
      expect(events.slice(0, -1).every((e) => e.type === 'progress')).toBe(true);
    });

    it('returns 404 (not an open stream) for an unknown job', async () => {
      await http.get('/v1/bulk-jobs/00000000-0000-0000-0000-000000000000/events').expect(404);
    });
  });

  describe('API docs', () => {
    it('serves the OpenAPI document with every bulk-job route', async () => {
      const res = await http.get('/docs-json').expect(200);
      const paths = Object.keys(res.body.paths);
      for (const p of [
        '/v1/bulk-jobs',
        '/v1/bulk-jobs/{jobId}',
        '/v1/bulk-jobs/{jobId}/events',
        '/v1/bulk-jobs/{jobId}/summary',
        '/v1/bulk-jobs/{jobId}/entries',
        '/v1/bulk-jobs/{jobId}/cancel',
      ]) {
        expect(paths).toContain(p);
      }
    });
  });

  describe('tenant rate limiter', () => {
    it('grants within the ceiling, delays above it, and frees capacity on release', async () => {
      const limiter = app.get(TenantRateLimiter);
      const tenant = `${TENANT}-rl`;
      const a = await limiter.acquire(tenant, 60, 100);
      expect(a.granted).toBe(true);
      const b = await limiter.acquire(tenant, 60, 100);
      expect(b.granted).toBe(false);
      if (!b.granted) expect(b.retryAfterMs).toBeGreaterThan(55_000);
      if (a.granted) await limiter.release(tenant, a.member);
      expect((await limiter.acquire(tenant, 60, 100)).granted).toBe(true);
    });
  });
});
