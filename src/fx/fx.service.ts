import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;

export type RateTable = Map<string, Decimal>;
export type Conversion = { amount: Decimal; rate: Decimal };

const pairKey = (base: string, quote: string) => `${base}->${quote}`;

/**
 * Pure conversion over a rate table: identity, direct pair, or inverse of the reverse pair.
 * Returns null for an unknown pair (the caller records a per-entity failure).
 */
export function convertAmount(rates: RateTable, from: string, to: string, amount: Prisma.Decimal.Value): Conversion | null {
  const a = new Decimal(amount);
  if (from === to) {
    return { amount: a, rate: new Decimal(1) };
  }
  let rate = rates.get(pairKey(from, to));
  if (!rate) {
    const reverse = rates.get(pairKey(to, from));
    if (reverse && !reverse.isZero()) {
      rate = new Decimal(1).div(reverse).toDecimalPlaces(8);
    }
  }
  if (!rate) {
    return null;
  }
  return { amount: a.mul(rate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP), rate };
}

/**
 * Static FX table (fx_rates) cached in memory for a short TTL, so pricing a batch of
 * 100 shipments costs zero FX queries instead of 100.
 */
@Injectable()
export class FxService {
  private cache: { rates: RateTable; loadedAt: number } | null = null;
  private readonly ttlMs = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  async convert(from: string, to: string, amount: Prisma.Decimal.Value): Promise<Conversion | null> {
    return convertAmount(await this.rates(), from, to, amount);
  }

  private async rates(): Promise<RateTable> {
    if (this.cache && Date.now() - this.cache.loadedAt < this.ttlMs) {
      return this.cache.rates;
    }
    const rows = await this.prisma.fxRate.findMany();
    const rates: RateTable = new Map(rows.map((r) => [pairKey(r.baseCurrency, r.quoteCurrency), r.rate]));
    this.cache = { rates, loadedAt: Date.now() };
    return rates;
  }
}
