import { canTransition } from './status-machine';

describe('status machine', () => {
  it('allows only the next forward step', () => {
    expect(canTransition('booked', 'in_transit')).toBe(true);
    expect(canTransition('in_transit', 'arrived')).toBe(true);
    expect(canTransition('arrived', 'delivered')).toBe(true);
    expect(canTransition('booked', 'arrived')).toBe(false);
    expect(canTransition('delivered', 'booked')).toBe(false);
  });
});
