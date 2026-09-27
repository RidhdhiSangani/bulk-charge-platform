import { Module } from '@nestjs/common';
import { BulkJobsController } from './bulk-jobs.controller';
import { BulkJobsService } from './bulk-jobs.service';

@Module({
  controllers: [BulkJobsController],
  providers: [BulkJobsService],
})
export class BulkJobsModule {}
