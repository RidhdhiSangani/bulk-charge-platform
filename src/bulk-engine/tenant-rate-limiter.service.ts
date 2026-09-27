import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { config } from '../config';

// Strict sliding-window limiter, one sorted set per tenant.
// Each grant is a member "<uuid>:<count>" scored by its grant time (ms, Redis clock).
// A grant is allowed only if the sum of counts granted in the last 60s plus the request
// stays within the limit. Otherwise the script returns how many ms until enough capacity
// frees up, so the caller can delay the batch precisely (never drop / fail it).
// Using the Redis clock keeps multiple workers consistent even if their clocks drift.
const ACQUIRE_LUA = `
local key = KEYS[1]
local n = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local member = ARGV[4]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
local used = 0
for i = 1, #entries, 2 do
  used = used + tonumber(string.match(entries[i], ':(%d+)$'))
end
-- A request bigger than the whole limit is admitted alone into an empty window,
-- otherwise it could never run.
if (used + n <= limit) or (used == 0) then
  redis.call('ZADD', key, now, member .. ':' .. n)
  redis.call('PEXPIRE', key, window)
  return 0
end
local freed = 0
for i = 1, #entries, 2 do
  freed = freed + tonumber(string.match(entries[i], ':(%d+)$'))
  if used - freed + n <= limit then
    return math.max(1, tonumber(entries[i + 1]) + window - now)
  end
end
return window
`;

const USAGE_LUA = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local entries = redis.call('ZRANGE', key, 0, -1)
local used = 0
for i = 1, #entries do
  used = used + tonumber(string.match(entries[i], ':(%d+)$'))
end
return used
`;

const WINDOW_MS = 60_000;

export type RateGrant = { granted: true; member: string } | { granted: false; retryAfterMs: number };

@Injectable()
export class TenantRateLimiter {
  constructor(private readonly redis: RedisService) {}

  async acquire(tenantId: string, entityCount: number, limit = config.tenantRateLimitPerMin()): Promise<RateGrant> {
    if (entityCount <= 0) {
      return { granted: true, member: '' };
    }
    const member = randomUUID();
    const res = await this.redis.client.eval(
      ACQUIRE_LUA,
      1,
      this.key(tenantId),
      entityCount,
      limit,
      WINDOW_MS,
      member,
    );
    const wait = Number(res);
    if (wait === 0) {
      return { granted: true, member: `${member}:${entityCount}` };
    }
    return { granted: false, retryAfterMs: wait };
  }

  /** Return a grant that ended up unused (e.g. the batch was already claimed elsewhere). */
  async release(tenantId: string, member: string): Promise<void> {
    if (member) {
      await this.redis.client.zrem(this.key(tenantId), member);
    }
  }

  async usage(tenantId: string): Promise<{ limit_per_min: number; used_last_60s: number }> {
    const used = await this.redis.client.eval(USAGE_LUA, 1, this.key(tenantId), WINDOW_MS);
    return { limit_per_min: config.tenantRateLimitPerMin(), used_last_60s: Number(used) };
  }

  private key(tenantId: string): string {
    return `bulk:rate:${tenantId}`;
  }
}
