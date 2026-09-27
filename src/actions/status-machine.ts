export const SHIPMENT_STATUSES = ['booked', 'in_transit', 'arrived', 'delivered'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

const ORDER: Record<ShipmentStatus, number> = {
  booked: 0,
  in_transit: 1,
  arrived: 2,
  delivered: 3,
};

export function canTransition(from: string, to: string): boolean {
  if (!(from in ORDER) || !(to in ORDER)) {
    return false;
  }
  return ORDER[to as ShipmentStatus] === ORDER[from as ShipmentStatus] + 1;
}

export function isKnownStatus(status: string): status is ShipmentStatus {
  return (SHIPMENT_STATUSES as readonly string[]).includes(status);
}
