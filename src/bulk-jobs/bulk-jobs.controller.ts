import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res, Sse } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { BulkJobsService } from './bulk-jobs.service';
import { CreateBulkJobDto, EntriesQuery, EventsQuery, ListJobsQuery, TenantQuery } from './dto';

const TenantHeader = () =>
  ApiHeader({ name: 'X-Tenant-Id', required: false, description: 'Optional tenant scope (wins over ?tenant_id)' });
const JobIdParam = () => ApiParam({ name: 'jobId', description: 'Bulk job id (UUID)' });

/**
 * No auth in this assignment: the tenant comes from the body on create, and read/cancel
 * endpoints may be scoped with ?tenant_id= or an X-Tenant-Id header (header wins).
 */
@ApiTags('bulk-jobs')
@Controller('v1/bulk-jobs')
export class BulkJobsController {
  constructor(private readonly service: BulkJobsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a bulk job',
    description:
      'Selects entities by filter and applies the action to each one independently. Returns immediately; ' +
      'processing happens in the background. With scheduled_at in the future the job is "scheduled".',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Client-generated key (e.g. a UUID) reused on retries. Same key + same body → the original job.',
  })
  @ApiResponse({ status: 201, description: 'Job created' })
  @ApiResponse({ status: 200, description: 'Idempotent replay: the original job (header Idempotent-Replayed: true)' })
  @ApiResponse({ status: 400, description: 'Invalid filter / params / unsupported action / unknown tenant' })
  @ApiResponse({ status: 422, description: 'Idempotency-Key already used with a different body' })
  async create(
    @Body() dto: CreateBulkJobDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { job, created } = await this.service.create(dto, idempotencyKey);
    res.status(created ? 201 : 200);
    if (!created) res.setHeader('Idempotent-Replayed', 'true');
    return this.service.present(job);
  }

  @Get()
  @ApiOperation({ summary: 'List bulk jobs', description: 'Newest first, filterable by status and tenant, cursor-paginated.' })
  @TenantHeader()
  list(@Query() q: ListJobsQuery, @Headers('x-tenant-id') tenantHeader?: string) {
    return this.service.list({ ...q, tenant_id: tenantHeader || q.tenant_id });
  }

  @Get(':jobId')
  @ApiOperation({
    summary: 'Job detail with live progress',
    description: 'processed of total, percent, throughput, estimated completion, batches by status, tenant rate usage.',
  })
  @JobIdParam()
  @TenantHeader()
  @ApiResponse({ status: 404, description: 'Unknown job (or belongs to another tenant)' })
  detail(@Param('jobId') jobId: string, @Query() q: TenantQuery, @Headers('x-tenant-id') tenantHeader?: string) {
    return this.service.detail(jobId, tenantHeader || q.tenant_id);
  }

  @Sse(':jobId/events')
  @ApiOperation({
    summary: 'Real-time progress stream (Server-Sent Events)',
    description:
      'Keeps the connection open and pushes a `progress` event every interval_ms, then one `done` event when ' +
      'the job completes / is cancelled / fails, and closes. Try: curl -N <base>/v1/bulk-jobs/<id>/events',
  })
  @ApiProduces('text/event-stream')
  @JobIdParam()
  @TenantHeader()
  events(@Param('jobId') jobId: string, @Query() q: EventsQuery, @Headers('x-tenant-id') tenantHeader?: string) {
    return this.service.events(jobId, tenantHeader || q.tenant_id, q.interval_ms);
  }

  @Get(':jobId/summary')
  @ApiOperation({ summary: 'Success / failed / skipped counts, plus failure & skip reasons grouped' })
  @JobIdParam()
  @TenantHeader()
  summary(@Param('jobId') jobId: string, @Query() q: TenantQuery, @Headers('x-tenant-id') tenantHeader?: string) {
    return this.service.summary(jobId, tenantHeader || q.tenant_id);
  }

  @Get(':jobId/entries')
  @ApiOperation({ summary: 'Per-entity log, filterable by outcome, cursor-paginated' })
  @JobIdParam()
  @TenantHeader()
  entries(@Param('jobId') jobId: string, @Query() q: EntriesQuery, @Headers('x-tenant-id') tenantHeader?: string) {
    return this.service.entries(jobId, { ...q, tenant_id: tenantHeader || q.tenant_id });
  }

  @Post(':jobId/cancel')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Cancel a scheduled, queued or running job',
    description:
      'Scheduled/queued → cancelled immediately. Running → pending batches are closed at once and in-flight ' +
      'batches stop at their next check; already-processed entities stay processed.',
  })
  @JobIdParam()
  @TenantHeader()
  @ApiResponse({ status: 202, description: '{ cancel: "cancelled" | "cancelling", job }' })
  @ApiResponse({ status: 409, description: 'Job already completed / cancelled / failed' })
  cancel(@Param('jobId') jobId: string, @Query() q: TenantQuery, @Headers('x-tenant-id') tenantHeader?: string) {
    return this.service.cancel(jobId, tenantHeader || q.tenant_id);
  }
}
