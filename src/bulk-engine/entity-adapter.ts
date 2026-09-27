import { Prisma } from '@prisma/client';
import { JsonMap } from './types';

/**
 * How the engine reads an entity type without knowing its shape.
 * Entities must have a monotonically increasing bigint id so the engine can keyset-paginate.
 */
export interface EntityAdapter<T = unknown> {
  readonly entityType: string;

  /** Validate a selection filter at submission time (allowlisted keys, value types). */
  validateFilter(filter: JsonMap): string[];

  /** Number of entities matching the filter (records total_matched). */
  count(tenantId: string, filter: JsonMap): Promise<number>;

  /** Next page of matching ids strictly greater than afterId, ascending. Ids only — never rows. */
  scanPage(tenantId: string, filter: JsonMap, afterId: bigint, limit: number): Promise<bigint[]>;

  /**
   * Load and row-lock entities inside the batch transaction (ordered by id to avoid deadlocks
   * between concurrent jobs touching the same rows). Missing ids are simply absent.
   */
  lockByIds(tx: Prisma.TransactionClient, ids: bigint[]): Promise<T[]>;

  /** Re-check the job's filter at processing time (data may have changed since the scan). */
  matchesFilter(entity: T, tenantId: string, filter: JsonMap): boolean;

  entityId(entity: T): bigint;

  /** Human readable reference for logs (e.g. shipment_no). */
  entityRef(entity: T): string;
}
