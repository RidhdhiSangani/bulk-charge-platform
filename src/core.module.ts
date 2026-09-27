import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { BulkEngineModule } from './bulk-engine/bulk-engine.module';
import { ShipmentModule } from './actions/shipment.module';

/**
 * Everything both processes need: DB, Redis, the engine services + queues, and the entity
 * plugins (which register their adapter/actions into the engine registries on init).
 * To add an entity, add its plugin module here.
 */
@Module({
  imports: [PrismaModule, RedisModule, BulkEngineModule, ShipmentModule],
})
export class CoreModule {}
