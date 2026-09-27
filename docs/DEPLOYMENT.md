# Deployment guide

Three stages: **move the code → push to GitHub → deploy on Render** (with Railway as an alternative). The repository already contains everything needed:

| File | Role |
|---|---|
| [render.yaml](../render.yaml) | A Render Blueprint: creates the web service, Postgres and Key Value (Redis) in one click |
| [Dockerfile](../Dockerfile) + [scripts/docker-start.sh](../scripts/docker-start.sh) | One image. With `MIGRATE_ON_START=true` it migrates and seeds, then starts. |
| [.github/workflows/ci.yml](../.github/workflows/ci.yml) | Typecheck, build, unit + integration tests, and a Docker build on every push |
| [postman/Live.postman_environment.json](../postman/Live.postman_environment.json) | Postman environment for the deployed URL |

---

## 1. Move the project to the other laptop

On **this** laptop, from the folder that *contains* `Shipmnts Task`:
```bash
cd ~/Downloads
zip -r shipmnts-bulk-charge.zip "Shipmnts Task" -x "*/node_modules/*" "*/dist/*" "*/.DS_Store"
```
This keeps the `.git` folder, so your commit history comes along, and leaves out `node_modules`/`dist`, which get rebuilt.

On the **other** laptop:
```bash
unzip shipmnts-bulk-charge.zip && cd "Shipmnts Task"
git status          # "nothing to commit, working tree clean"
git log --oneline   # shows the initial commit
```
Optional: if you want the commits under that laptop's GitHub identity:
```bash
git config user.name "Your Name" && git config user.email "you@example.com"
git commit --amend --reset-author --no-edit
```

## 2. Push to GitHub

1. Go to https://github.com/new.
2. **Repository name:** `bulk-charge-platform`.
3. **Visibility: Public** (recommended). Reviewers can open it without an invite, CI minutes are free, and the README badge works. If you prefer **Private**, add the reviewers under *Settings → Collaborators* afterwards.
4. **Don't** tick "Add a README", ".gitignore" or "license". The repository already has them, and ticking them causes a push conflict.
5. Click **Create repository**, then run:
   ```bash
   git remote add origin https://github.com/<your-user>/bulk-charge-platform.git
   git branch -M main
   git push -u origin main
   ```
   If it asks for credentials, use `gh auth login` (GitHub CLI) or a Personal Access Token as the password (*GitHub → Settings → Developer settings → Tokens*).
6. Open the **Actions** tab. The **CI** workflow runs automatically (~3–4 min) and should turn green: the *test* job (typecheck, build, 16 unit + 17 integration tests) and the *docker* job.

What's deliberately **not** in git (see `.gitignore`): `node_modules`, `dist`, `.env`, and the assignment PDFs.

## 3. Deploy on Render (free, one-click Blueprint)

**Layout on the free plan:** one web service running **API + workers in the same process** (`RUN_WORKERS_IN_API=true`, "combined mode"), plus a free Postgres and a free Key Value (Redis). Render's free tier has no background workers. The engine and its guarantees are identical; only where the consumers run changes.

1. Go to https://dashboard.render.com and **sign up with GitHub**.
2. Click **New +** → **Blueprint**.
3. **Connect** your `bulk-charge-platform` repository. Grant Render access to it if asked.
4. Render reads `render.yaml` and shows three resources:
   - `bulk-charge-api` (Web Service, Docker, Free)
   - `bulk-charge-db` (PostgreSQL, Free)
   - `bulk-charge-redis` (Key Value, Free)

   Give the Blueprint a name (for example `bulk-charge`) and click **Apply** / **Deploy Blueprint**.
5. Wait for the first build (~5–8 min). Open **bulk-charge-api → Logs**. A healthy boot looks like this:
   ```
   [start] applying migrations
   All migrations have been successfully applied.
   [start] seeding (idempotent)
   Seed done: 5000 new shipments inserted (5000 total), 6 FX rates, 2 tenants
   Watchdog scheduled every 15000ms
   API listening on :10000 (docs at /docs) — combined mode: queue workers running in this process
   ```
6. Copy the service URL from the top of the page, for example `https://bulk-charge-api.onrender.com`. Render adds a suffix if the name is taken.

