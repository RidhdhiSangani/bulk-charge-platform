// k6 load test: one apply_charge job over a tenant's whole shipment set, polled to completion.
//   k6 run loadtest/bulk-charge.js
//   k6 run -e BASE_URL=http://localhost:3000 -e TENANT=tnt_demo loadtest/bulk-charge.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const TENANT = __ENV.TENANT || 'tnt_demo';
const entitiesPerMin = new Trend('entities_per_min');

export const options = { vus: 1, iterations: 1, thresholds: { entities_per_min: ['avg>1000'] } };

export default function () {
  const code = `K6${Date.now().toString(36).toUpperCase()}`;
  const res = http.post(
    `${BASE}/v1/bulk-jobs`,
    JSON.stringify({
      tenant_id: TENANT,
      action_type: 'apply_charge',
      entity_type: 'shipment',
      filter: {},
      params: { charge_code: code, basis: 'per_container', rate: 25, currency: 'USD' },
    }),
    { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': code } },
  );
  check(res, { 'job created (201)': (r) => r.status === 201 });
  const id = res.json('id');

  let job = res.json();
  for (let i = 0; i < 1800 && !['completed', 'cancelled', 'failed'].includes(job.status); i++) {
    sleep(1);
    job = http.get(`${BASE}/v1/bulk-jobs/${id}`).json();
    console.log(`${job.status} ${job.progress.processed}/${job.total_matched} (${job.progress.throughput_per_min}/min)`);
  }
  check(job, { 'job completed': (j) => j.status === 'completed' });

  const ms = new Date(job.completed_at).getTime() - new Date(job.started_at).getTime();
  const perMin = (job.progress.processed / ms) * 60000;
  entitiesPerMin.add(perMin);
  console.log(`processed ${job.progress.processed} entities in ${(ms / 1000).toFixed(2)}s = ${Math.round(perMin)} entities/min`);
}
