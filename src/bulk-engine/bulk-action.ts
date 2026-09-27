import { ActionContext, ActionResult } from './types';

/**
 * A bulk action is the only thing a developer writes to add a new kind of bulk job.
 * The engine (orchestration, batching, leasing, logging, counters, cancel, rate limit,
 * idempotency) calls these methods and nothing else.
 */
export interface BulkAction<P = unknown> {
  readonly actionType: string;
  readonly entityType: string;

  /** Validate job params at submission time. Return human readable errors (empty = valid). */
  validateParams(params: unknown): string[];

  /**
   * Apply the action to one entity. Expected business failures are returned as
   * { outcome: 'failed' | 'skipped', reason } and must NOT throw. A thrown error is treated
   * as an unexpected per-entity failure; it is rolled back to a savepoint and logged, and
   * never aborts the batch or the job.
   */
  execute(entity: unknown, params: P, ctx: ActionContext): Promise<ActionResult>;
}
