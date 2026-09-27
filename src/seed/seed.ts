/**
 * Idempotent seed: tenants, FX rates and shipments from data/shipments.seed.csv.
 * Safe to run on every API start (upserts + skipDuplicates).
 *
 *   npm run seed            # insert missing rows
 *   npm run seed -- --reset # wipe jobs/charges/shipments and reload (fresh demo)
 *
 * Compiled into dist/seed/seed.js so the production image needs no TypeScript runtime.
 */
import '../load-env';
import { PrismaClient, Prisma } from '@prisma/client';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const prisma = new PrismaClient();

// Deliberately no AED pairs: shipments billed in AED exercise the unknown_currency_pair failure.
const FX: [string, string, string][] = [
  ['USD', 'INR', '83.25'],
  ['INR', 'USD', '0.01201201'],
  ['EUR', 'USD', '1.08'],
  ['USD', 'EUR', '0.92592593'],
  ['EUR', 'INR', '89.91'],
  ['INR', 'EUR', '0.01112223'],
];

async function main() {
  const reset = process.argv.includes('--reset');
  const csvPath = resolve(process.env.SEED_CSV ?? 'data/shipments.seed.csv');

  if (reset) {
    await prisma.$executeRawUnsafe(
      'TRUNCATE job_entries, job_batches, bulk_jobs, shipment_charges, shipments RESTART IDENTITY CASCADE',
    );
    console.log('Reset: truncated jobs, charges and shipments');
  }

  for (const [id, name] of [
    ['tnt_demo', 'Demo Forwarder'],
    ['tnt_acme', 'Acme Logistics'],
  ]) {
    await prisma.tenant.upsert({ where: { id }, create: { id, name }, update: {} });
  }

  for (const [base, quote, rate] of FX) {
    await prisma.fxRate.upsert({
      where: { baseCurrency_quoteCurrency: { baseCurrency: base, quoteCurrency: quote } },
      create: { baseCurrency: base, quoteCurrency: quote, rate: new Prisma.Decimal(rate) },
      update: { rate: new Prisma.Decimal(rate) },
    });
  }

  if (!existsSync(csvPath)) {
    console.warn(`No CSV at ${csvPath}; skipping shipments (run: npm run seed:csv)`);
    return;
  }
  const [header, ...lines] = readFileSync(csvPath, 'utf8').trim().split('\n');
  const cols = header.split(',');
  const rows = lines.map((line) => {
    const v = Object.fromEntries(line.split(',').map((x, i) => [cols[i], x]));
    return {
      tenantId: v.tenant_id,
      shipmentNo: v.shipment_no,
      tradeType: v.trade_type,
      originPort: v.origin_port,
      destinationPort: v.destination_port,
      containerCount: Number(v.container_count),
      chargeableWeight: v.chargeable_weight ? new Prisma.Decimal(v.chargeable_weight) : null,
      customerId: v.customer_id,
      status: v.status,
      billingCurrency: v.billing_currency,
      isBilled: v.is_billed === 'true',
    };
  });

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const res = await prisma.shipment.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true });
    inserted += res.count;
  }
  const total = await prisma.shipment.count();
  console.log(`Seed done: ${inserted} new shipments inserted (${total} total), ${FX.length} FX rates, 2 tenants`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
