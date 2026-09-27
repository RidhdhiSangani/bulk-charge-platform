import { Injectable } from '@nestjs/common';
import { Prisma, Shipment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EntityAdapter } from '../bulk-engine/entity-adapter';
import { JsonMap } from '../bulk-engine/types';
import { SHIPMENT_FILTER_FIELDS, ShipmentFilter, ShipmentFilterKey } from './shipment.types';

export type ShipmentRecord = Shipment;

const FILTER_KEYS = Object.keys(SHIPMENT_FILTER_FIELDS) as ShipmentFilterKey[];

/** Validates a shipment filter. Unknown keys are rejected — a typo must not widen the match to "everything". */
export function validateShipmentFilter(filter: JsonMap): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (!(FILTER_KEYS as string[]).includes(key)) {
      errors.push(`filter.${key} is not a supported filter key (allowed: ${FILTER_KEYS.join(', ')})`);
    } else if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`filter.${key} must be a non-empty string`);
    }
  }
  return errors;
}

@Injectable()
export class ShipmentAdapter implements EntityAdapter<ShipmentRecord> {
  readonly entityType = 'shipment';

  constructor(private readonly prisma: PrismaService) {}

  validateFilter(filter: JsonMap): string[] {
    return validateShipmentFilter(filter);
  }

  async count(tenantId: string, filter: JsonMap): Promise<number> {
    return this.prisma.shipment.count({ where: this.where(tenantId, filter) });
  }

  // Keyset pagination on the BIGSERIAL id: WHERE <filter> AND id > $after ORDER BY id LIMIT n.
  // Served by the (tenant_id, <filter col>, ..., id) indexes; constant cost per page at any depth
  // (unlike OFFSET), and only ids leave the database.
  async scanPage(tenantId: string, filter: JsonMap, afterId: bigint, limit: number): Promise<bigint[]> {
    const rows = await this.prisma.shipment.findMany({
      where: { ...this.where(tenantId, filter), id: { gt: afterId } },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async lockByIds(tx: Prisma.TransactionClient, ids: bigint[]): Promise<ShipmentRecord[]> {
    if (!ids.length) {
      return [];
    }
    // Row locks in id order: two jobs touching the same shipments can never deadlock, and a
    // concurrent job cannot change a shipment between our read and our write.
    await tx.$queryRaw`SELECT id FROM shipments WHERE id = ANY(${ids}::bigint[]) ORDER BY id FOR UPDATE`;
    return tx.shipment.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
  }

  matchesFilter(entity: ShipmentRecord, tenantId: string, filter: JsonMap): boolean {
    if (entity.tenantId !== tenantId) {
      return false;
    }
    const f = this.normalize(filter);
    return FILTER_KEYS.every((key) => f[key] == null || entity[SHIPMENT_FILTER_FIELDS[key]] === f[key]);
  }

  entityId(entity: ShipmentRecord): bigint {
    return entity.id;
  }

  entityRef(entity: ShipmentRecord): string {
    return entity.shipmentNo;
  }

  private where(tenantId: string, filter: JsonMap): Prisma.ShipmentWhereInput {
    const f = this.normalize(filter);
    const where: Prisma.ShipmentWhereInput = { tenantId };
    for (const key of FILTER_KEYS) {
      if (f[key] != null) {
        (where as Record<string, unknown>)[SHIPMENT_FILTER_FIELDS[key]] = f[key];
      }
    }
    return where;
  }

  private normalize(filter: JsonMap): ShipmentFilter {
    const out: ShipmentFilter = {};
    for (const key of FILTER_KEYS) {
      const value = filter[key];
      if (value != null && value !== '') {
        out[key] = String(value);
      }
    }
    return out;
  }
}
