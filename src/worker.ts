import './load-env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { config } from './config';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM → BullMQ workers stop taking jobs and wait for in-flight batches to commit.
  app.enableShutdownHooks();
  new Logger('Worker').log(
    `Worker ${process.pid} up: batch concurrency ${config.batchConcurrency()}, batch size ${config.batchSize()}, ` +
      `tenant limit ${config.tenantRateLimitPerMin()}/min`,
  );
}

void bootstrap();
