// Shipment-specific types. The engine never imports this file.

/** Allowlisted filter keys → Prisma field names. Filter SQL is built only from this map. */
export const SHIPMENT_FILTER_FIELDS = {
  origin_port: 'originPort',
  destination_port: 'destinationPort',
  status: 'status',
  trade_type: 'tradeType',
  customer_id: 'customerId',
} as const;

export type ShipmentFilterKey = keyof typeof SHIPMENT_FILTER_FIELDS;
export type ShipmentFilter = Partial<Record<ShipmentFilterKey, string>>;

export const CHARGE_BASES = ['per_container', 'per_kg', 'flat'] as const;
export type ChargeBasis = (typeof CHARGE_BASES)[number];

export type ApplyChargeParams = {
  charge_code: string;
  basis: ChargeBasis;
  rate: number;
  currency: string;
};

export type TransitionStatusParams = {
  target_status: string;
};
