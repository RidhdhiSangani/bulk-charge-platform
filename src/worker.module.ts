import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { BulkEngineWorkersModule } from './bulk-engine/bulk-engine-workers.module';

/** Worker process: consumes the orchestrate, batch and watchdog queues. Scale by adding replicas. */
@Module({
  imports: [CoreModule, BulkEngineWorkersModule],
})
export class WorkerModule {}
