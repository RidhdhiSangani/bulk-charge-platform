import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BULK_JOB_STATUSES, ENTITY_OUTCOMES } from '../bulk-engine/types';

export class CreateBulkJobDto {
  @ApiProperty({ example: 'tnt_demo', description: 'Tenant that owns the job (seeded: tnt_demo, tnt_acme)' })
  @IsString()
  @Matches(/^[A-Za-z0-9_\-]{1,64}$/)
  tenant_id!: string;

  @ApiProperty({ example: 'apply_charge', description: 'Registered action: apply_charge | transition_status' })
  @IsString()
  @IsNotEmpty()
  action_type!: string;

  @ApiProperty({ example: 'shipment', description: 'Registered entity type' })
  @IsString()
  @IsNotEmpty()
  entity_type!: string;

  @ApiProperty({
    example: { origin_port: 'INNSA', status: 'in_transit' },
    description:
      'Selection filter (exact match). Allowed keys: origin_port, destination_port, status, trade_type, customer_id. ' +
      'Unknown keys are rejected with 400. {} selects every shipment of the tenant.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  filter!: Record<string, unknown>;

  @ApiProperty({
    example: { charge_code: 'FSC', basis: 'per_kg', rate: 0.12, currency: 'USD' },
    description:
      'Action parameters. apply_charge: { charge_code, basis: per_container|per_kg|flat, rate, currency }. ' +
      'transition_status: { target_status: booked|in_transit|arrived|delivered }.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  params!: Record<string, unknown>;

  @ApiPropertyOptional({
    example: '2030-11-22T23:15:00+05:30',
    description: 'ISO-8601 start time. In the future → status "scheduled"; omitted or past → runs now.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  scheduled_at?: string;
}

export class ListJobsQuery {
  @ApiPropertyOptional({ enum: BULK_JOB_STATUSES })
  @IsOptional()
  @IsIn(BULK_JOB_STATUSES as string[])
  status?: string;

  @ApiPropertyOptional({ example: 'tnt_demo' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenant_id?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'next_cursor from the previous page (a job id)' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class TenantQuery {
  @ApiPropertyOptional({ example: 'tnt_demo', description: 'Scope to a tenant (or send X-Tenant-Id)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenant_id?: string;
}

export class EntriesQuery extends TenantQuery {
  @ApiPropertyOptional({ enum: ENTITY_OUTCOMES })
  @IsOptional()
  @IsIn(ENTITY_OUTCOMES as string[])
  outcome?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ description: 'next_cursor from the previous page (an entry id)' })
  @IsOptional()
  @Matches(/^\d+$/)
  cursor?: string;
}

export class EventsQuery extends TenantQuery {
  @ApiPropertyOptional({ default: 1000, minimum: 250, maximum: 10000, description: 'Push interval in ms' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(250)
  @Max(10000)
  interval_ms?: number;
}
