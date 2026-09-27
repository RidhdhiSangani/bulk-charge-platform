import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ActionRegistry } from '../bulk-engine/action-registry';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly actions: ActionRegistry,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Postgres + Redis connectivity and the registered entity/action pairs' })
  async health() {
    const [db, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => 'ok').catch((e: Error) => `error: ${e.message}`),
      this.redis.ping().then(() => 'ok').catch((e: Error) => `error: ${e.message}`),
    ]);
    const body = { status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded', db, redis, actions: this.actions.list() };
    if (body.status !== 'ok') {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
