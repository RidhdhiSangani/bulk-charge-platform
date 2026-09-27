#!/usr/bin/env bash
# Crash test: kill -9 the worker in the middle of a job, restart it, and prove that every
# shipment was processed exactly once (no lost work, no double charge).
#
# Prereq: the stack is running (docker compose up -d --build). Run from the repo root:
#   npm run chaos            or   ./scripts/chaos-test.sh
#
# Env overrides: BASE_URL (default http://localhost:3000), TENANT (default tnt_demo),
#                KILL_AFTER_SECONDS (default 6)
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TENANT="${TENANT:-tnt_demo}"
KILL_AFTER="${KILL_AFTER_SECONDS:-6}"
CODE="CHAOS$(date +%s)"
psql_q() { docker compose exec -T postgres psql -U shipmnts -d bulk_charge -tAc "$1"; }
field() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

restore_worker() {
  echo "→ restoring worker to normal settings"
  docker compose up -d worker >/dev/null 2>&1 || true
}
trap restore_worker EXIT

echo "→ restarting worker in slow mode (20 ms/entity, lease TTL 10 s) so the kill lands mid-batch"
BULK_DEBUG_ENTITY_DELAY_MS=20 LEASE_TTL_SECONDS=10 docker compose up -d worker >/dev/null 2>&1
sleep 5

echo "→ creating apply_charge job (charge_code $CODE) over every $TENANT shipment"
JOB=$(curl -fsS -X POST "$BASE_URL/v1/bulk-jobs" -H 'Content-Type: application/json' \
  -d "{\"tenant_id\":\"$TENANT\",\"action_type\":\"apply_charge\",\"entity_type\":\"shipment\",\"filter\":{},
       \"params\":{\"charge_code\":\"$CODE\",\"basis\":\"flat\",\"rate\":10,\"currency\":\"USD\"}}" | field 'd["id"]')
echo "  job $JOB"

sleep "$KILL_AFTER"
echo "→ before kill: $(curl -fsS "$BASE_URL/v1/bulk-jobs/$JOB" | field 'str(d["progress"]["processed"])+"/"+str(d["total_matched"])+" processed, batches "+str(d["batches"])')"
echo "→ kill -9 worker (no graceful shutdown)"
docker compose kill -s SIGKILL worker >/dev/null 2>&1
LEASED=$(psql_q "SELECT count(*) FROM job_batches WHERE job_id='$JOB' AND status='leased'")
echo "  batches caught mid-flight (leased): $LEASED"

echo "→ restarting worker; waiting for the job to finish (expect a ~30-40 s pause while leases expire)"
BULK_DEBUG_ENTITY_DELAY_MS=20 LEASE_TTL_SECONDS=10 docker compose up -d worker >/dev/null 2>&1
for _ in $(seq 1 90); do
  STATUS=$(curl -fsS "$BASE_URL/v1/bulk-jobs/$JOB" | field 'd["status"]')
  [ "$STATUS" = "completed" ] && break
  printf "  %s %s\n" "$STATUS" "$(curl -fsS "$BASE_URL/v1/bulk-jobs/$JOB" | field 'str(d["progress"]["processed"])+"/"+str(d["total_matched"])')"
  sleep 4
done

read -r TOTAL PROCESSED COUNTER ENTRIES CHARGES DOUBLE RETRIED <<<"$(psql_q "
SELECT (SELECT total_matched FROM bulk_jobs WHERE id='$JOB'),
       (SELECT success_count+failed_count+skipped_count FROM bulk_jobs WHERE id='$JOB'),
       (SELECT success_count FROM bulk_jobs WHERE id='$JOB'),
       (SELECT count(*) FROM job_entries WHERE job_id='$JOB' AND outcome='success'),
       (SELECT count(*) FROM shipment_charges WHERE charge_code='$CODE'),
       (SELECT count(*) FROM (SELECT shipment_id FROM shipment_charges WHERE charge_code='$CODE'
                              GROUP BY 1 HAVING count(*) > 1) d),
       (SELECT count(*) FROM job_batches WHERE job_id='$JOB' AND attempt_count > 1)" | tr '|' ' ')"

echo
echo "status=$STATUS total=$TOTAL processed=$PROCESSED success_counter=$COUNTER success_entries=$ENTRIES charges=$CHARGES double_charged=$DOUBLE batches_retried=$RETRIED"
if [ "$STATUS" = "completed" ] && [ "$PROCESSED" = "$TOTAL" ] && [ "$COUNTER" = "$ENTRIES" ] \
   && [ "$ENTRIES" = "$CHARGES" ] && [ "$DOUBLE" = "0" ]; then
  echo "✅ PASS  processed $PROCESSED/$TOTAL · success entries $ENTRIES = counter $COUNTER = charges $CHARGES · double-charged 0 · batches retried $RETRIED"
else
  echo "❌ FAIL  see numbers above"
  exit 1
fi
