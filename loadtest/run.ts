/**
 * Load test without extra tooling: creates one apply_charge job over every shipment of a tenant
 * (fresh charge_code each run, so nothing is skipped), polls progress, and reports throughput.
 *
 *   npm run loadtest                                     # http://localhost:3000, tnt_demo
 *   BASE_URL=http://host:3000 TENANT=tnt_demo npm run loadtest
 *
 * Throughput is capped by TENANT_RATE_LIMIT_PER_MIN (default 5000/min). To measure raw engine
 * throughput, start the stack with a higher limit, e.g. TENANT_RATE_LIMIT_PER_MIN=1000000.
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const TENANT = process.env.TENANT ?? 'tnt_demo';

type Job = {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  total_matched: number | null;
  progress: { processed: number; success: number; failed: number; skipped: number; throughput_per_min: number | null };
  batches?: Record<string, number>;
};

async function main() {
  const code = `LOAD${Date.now().toString(36).toUpperCase()}`;
  const res = await fetch(`${BASE}/v1/bulk-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': code },
    body: JSON.stringify({
      tenant_id: TENANT,
      action_type: 'apply_charge',
      entity_type: 'shipment',
      filter: {},
      params: { charge_code: code, basis: 'per_container', rate: 25, currency: 'USD' },
    }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const created = (await res.json()) as Job;
  console.log(`job ${created.id} (charge_code ${code}) created`);

  const t0 = Date.now();
  let job: Job = created;
  while (!['completed', 'cancelled', 'failed'].includes(job.status)) {
    await new Promise((r) => setTimeout(r, 1000));
    job = (await (await fetch(`${BASE}/v1/bulk-jobs/${created.id}`)).json()) as Job;
    const s = ((Date.now() - t0) / 1000).toFixed(0).padStart(3);
    console.log(
      `t=${s}s ${job.status.padEnd(9)} ${job.progress.processed}/${job.total_matched ?? '?'} ` +
        `rate=${job.progress.throughput_per_min ?? '-'}/min batches=${JSON.stringify(job.batches ?? {})}`,
    );
  }

  const ms = new Date(job.completed_at!).getTime() - new Date(job.started_at!).getTime();
  const perMin = Math.round((job.progress.processed / ms) * 60_000);
  console.log('\n=== result ===');
  console.log(`status          ${job.status}`);
  console.log(`entities        ${job.progress.processed} (success ${job.progress.success}, failed ${job.progress.failed}, skipped ${job.progress.skipped})`);
  console.log(`wall time       ${(ms / 1000).toFixed(2)} s (started_at → completed_at)`);
  console.log(`throughput      ${perMin.toLocaleString()} entities/min`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
