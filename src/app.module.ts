import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { BulkJobsModule } from './bulk-jobs/bulk-jobs.module';
import { BulkEngineWorkersModule } from './bulk-engine/bulk-engine-workers.module';
import { HealthController } from './health/health.controller';
import { ShipmentsController } from './shipments/shipments.controller';
import { config } from './config';

/**
 * HTTP API process: validates + records jobs and enqueues orchestration.
 *
 * Normally it never processes batches (the worker process does). With RUN_WORKERS_IN_API=true
 * ("combined mode") it also runs the queue consumers in the same process — used for single-service
 * hosting such as Render's free plan, which has no background workers. The engine is identical
 * either way; only where the consumers run changes.
 */
@Module({
  imports: [CoreModule, BulkJobsModule, ...(config.runWorkersInApi() ? [BulkEngineWorkersModule] : [])],
  controllers: [HealthController, ShipmentsController],
})
export class AppModule {}