### Verify the live deployment
```bash
URL=https://bulk-charge-api.onrender.com        # yours
curl -s $URL/health                            # {"status":"ok","db":"ok","redis":"ok",...}
open $URL/docs                                 # Swagger UI: try POST /v1/bulk-jobs from the browser
curl -s -X POST $URL/v1/bulk-jobs -H 'Content-Type: application/json' -H 'Idempotency-Key: live-1' \
  -d '{"tenant_id":"tnt_demo","action_type":"apply_charge","entity_type":"shipment",
       "filter":{"origin_port":"INNSA","status":"in_transit"},
       "params":{"charge_code":"FSC","basis":"per_kg","rate":0.12,"currency":"USD"}}'
curl -N $URL/v1/bulk-jobs/<id>/events          # live progress, then "done"
curl -s $URL/v1/bulk-jobs/<id>/summary         # 524 success / 74 failed (same seed as local)
```
**Postman:** import `postman/Live.postman_environment.json`, set `baseUrl` to your URL, select that environment, and run the collection.

### Finish the README
Replace the placeholders at the top of `README.md` (`<your-github-user>`, `<your-service>`, the Loom `<link>`), then:
```bash
git commit -am "docs: live URL, CI badge and Loom link" && git push
```
Render redeploys automatically on every push to `main`.

### Free-tier behaviour to know (and to mention in your email)
| Behaviour | Effect | What to do |
|---|---|---|
| The web service **sleeps after ~15 min idle** | The first request takes ~50 s to wake; jobs that are scheduled don't fire while it's asleep, and run as soon as it wakes (the watchdog catches up) | Open `/health` a minute before a demo or before sending the link. Optionally, a free uptime pinger (for example UptimeRobot) on `/health` every 10 min keeps it awake. |
| **Free Postgres expires after 30 days** | The data is deleted | Enough for the review window; upgrade or recreate the database if needed |
| **Small CPU share** | Throughput is far lower than on a laptop (`WORKER_CONCURRENCY=2`) | The measured numbers in the README are from the local multi-worker stack; say so |
| Key Value (Redis) free: 25 MB, no persistence | Queued work in Redis is lost on a restart | Postgres is the source of truth; the watchdog re-enqueues orphaned batches and jobs |
| No authentication | Anyone with the URL can create jobs | The data is sample data only. Reset it with `node dist/seed/seed.js --reset` from the Render **Shell** tab (paid plans) or by recreating the database. |

Suggested line for the email: *"Live demo: <URL>/docs (Render free tier, so the first request may take ~50 s to wake). It runs API and workers in one process because the free tier has no background workers; `docker compose up --scale worker=3` shows the real multi-worker setup."*

### Troubleshooting (Render)
| Symptom | Fix |
|---|---|
| Deploy fails the health check | Check the Logs. If migrations failed, check that `DATABASE_URL` comes from `bulk-charge-db` (Environment tab). |
| `/health` says `redis: error` | `REDIS_URL` must come from `bulk-charge-redis`; Key Value is internal-only (`ipAllowList: []`), so the web service reaches it over the private network |
| Jobs stay `queued` | The log must contain `combined mode`; check `RUN_WORKERS_IN_API=true` on the service |
| Build fails at `npm ci` | Make sure `package-lock.json` was committed |

## 4. Alternative: Railway

Railway has no always-free tier (it gives trial credit, then about $5/month), but it can run a separate worker service.

1. https://railway.app → **New Project** → **Deploy from GitHub repo** → pick the repository. It builds the `Dockerfile`.
2. In the project: **+ New** → **Database** → **PostgreSQL**; then **+ New** → **Database** → **Redis**.
3. Open the app service → **Variables** and add:
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   MIGRATE_ON_START=true
   RUN_WORKERS_IN_API=true
   ```
   Railway injects `PORT` itself.
4. **Settings → Networking → Generate Domain**. Health check path: `/health`.
5. *(Optional, the real architecture)*: set `RUN_WORKERS_IN_API=false` on the app. Add a second service from the same repo with **Start Command** `node dist/worker.js`, the same `DATABASE_URL` and `REDIS_URL` variables, and no domain. Scale its replicas in Settings.

## 5. Local run on the new laptop (optional)
```bash
docker compose up -d --build && curl localhost:3000/health
npm install            # only needed for npm test / test:e2e / chaos / loadtest
npm run chaos
```
