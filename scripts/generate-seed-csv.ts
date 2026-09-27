/**
 * Generates data/shipments.seed.csv — deterministic (seeded PRNG) so every run and every
 * reviewer gets the same data. Mix is chosen so every success/failure/skip path shows up:
 *   ~5% missing chargeable_weight  → per_kg charge fails with missing_weight
 *   ~5% is_billed                  → charge fails with already_billed
 *   ~5% billing currency AED       → no FX rate seeded → unknown_currency_pair
 *   status spread across the state machine → legal and illegal transitions
 *
 * Usage: npx tsx scripts/generate-seed-csv.ts [count=5000] [out=data/shipments.seed.csv]
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const count = Number(process.argv[2] ?? 5000);
const out = process.argv[3] ?? 'data/shipments.seed.csv';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20240926);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
const weighted = <T>(pairs: readonly [T, number][]) => {
  const r = rnd();
  let acc = 0;
  for (const [v, w] of pairs) {
    acc += w;
    if (r < acc) return v;
  }
  return pairs[pairs.length - 1][0];
};

const PORTS = ['INNSA', 'INMAA', 'INMUN', 'CNSHA', 'SGSIN', 'AEJEA', 'USNYC', 'NLRTM', 'DEHAM'] as const;
const header = [
  'tenant_id',
  'shipment_no',
  'trade_type',
  'origin_port',
  'destination_port',
  'container_count',
  'chargeable_weight',
  'customer_id',
  'status',
  'billing_currency',
  'is_billed',
];

const lines = [header.join(',')];
for (let i = 1; i <= count; i++) {
  const tenant = rnd() < 0.9 ? 'tnt_demo' : 'tnt_acme';
  const origin = weighted<string>([['INNSA', 0.3], ['INMAA', 0.1], ['CNSHA', 0.15], ['SGSIN', 0.1], [pick(PORTS), 0.35]]);
  let dest = pick(PORTS);
  while (dest === origin) dest = pick(PORTS);
  const status = weighted<string>([
    ['booked', 0.3],
    ['in_transit', 0.4],
    ['arrived', 0.2],
    ['delivered', 0.1],
  ]);
  const weight = rnd() < 0.05 ? '' : (500 + rnd() * 24500).toFixed(3);
  const currency = weighted<string>([
    ['USD', 0.45],
    ['INR', 0.35],
    ['EUR', 0.15],
    ['AED', 0.05],
  ]);
  lines.push(
    [
      tenant,
      `SHP-${String(i).padStart(6, '0')}`,
      origin.startsWith('IN') ? 'export' : 'import',
      origin,
      dest,
      1 + Math.floor(rnd() * 6),
      weight,
      `CUST-${String(1 + Math.floor(rnd() * 50)).padStart(3, '0')}`,
      status,
      currency,
      rnd() < 0.05 ? 'true' : 'false',
    ].join(','),
  );
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n') + '\n');
console.log(`Wrote ${count} shipments to ${out}`);
