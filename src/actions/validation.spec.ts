import { validateApplyChargeParams } from './apply-charge.action';
import { validateShipmentFilter } from './shipment.adapter';
import { TransitionStatusAction } from './transition-status.action';

describe('shipment filter allowlist', () => {
  it('accepts allowlisted keys', () => {
    expect(validateShipmentFilter({ origin_port: 'INNSA', status: 'in_transit' })).toEqual([]);
    expect(validateShipmentFilter({})).toEqual([]);
  });

  it('rejects unknown keys so a typo cannot match every shipment', () => {
    const errors = validateShipmentFilter({ origin_prot: 'INNSA' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('origin_prot');
  });

  it('rejects non-string / empty values (no operator injection)', () => {
    expect(validateShipmentFilter({ status: { $ne: 'x' } })).toHaveLength(1);
    expect(validateShipmentFilter({ status: '' })).toHaveLength(1);
  });
});

describe('apply_charge params', () => {
  it('accepts a valid template', () => {
    expect(validateApplyChargeParams({ charge_code: 'THC', basis: 'per_container', rate: 25, currency: 'USD' })).toEqual([]);
  });

  it('reports every invalid field', () => {
    const errors = validateApplyChargeParams({ charge_code: '', basis: 'per_ton', rate: -1, currency: 'usd' });
    expect(errors).toHaveLength(4);
  });
});

describe('transition_status params', () => {
  const action = new TransitionStatusAction();
  it('requires a known target status', () => {
    expect(action.validateParams({ target_status: 'arrived' })).toEqual([]);
    expect(action.validateParams({ target_status: 'lost' })).toHaveLength(1);
    expect(action.validateParams({})).toHaveLength(1);
  });
});
