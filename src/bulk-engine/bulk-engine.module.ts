import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { redisConnectionOptions } from '../redis/redis.service';
import { config } from '../config';
import { ActionRegistry } from './action-registry';
import { AdapterRegistry } from './adapter-registry';
import { CancelService } from './cancel.service';
import { JobFinalizer } from './job-finalizer.service';
import { ProgressService } from './progress.service';
import { QUEUE_BATCHES, QUEUE_ORCHESTRATE, QUEUE_WATCHDOG } from './queues';
import { TenantRateLimiter } from './tenant-rate-limiter.service';

/**
 * Engine services shared by the API and worker processes. Global so that entity plugins
 * (e.g. ShipmentModule) can inject the registries and register themselves.
 */
@Global()
@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnectionOptions(), prefix: config.queuePrefix() }),
    BullModule.registerQueue({ name: QUEUE_ORCHESTRATE }, { name: QUEUE_BATCHES }, { name: QUEUE_WATCHDOG }),
  ],
  providers: [ActionRegistry, AdapterRegistry, TenantRateLimiter, ProgressService, JobFinalizer, CancelService],
  exports: [BullModule, ActionRegistry, AdapterRegistry, TenantRateLimiter, ProgressService, JobFinalizer, CancelService],
})
export class BulkEngineModule {}
