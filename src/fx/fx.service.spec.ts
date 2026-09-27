import { Prisma } from '@prisma/client';
import { convertAmount, RateTable } from './fx.service';

const rates: RateTable = new Map([
  ['USD->INR', new Prisma.Decimal('83.25')],
  ['EUR->USD', new Prisma.Decimal('1.08')],
]);

describe('convertAmount', () => {
  it('returns identity for the same currency', () => {
    const r = convertAmount(rates, 'USD', 'USD', 10)!;
    expect(r.amount.toNumber()).toBe(10);
    expect(r.rate.toNumber()).toBe(1);
  });

  it('uses the direct pair', () => {
    expect(convertAmount(rates, 'USD', 'INR', 2)!.amount.toString()).toBe('166.5');
  });

  it('falls back to the inverse of the reverse pair', () => {
    const r = convertAmount(rates, 'USD', 'EUR', 108)!;
    expect(r.amount.toNumber()).toBeCloseTo(100, 3);
  });

  it('returns null for an unknown pair', () => {
    expect(convertAmount(rates, 'USD', 'AED', 1)).toBeNull();
  });
});
