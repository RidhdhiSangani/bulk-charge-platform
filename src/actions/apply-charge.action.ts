import { Injectable } from '@nestjs/common';
import { BulkAction } from '../bulk-engine/bulk-action';
import { ActionContext, ActionResult } from '../bulk-engine/types';
import { FxService } from '../fx/fx.service';
import { computeChargeAmount, PricingError } from './charge-math';
import { ShipmentRecord } from './shipment.adapter';
import { ApplyChargeParams, CHARGE_BASES } from './shipment.types';

export function validateApplyChargeParams(params: unknown): string[] {
  const p = (params ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof p.charge_code !== 'string' || !/^[A-Za-z0-9_\-]{1,64}$/.test(p.charge_code)) {
    errors.push('params.charge_code must be 1-64 chars of letters, digits, _ or -');
  }
  if (!CHARGE_BASES.includes(p.basis as never)) {
    errors.push(`params.basis must be one of ${CHARGE_BASES.join(', ')}`);
  }
  const rate = typeof p.rate === 'string' ? Number(p.rate) : p.rate;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    errors.push('params.rate must be a positive number');
  }
  if (typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency)) {
    errors.push('params.currency must be an ISO 4217 code such as USD');
  }
  return errors;
}

@Injectable()
export class ApplyChargeAction implements BulkAction<ApplyChargeParams> {
  readonly actionType = 'apply_charge';
  readonly entityType = 'shipment';

  constructor(private readonly fx: FxService) {}

  validateParams(params: unknown): string[] {
    return validateApplyChargeParams(params);
  }

  async execute(entity: unknown, params: ApplyChargeParams, ctx: ActionContext): Promise<ActionResult> {
    const shipment = entity as ShipmentRecord;

    // Entity-level idempotency first: an existing (shipment_id, charge_code) is always a skip,
    // even if the shipment has since been billed. The row is locked FOR UPDATE by the engine,
    // so this check cannot race with another job; ON CONFLICT below is the backstop.
    const existing = await ctx.tx.shipmentCharge.findUnique({
      where: { shipmentId_chargeCode: { shipmentId: shipment.id, chargeCode: params.charge_code } },
      select: { id: true },
    });
    if (existing) {
      return { outcome: 'skipped', reason: 'charge_already_applied' };
    }

    if (shipment.isBilled) {
      return { outcome: 'failed', reason: 'already_billed' };
    }

    let amount;
    try {
      amount = computeChargeAmount(params.basis, params.rate, shipment.containerCount, shipment.chargeableWeight);
    } catch (err) {
      if (err instanceof PricingError) {
        return { outcome: 'failed', reason: err.code };
      }
      throw err;
    }

    const converted = await this.fx.convert(params.currency, shipment.billingCurrency, amount);
    if (!converted) {
      return { outcome: 'failed', reason: `unknown_currency_pair:${params.currency}->${shipment.billingCurrency}` };
    }

    // ON CONFLICT DO NOTHING never raises, so it cannot poison the batch transaction
    // (a raised unique violation would abort every later statement in it).
    const inserted = await ctx.tx.$queryRaw<{ id: bigint }[]>`
      INSERT INTO shipment_charges
        (shipment_id, charge_code, basis, rate, currency, amount, amount_billing, billing_currency, fx_rate, bulk_job_id)
      VALUES
        (${shipment.id}, ${params.charge_code}, ${params.basis}, ${String(params.rate)}::numeric, ${params.currency},
         ${amount.toString()}::numeric, ${converted.amount.toString()}::numeric, ${shipment.billingCurrency},
         ${converted.rate.toString()}::numeric, ${ctx.jobId}::uuid)
      ON CONFLICT (shipment_id, charge_code) DO NOTHING
      RETURNING id
    `;
    if (!inserted.length) {
      return { outcome: 'skipped', reason: 'charge_already_applied' };
    }
    return { outcome: 'success' };
  }
}
