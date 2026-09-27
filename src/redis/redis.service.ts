import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { config } from '../config';

/** ioredis / BullMQ connection options from a redis:// or rediss:// URL (Railway, Render, Upstash). */
export function redisConnectionOptions(url = config.redisUrl()): RedisOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    // Resolve IPv4 and IPv6 (ioredis defaults to IPv4 only; e.g. Railway's private network is IPv6)
    family: 0,
    maxRetriesPerRequest: null,
  };
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor() {
    this.client = new Redis(redisConnectionOptions());
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }
}
