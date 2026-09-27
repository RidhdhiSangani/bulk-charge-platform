// Read lazily so tests (and .env loading in load-env.ts) can set values before first use.
const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: () => num('PORT', 3000),
  redisUrl: () => process.env.REDIS_URL ?? 'redis://localhost:6379',
  batchSize: () => num('BATCH_SIZE', 100),
  tenantRateLimitPerMin: () => num('TENANT_RATE_LIMIT_PER_MIN', 5000),
  leaseTtlSeconds: () => num('LEASE_TTL_SECONDS', 60),
  batchConcurrency: () => num('WORKER_CONCURRENCY', 4),
  watchdogEveryMs: () => num('WATCHDOG_EVERY_MS', 15_000),
  cancelCheckEvery: () => num('CANCEL_CHECK_EVERY', 10),
  debugEntityDelayMs: () => num('BULK_DEBUG_ENTITY_DELAY_MS', 0),
  // BullMQ key prefix: lets several environments (or test runs) share one Redis without seeing each other's queues
  queuePrefix: () => process.env.QUEUE_PREFIX || 'bull',
  runWorkersInApi: () => process.env.RUN_WORKERS_IN_API === 'true',
  sseIntervalMs: () => num('SSE_INTERVAL_MS', 1000),
};
