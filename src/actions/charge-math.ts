import { Prisma } from '@prisma/client';
import { ChargeBasis } from './shipment.types';

// Money is computed with decimal arithmetic (never binary floats) and rounded to the
// 4 decimal places stored in shipment_charges.
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

export class PricingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function computeChargeAmount(
  basis: ChargeBasis,
  rate: Prisma.Decimal.Value,
  containerCount: number | null,
  chargeableWeight: Prisma.Decimal.Value | null,
): Decimal {
  const r = new Decimal(rate);
  if (basis === 'flat') {
    return round4(r);
  }
  if (basis === 'per_container') {
    if (containerCount == null || containerCount <= 0) {
      throw new PricingError('missing_container_count', 'container_count is missing or not positive');
    }
    return round4(r.mul(containerCount));
  }
  if (basis === 'per_kg') {
    if (chargeableWeight == null) {
      throw new PricingError('missing_weight', 'chargeable_weight is required for per_kg basis');
    }
    const w = new Decimal(chargeableWeight);
    if (w.lte(0)) {
      throw new PricingError('invalid_weight', 'chargeable_weight must be positive');
    }
    return round4(r.mul(w));
  }
  throw new PricingError('unknown_basis', `Unknown charge basis: ${String(basis)}`);
}

export function round4(n: Decimal): Decimal {
  return n.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}
