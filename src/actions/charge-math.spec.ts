import { computeChargeAmount, PricingError } from './charge-math';

describe('computeChargeAmount', () => {
  it('computes flat, per_container, and per_kg', () => {
    expect(computeChargeAmount('flat', 50, 2, 10).toNumber()).toBe(50);
    expect(computeChargeAmount('per_container', 25, 4, 10).toNumber()).toBe(100);
    expect(computeChargeAmount('per_kg', 2, 1, 12.5).toNumber()).toBe(25);
  });

  it('uses decimal arithmetic (no float drift) and rounds to 4 dp', () => {
    expect(computeChargeAmount('per_kg', '0.1', 1, '0.2').toString()).toBe('0.02');
    expect(computeChargeAmount('per_kg', '1.23456', 1, '1').toString()).toBe('1.2346');
  });

  it('fails when weight is missing or not positive for per_kg', () => {
    expect(() => computeChargeAmount('per_kg', 2, 1, null)).toThrow(PricingError);
    try {
      computeChargeAmount('per_kg', 2, 1, null);
    } catch (e) {
      expect((e as PricingError).code).toBe('missing_weight');
    }
    expect(() => computeChargeAmount('per_kg', 2, 1, 0)).toThrow(PricingError);
  });

  it('fails when container count is not positive for per_container', () => {
    expect(() => computeChargeAmount('per_container', 2, 0, 5)).toThrow(PricingError);
  });

  it('ignores missing weight for bases that do not need it', () => {
    expect(computeChargeAmount('flat', 10, 1, null).toNumber()).toBe(10);
    expect(computeChargeAmount('per_container', 10, 3, null).toNumber()).toBe(30);
  });
});
