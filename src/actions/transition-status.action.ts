import { Injectable } from '@nestjs/common';
import { BulkAction } from '../bulk-engine/bulk-action';
import { ActionContext, ActionResult } from '../bulk-engine/types';
import { ShipmentRecord } from './shipment.adapter';
import { TransitionStatusParams } from './shipment.types';
import { canTransition, isKnownStatus, SHIPMENT_STATUSES } from './status-machine';

/**
 * The second action. It exists to prove extensibility: this class + one register() line in
 * ShipmentModule is all it took. No engine file changed to support it.
 */
@Injectable()
export class TransitionStatusAction implements BulkAction<TransitionStatusParams> {
  readonly actionType = 'transition_status';
  readonly entityType = 'shipment';

  validateParams(params: unknown): string[] {
    const target = (params as Record<string, unknown> | null)?.target_status;
    if (typeof target !== 'string' || !isKnownStatus(target)) {
      return [`params.target_status must be one of ${SHIPMENT_STATUSES.join(', ')}`];
    }
    return [];
  }

  async execute(entity: unknown, params: TransitionStatusParams, ctx: ActionContext): Promise<ActionResult> {
    const shipment = entity as ShipmentRecord;
    const target = params.target_status;
    if (!isKnownStatus(target)) {
      return { outcome: 'failed', reason: `unknown_target_status:${target}` };
    }
    if (shipment.status === target) {
      return { outcome: 'skipped', reason: 'already_in_target_status' };
    }
    if (!canTransition(shipment.status, target)) {
      return { outcome: 'failed', reason: `illegal_transition:${shipment.status}->${target}` };
    }

    await ctx.tx.shipment.update({ where: { id: shipment.id }, data: { status: target } });
    return { outcome: 'success' };
  }
}
