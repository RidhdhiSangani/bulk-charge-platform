import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { config } from '../config';
import { BatchProcessor } from './batch.processor';
import { OrchestratorProcessor } from './orchestrator.processor';
import { QUEUE_WATCHDOG } from './queues';
import { WatchdogProcessor } from './watchdog.processor';

/** Queue consumers. Loaded only by the worker process — the API never processes jobs. */
@Module({
  providers: [OrchestratorProcessor, BatchProcessor, WatchdogProcessor],
})
export class BulkEngineWorkersModule implements OnApplicationBootstrap {
  private readonly log = new Logger(BulkEngineWorkersModule.name);

  constructor(@InjectQueue(QUEUE_WATCHDOG) private readonly watchdogQueue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    // Idempotent upsert: every worker replica calls this, BullMQ keeps a single scheduler.
    await this.watchdogQueue.upsertJobScheduler(
      'bulk-watchdog-sweep',
      { every: config.watchdogEveryMs() },
      { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
    this.log.log(`Watchdog scheduled every ${config.watchdogEveryMs()}ms`);
  }
}
