# VPS Bootstrap And Deploy

This folder contains scripts for quickly preparing a new VPS for the ERP stack:
Traefik, PostgreSQL, Hasura, backend, freecut (cut optimizer), cad-service
(SVG/DXF milling layouts), and the Bitrix24 CRM integration.

Production source branch is `main`. Pull, build, and deploy production ERP code
from `main`; `feat/backend-erp-prevprod` is retired. Stage integration remains on
`feat/backend-erp-stage1`.

Russian from-scratch deployment runbook for the WHOLE complex (all of the
above) is maintained in the workspace spec folder:
`../spec_erp/docs/operations/full-stack-vps-deployment-from-scratch.ru.md`.
For day-to-day operation of the merged stack use `ops/up-all.sh` (see below).

No real secrets are stored here. Copy `ops/templates/env.vps.example` to `.env`
on the VPS and fill real values there. `.env` is ignored by git.

## Docker Compose Source Of Truth

The tracked Compose source-of-truth is
`ops/templates/docker-compose.vps.yml`. The tracked env shape is
`ops/templates/env.vps.example`.

Bitrix24 sync remains disabled until an administrator-created incoming webhook
for `mebelkz.bitrix24.kz` and a numeric payment-system ID are configured. The
webhook needs CRM plus sale/payment access; keep its complete URL only in `.env`.
Keep `BITRIX24_REQUEST_TIMEOUT_MS` below
`BACKEND_BITRIX24_SYNC_LEASE_MS`; startup validation rejects an unsafe pair.
The default REST admission rate is two requests/second. Limit errors publish a
shared cooldown; only explicit `QUERY_LIMIT_EXCEEDED` and
`OPERATION_TIME_LIMIT` responses are retried.

Safe first rollout order:

1. Apply migrations through
   `087_bitrix24_backfill_checkpoint.sql`.
2. Build/recreate the backend with the webhook, payment-system ID,
   `BACKEND_ENABLE_BITRIX24_SYNC=true`, and
   `BACKEND_BITRIX24_SYNC_RELAY_OWNER=external`. This paused owner prevents the
   in-process scheduler from writing before approval.
3. Run the repository command
   `npm run test:e2e:bitrix24-sync-stage-canary`; it is read-only and refuses
   non-`erp_test` container names.
4. Run
   `npm --prefix backend run crm-sync:backfill -- --dry-run --scope clients`,
   inspect the projection, then run the live `--scope clients` backfill.
   `--scope` is mandatory. A failed live run resumes its durable DB cursor;
   use `--restart` only for an intentional fresh pass.
5. Inspect Contact/Company data in Bitrix24 and obtain explicit approval before
   importing orders and payments.
6. Run dry/live `--scope all`. A completed `clients` checkpoint is separate;
   `all` intentionally verifies clients again before Deals/payments.
7. Only after the `all` backfill succeeds, recreate exactly one backend with
   `BACKEND_BITRIX24_SYNC_RELAY_OWNER=in_process`.

CRM API deletes move Contact/Company/Deal records to the Bitrix24 recycle bin.
If storage must be released immediately, an administrator must disable the
recycle bin for those CRM types or empty it manually; the sync never tries an
undocumented permanent-delete endpoint.

On a fresh VPS, `ops/setup-vps.sh`/`ops/deploy-stack.sh` create the live
`docker-compose.yml` from that template when the live file is missing. The live
file sits next to `.env`, `data/`, `config/`, `backups/`, and `restore/`.

You can also run the tracked template directly. In that mode, keep `.env` in
the runtime root passed as `--project-directory`; Compose also resolves
`data/`, `config/`, `backups/`, and `restore/` from that same root. The
`--env-file` path should point to that `.env` explicitly.

Rules:

- Commit non-secret stack changes to `ops/templates/docker-compose.vps.yml`.
- Commit new env keys with safe defaults/placeholders to
  `ops/templates/env.vps.example`.
- Keep real values only in the VPS `.env`.
- Set `ERP_STACK_ENV=test|prod` explicitly. Test deploys load
  `docker-compose.test.yml` and keep `CNC_TELEGRAM_WORKER_ROLE=disabled`;
  prod deploys load `docker-compose.prod.yml` and may run
  `CNC_TELEGRAM_WORKER_ROLE=writer`.
- If the live VPS Compose file needs a machine-local path or bind override, keep
  that override out of secrets and mirror any general service/env change back
  into the tracked template.
- Backend runtime flags such as `BACKEND_ENABLE_PRODUCTION_ACTIONS` belong to
  the VPS backend service; frontend runtime flags such as
  `RUNTIME_CONFIG_BACKEND_PRODUCTION_ACTIONS` belong to the Vercel frontend
  project.
- Basis-cut rollout uses `BACKEND_ENABLE_BAZIS_CUT` on the backend and
  `RUNTIME_CONFIG_BAZIS_CUT` on Vercel. The frontend also requires
  `RUNTIME_CONFIG_BACKEND_CUT=true`; rollback disables `BAZIS_CUT` first.
- `BACKEND_BUILD_CONTEXT` controls where the backend Dockerfile is read from.
  Keep `./backend` for a normal one-repo checkout. Use `./repo_erp/backend` for
  the current split VPS layout where the runtime root contains `repo_erp/`,
  `.env`, `data/`, and `config/`.

After backend-only Compose/env changes, rebuild and recreate only the backend
service:

```bash
docker compose --env-file .env -f docker-compose.yml up -d --build --no-deps backend
```

Direct-template equivalent for the current split VPS layout:

```bash
cd ~/projects/erp_dev

# in ~/projects/erp_dev/.env:
# BACKEND_BUILD_CONTEXT=./repo_erp/backend

docker compose \
  --env-file .env \
  --project-directory . \
  -f repo_erp/ops/templates/docker-compose.vps.yml \
  up -d --build --no-deps backend
```

## up-all.sh — whole-complex wrapper

`ops/up-all.sh` is a single entry point for the full `erp_test` complex. It
hard-codes the fixed flags that every operation on this project needs:
`--project-directory <runtime-root>`, `-p erp_test`, `--env-file .env`, and
the tracked `docker-compose.vps.yml`. This prevents running from the wrong
directory, which would render traefik labels and build contexts from empty env.

The file defines `freecut` (cut optimizer) and `cad-service` (SVG/DXF milling
layouts) alongside the core stack, so they come up with the rest. If `.env`
sets `COMPOSE_PROFILES=cnc-telegram`, it also starts the internal Telethon
`cnc-telegram-worker`.

```bash
cd ~/projects/erp_dev

repo_erp/ops/up-all.sh up                  # bring up / update the whole complex
repo_erp/ops/up-all.sh rebuild backend     # rebuild + restart one service
repo_erp/ops/up-all.sh rebuild cad-service # SVG/DXF service
repo_erp/ops/up-all.sh rebuild freecut     # cut optimizer
repo_erp/ops/up-all.sh ps                  # status
repo_erp/ops/up-all.sh logs backend        # tail logs
repo_erp/ops/up-all.sh config              # render merged config (dry check)
```

The wrapper self-locates its runtime root (three levels up from the script), so
it can be invoked from any directory. It refuses a bare `down`/`stop` (that
would stop ERP); use the `-- <raw args>` escape hatch for deliberate one-off
compose subcommands. Preflight checks (`.env` present and no `REPLACE_ME`
placeholders) are warn-only, since `erp_test` is the test contour.

### CNC Telegram worker

Enable in `.env`:

```env
BACKEND_ENABLE_CNC_TELEGRAM=true
COMPOSE_PROFILES=cnc-telegram
TELEGRAM_API_ID=<api-id>
TELEGRAM_API_HASH=<api-hash>
TELEGRAM_CHAT=<chat-id-or-username>
TELEGRAM_ALLOWED_CHAT_ID=<expected-chat-id>
ERP_WORKER_LOGIN=<erp-user-with-cut.manage>
ERP_WORKER_PASSWORD=<password>
```

The same profile starts GLM-OCR:

- `glm-ocr-model-init`: downloads `GLM-OCR-Q8_0.gguf` and
  `mmproj-GLM-OCR-Q8_0.gguf` into a Docker volume once;
- `glm-ocr-llama`: `ghcr.io/ggml-org/llama.cpp:server` loading local files;
- `glm-ocr-runner`: internal `/ocr` wrapper returning structured JSON;
- `cnc-telegram-worker`: default OCR command calls `glm-ocr-runner`.

One-time Telethon login:

```bash
repo_erp/ops/cnc-telegram-worker.sh login
```

Manual backfill:

```bash
repo_erp/ops/cnc-telegram-worker.sh backfill 7
```

Logs:

```bash
repo_erp/ops/cnc-telegram-worker.sh logs
```

`deploy-stack.sh` loads a target overlay from `ERP_STACK_ENV`:
`ops/templates/docker-compose.test.yml` or
`ops/templates/docker-compose.prod.yml`. It also handles old live
`docker-compose.yml` files: when `COMPOSE_PROFILES=cnc-telegram` is enabled
but the live file has no `cnc-telegram-worker`, it adds
`ops/templates/docker-compose.cnc-telegram-worker.yml` as an overlay for that
deploy run.

For one shared CNC Telegram chat, keep exactly one writer. Prod `.env`:
`ERP_STACK_ENV=prod`, `COMPOSE_PROFILES=cnc-telegram`,
`BACKEND_ENABLE_CNC_TELEGRAM=true`, `CNC_TELEGRAM_WORKER_ROLE=writer`.
Test `.env`: `ERP_STACK_ENV=test`, `CNC_TELEGRAM_WORKER_ROLE=disabled`.

## gen-secrets.sh, ensure-build-repos.sh, up-all.sh provision

`gen-secrets.sh` fills the cryptographic `REPLACE_ME_*` placeholders in `<root>/.env`
(idempotent; never overwrites set values; prints the CAD basic-auth password once;
leaves domains/email and external integration credentials for the operator).

`ensure-build-repos.sh` clones `repo_freecut` and `repo_svgdxf` next to `repo_erp`
if missing (`--dry-run` supported). Closes the cad-service clone gap that
`setup-vps.sh` (freecut-only) leaves open.

`up-all.sh provision` is the first-time orchestrator: ensure-build-repos →
check-env → bring up the whole complex → Hasura
metadata → smoke. DB migrations are gated behind `--migrate <apply|baseline|skip>`
(default `skip`, printing the exact follow-up command). Hasura metadata defaults
to `--hasura bundled` (imports `ops/hasura/metadata.json`); override with
`track`, `apply:PATH`, or `skip`. `--dry-run` prints the ordered plan without
running anything. This is the scripted path; the manual step-by-step is the
"First VPS Run" section below.

`ops/hasura/metadata.json` is a captured baseline of the live Hasura metadata
(`version 3`, all tracked tables + role permissions, no secret values) that
provision imports on a fresh instance. Refresh it after metadata changes with
`ops/export-hasura-metadata.sh` (reads the admin secret inside the Hasura
container; never prints it; `--dry-run` supported).

## apply-migrations.sh — ledgered DB migration runner

The backend has no built-in migration runner; schema lands from a DB dump
restore or by applying `backend/db/migrations/[0-9]*.sql` in order.
`ops/apply-migrations.sh` does the latter safely, tracking applied files in a
`schema_migrations` ledger so re-runs are idempotent. It reaches Postgres via
`docker exec` and resolves the user/db from the container env, so no DB password
enters the host shell.

```bash
cd ~/projects/erp_dev/repo_erp

ops/apply-migrations.sh                      # dry-run (default): what is pending? read-only
ops/apply-migrations.sh status               # applied vs pending + checksum drift, read-only
ops/apply-migrations.sh apply --yes          # apply pending in order, record in ledger
ops/apply-migrations.sh apply --to 032 --yes # apply pending only up to v032, then stop
ops/apply-migrations.sh baseline --yes       # adopt the ledger on an ALREADY-migrated DB
ops/apply-migrations.sh mark-applied --upto 005 --yes  # restored dump already at v005
ops/apply-migrations.sh mark-applied 003 --yes         # skip a single migration (003)
```

Run `baseline` once on a DB migrated as a whole before this ledger existed.
For a restored dump that is only PARTIALLY ahead (real/legacy prod baseline),
`mark-applied --upto NNN` records 001..NNN as applied with REAL checksums (no
false drift), and `mark-applied <version|filename>` marks/skips a single one
(e.g. `003` when prod's `orders_view` is newer). `apply --to NNN` stops after
version NNN — use it to halt before the destructive Variant-B 033/034 while you
extend the conversion map. Selection excludes the manual Variant-B side files
(`*_preflight/_verify/_rollback.sql`) and `*.test.ts`. Override the target with
`--container`, `--user`, `--db`, `--dir`.

### auto — one command for a freshly restored prod dump

`auto` replaces the whole manual "path 1b" chain (detect dump level →
mark-applied → delta → Variant B coverage/preflight/verify → view-drift DROP →
sequence realign) with a single fail-closed, idempotent run:

```bash
ops/apply-migrations.sh auto --detect-only   # read-only: per-file PRESENT/PENDING report
ops/apply-migrations.sh auto --yes           # bring the restored dump to the current head
ops/apply-migrations.sh auto --yes --auto-map  # + heuristic conversion-map fill (Variant B)
```

What it does per run:

1. Refuses an empty DB (greenfield → `apply`); an empty-but-restored `orders`
   needs the explicit `--assume-restored`.
2. Probes the EFFECT of every migration file in the dump (per-file probes —
   mid-history holes like the 036/047 incidents are detected honestly) and
   `mark-applied`s what is already there. `003` is never executed on the
   restore path (034 rebuilds `orders_view` canonically).
3. Applies the pending delta in order. `CREATE OR REPLACE VIEW` column-drift
   errors are auto-healed (allowlisted ERP views, dependency check, one retry).
4. Variant B gate before 034: uncovered legacy materials abort with a
   ready-to-review `conversion-map-candidates.sql` artifact; `--auto-map`
   applies those heuristic rows itself and records a `zz_automap_*` ledger
   provenance row. Placement decides cuttability: a material used on order
   DETAILS is always mapped cuttable (known sheet names get real dims;
   unknown names get SENTINEL 1×1×1 dims — list them later via
   `SELECT * FROM sheet_material_types WHERE width_mm = 1` and fill real
   sizes in the SP1 UI); header-only materials stay non-cuttable. Then `034_preflight.sql` is machine-checked, 034 applied, and
   `034_verify.sql` asserted — the 034 ledger entry is written ONLY after
   verify passes; a verify failure writes a persistent `zz_hard_stop_*`
   sentinel that blocks ALL mutating modes until `auto --clear-hard-stop`.
5. The 041 Bazis-layout reset is decided at its slot: fresh label
   infrastructure → runs; pre-existing or case-drifted live templates →
   operator decision (`--skip-041` keep layouts / `--run-041-reset`).
6. Realigns identity sequences (post-restore dup-PK guard) and requires
   `pending: 0` to exit 0. Artifacts (detection report, candidates, preflight/
   verify output) land in `--artifacts DIR` (default
   `<project>/backups/migration-auto-<UTC>/`).

`up-all.sh provision --migrate auto` wires it into the one-command provision.
Rehearsal suite: `npx vitest run --config vitest.migration-auto-integration.config.ts`
(scratch DB in the erp_test postgres container).

## One Script Flow

Use one command on the VPS:

```bash
cd ~/projects/erp_dev/repo_erp
sudo ops/setup-vps.sh
```

On the first run it installs Docker, prepares folders, creates `.env`, and then
stops because placeholders are still present. Fill `.env`, make sure DNS points
to the VPS, then run the same command again:

```bash
cd ~/projects/erp_dev/repo_erp
sudo ops/setup-vps.sh
```

The second run validates `.env`, checks DNS, deploys the stack, runs smoke
checks, and runs the backend/frontend/e2e test suite. If you want
non-interactive deploy after `.env` is filled:

```bash
sudo ops/setup-vps.sh --yes
```

## Files

- `setup-vps.sh` - the single entrypoint for normal VPS setup.
- `templates/docker-compose.vps.yml` - self-host compose file for this repo.
- `templates/env.vps.example` - safe placeholder env template.
- `templates/pg_hba.vps.conf` - PostgreSQL access rules for Docker and Tailscale.
- `bootstrap-vps.sh` - installs Docker, opens firewall ports, creates folders.
- `check-env.sh` - validates `.env`, CORS origins, placeholders, optional DNS.
- `deploy-stack.sh` - creates missing templates and starts/rebuilds the stack.
- `smoke-vps.sh` - checks HTTPS health endpoints, Hasura CORS preflight, and
  deadline live-schema drift when deadlines are enabled.
- `restore-prod-backup.sh` - destructive DB restore helper for a fresh backup.
- `reset-test-vps.sh` - separate opt-in destructive reset for a dedicated test
  VPS: stops the stack/tests, cleans Docker state, reclones the repo, and
  restores `.env`/`restore/` from a temporary backup.
- `apply-hasura-metadata.sh` - applies Hasura `metadata.json`.
- `track-hasura-public-schema.sh` - tracks restored public tables/views in Hasura.
- `run-vps-tests.sh` - installs npm dependencies in Docker volumes and runs
  backend Vitest, frontend/serverless Vitest, and Playwright e2e.

## Freecut Optimization Service

`freecut` is the Rust 2D cut-optimization service. It is built from the sibling
verified `repo_freecut` checkout (fixed build-context `./repo_freecut`; overrides are rejected)
and comes up automatically with the rest of the stack. It is **internal-only**:
attached to the `back` network with no Traefik route and no public domain, so it
is not reachable from the browser. The backend cut module (`modules/cut`) calls
it at `http://freecut:8088` over the internal network (`FREECUT_BASE_URL` with
`FREECUT_OPTIMIZE_TIMEOUT_MS` on the backend side).

The service is standalone (no DB/Hasura/Valkey dependency), so it has no
`depends_on` and starts in parallel. Tuning knobs live in `.env` as
`FREECUT_*` (body/instance/time/restart limits, `FREECUT_MAX_CONCURRENT_OPTIMIZE`,
`FREECUT_OPTIMIZE_QUEUE_WAIT_MS` — keep it below the backend
`FREECUT_OPTIMIZE_TIMEOUT_MS`, `FREECUT_CPUS`, `FREECUT_MEM_LIMIT`); none are
secrets.

Rebuild/recreate only freecut after a source or env change:

```bash
docker compose --env-file .env -f docker-compose.yml up -d --build --no-deps freecut
```

Verify from inside the network (no host port is published):

```bash
docker compose exec freecut curl -fsS http://localhost:8088/health/live
docker compose exec freecut curl -fsS http://localhost:8088/version
```

Note: the first build compiles the Rust release binary and can take several
minutes. `repo_freecut` must be checked out next to `repo_erp` under the
runtime root for the default build context to resolve; `setup-vps.sh` and
`reset-test-vps.sh` clone it automatically when missing (override with
`FREECUT_REPO_URL`).

On an existing VPS that already has a `docker-compose.yml` copied before
freecut was added, `setup-vps.sh` will not overwrite it (templates are copied
only when missing). Add the freecut service from
`templates/docker-compose.vps.yml` to the live compose file and clone
`repo_freecut` next to `repo_erp` before recreating the stack.

## When Domains Are Needed

Choose domains before the first `deploy-stack.sh` run.

The domains must already have DNS `A` records pointing to the new VPS before
the first deploy. Traefik requests Let's Encrypt certificates during startup,
and the HTTP challenge requires ports `80` and `443` on the new VPS to be
reachable by those exact domains.

Use these formats in `.env`:

```env
HASURA_FQDN=hasura-test.example.com
BACKEND_FQDN=backend-test.example.com
FRONTEND_ORIGIN=https://app-test.example.com
HASURA_GRAPHQL_CORS_DOMAIN=https://app-test.example.com
BACKEND_CORS_ALLOWED_ORIGINS=https://app-test.example.com
```

Rules:

- `HASURA_FQDN` and `BACKEND_FQDN` are hostnames only: no `https://`, no slash.
- `FRONTEND_ORIGIN` includes scheme and hostname: no trailing slash.
- The same `FRONTEND_ORIGIN` must be present in both Hasura and backend CORS.
- If a frontend domain changes later, update `.env` and recreate `hasura` and
  `backend`:

```bash
docker compose --env-file .env -f docker-compose.yml up -d --force-recreate hasura backend
```

## First VPS Run

On the new VPS:

```bash
mkdir -p ~/projects/erp_dev/spec_erp
git clone <repo-url> ~/projects/erp_dev/repo_erp
cd ~/projects/erp_dev/repo_erp
sudo ops/setup-vps.sh
```

`setup-vps.sh` clones the sibling `repo_freecut` into
`~/projects/erp_dev/repo_freecut` automatically when it is missing, so the
freecut service can build in the same pass. Override the source with
`FREECUT_REPO_URL` if needed. To pre-place or pin it manually:

```bash
git clone https://github.com/zorgoalex/freecut_api.git \
  ~/projects/erp_dev/repo_freecut
```

Fill `.env`:

```bash
nano ~/projects/erp_dev/.env
```

Generate new secrets on the VPS:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

Use unique values for:

- `PG_PASSWORD`
- `HASURA_MD_PASSWORD`
- `HASURA_ADMIN_SECRET`
- `HASURA_JWT_SECRET`
- `BACKEND_REFRESH_TOKEN_PEPPER`

After DNS is configured and `.env` is filled, run the same setup script:

```bash
cd ~/projects/erp_dev/repo_erp
sudo ops/setup-vps.sh
```

If DNS has not propagated but you know the target IP:

```bash
cd ~/projects/erp_dev/repo_erp
sudo ops/setup-vps.sh --expected-ip <VPS_PUBLIC_IP>
```

The setup script runs all test suites after a successful deploy/restore/smoke.
For an emergency deploy where tests must be skipped explicitly:

```bash
sudo ops/setup-vps.sh --yes --skip-tests
```

To run the same VPS test suite manually:

```bash
cd ~/projects/erp_dev/repo_erp
ops/run-vps-tests.sh --env-file ../.env
```

## Dedicated Test VPS Reset

`ops/setup-vps.sh` does not wipe Docker state or reclone the repository. For a
full clean rebuild on a dedicated test VPS, run the reset script explicitly:

```bash
cd ~/projects/erp_dev/repo_erp
sudo ops/reset-test-vps.sh --confirm erp_test --yes \
  --all-docker \
  --prune-images \
  --prune-builder
```

The `--confirm` value must match `COMPOSE_PROJECT_NAME` from `.env`. The script
backs up the current `.env` and `restore/`, removes the checkout, reclones the
current branch from `origin`, restores those files, and then stops. It does not
run `setup-vps.sh`; run deploy/restore/test after the reset:

```bash
sudo ops/setup-vps.sh --yes \
  --expected-ip <VPS_PUBLIC_IP> \
  --restore-backup restore \
  --require-restore-backup
```

If a DB backup is already uploaded to the VPS and should be restored during
setup, pass either a dump file or a directory:

```bash
sudo ops/setup-vps.sh --yes --restore-backup restore
```

`--restore-backup` runs after the stack is deployed and before smoke checks.
When the path is a directory, the script picks the newest `*.dump`,
`*.backup`, or `*.pgdump` file, excluding `pre_restore` and `logs`. If a
matching `*global*.sql` or `*global*.sql.gz` file is present in the same
directory tree, globals are restored too. If a `metadata.json` or archive
containing `metadata.json` is present near the backup, Hasura metadata is
applied after the DB restore. You can also pass it explicitly:

```bash
sudo ops/setup-vps.sh --yes \
  --restore-backup restore \
  --hasura-metadata restore/hasura_metadata.tar.gz
```

Supported metadata inputs are `metadata.json`, `.tar`, `.tar.gz`, `.tgz`, and
`.zip` archives containing `metadata.json`. The script uses
`HASURA_ADMIN_SECRET` from `.env`.

If no metadata is found, the script falls back to tracking public tables/views
in Hasura metadata so GraphQL exposes the restored schema. Missing backup path
or empty backup directory is a non-fatal skip by default; use strict mode when
the restore must happen:

```bash
sudo ops/setup-vps.sh --yes --restore-backup restore --require-restore-backup
```

## Frontend/Vercel Values

For a frontend that talks directly to this VPS stack, set:

```env
VITE_HASURA_GRAPHQL_URL=https://<HASURA_FQDN>/v1/graphql
VITE_API_URL=https://<BACKEND_FQDN>
```

Backend feature flags are controlled by the existing frontend flags, for
example:

```env
VITE_USE_BACKEND_AUTH=true
VITE_USE_BACKEND_PERMISSIONS=true
VITE_USE_BACKEND_ORDERS_READ=true
VITE_USE_BACKEND_ORDERS_WRITE=true
VITE_USE_BACKEND_PAYMENTS=true
VITE_USE_BACKEND_PRODUCTION_ACTIONS=true
VITE_USE_BACKEND_USERS=true
VITE_USE_BACKEND_ORDER_EXPORT=true
VITE_USE_BACKEND_VLM=true
```

On Vercel runtime-config deployments, use matching `RUNTIME_CONFIG_*` keys, for
example `RUNTIME_CONFIG_BACKEND_PRODUCTION_ACTIONS=true`. Do not set backend
server flags such as `BACKEND_ENABLE_PRODUCTION_ACTIONS` in the frontend Vercel
project unless that project is actually running the NestJS backend.

## Updating An Existing VPS

```bash
cd ~/projects/erp_dev/repo_erp
git switch main
git pull --ff-only origin main
sudo ops/setup-vps.sh --yes
```

If only backend code or backend Compose/env flags changed:

```bash
cd ~/projects/erp_dev
git -C repo_erp switch main
git -C repo_erp pull --ff-only origin main
docker compose --env-file .env -f docker-compose.yml up -d --build --no-deps backend
repo_erp/ops/smoke-vps.sh --project-dir . --env-file .env --compose-file docker-compose.yml
```

When `BACKEND_ENABLE_DEADLINES=true`, `smoke-vps.sh` also checks the live
business DB for `deadline_events.idempotency_key` and
`uq_deadline_events_idempotency_key`. This prevents deploying deadline-enabled
backend code against a database that has not received the additive Deadline
Engine idempotency migration.

If you are running the tracked template directly from the parent runtime root:

```bash
cd ~/projects/erp_dev
git -C repo_erp pull
docker compose \
  --env-file .env \
  --project-directory . \
  -f repo_erp/ops/templates/docker-compose.vps.yml \
  up -d --build --no-deps backend
repo_erp/ops/smoke-vps.sh --project-dir . --env-file .env --compose-file docker-compose.yml
```

If only CORS/domain variables changed:

```bash
cd ~/projects/erp_dev/repo_erp
ops/setup-vps.sh --skip-bootstrap --skip-deploy
cd ..
docker compose --env-file .env -f docker-compose.yml up -d --force-recreate hasura backend
repo_erp/ops/smoke-vps.sh --project-dir . --env-file .env --compose-file docker-compose.yml
```

## Restoring A Production Backup

Upload the backup to the VPS, for example into `~/projects/erp_dev/restore`.

For the normal one-script flow, prefer:

```bash
cd ~/projects/erp_dev/repo_erp
sudo ops/setup-vps.sh --yes --restore-backup restore --require-restore-backup
```

Then run:

```bash
ops/restore-prod-backup.sh \
  --project-dir "$HOME/projects/erp_dev" \
  --env-file "$HOME/projects/erp_dev/.env" \
  --compose-file "$HOME/projects/erp_dev/docker-compose.yml" \
  --main-dump "$HOME/projects/erp_dev/restore/latest.dump" \
  --confirm-db erpdb
```

With globals:

```bash
ops/restore-prod-backup.sh \
  --project-dir "$HOME/projects/erp_dev" \
  --env-file "$HOME/projects/erp_dev/.env" \
  --compose-file "$HOME/projects/erp_dev/docker-compose.yml" \
  --main-dump "$HOME/projects/erp_dev/restore/latest.dump" \
  --globals-dump "$HOME/projects/erp_dev/restore/globals.sql.gz" \
  --restore-globals \
  --confirm-db erpdb
```

The restore script stops Hasura, creates a pre-restore dump when the target DB
already exists, drops/recreates `PG_DB`, restores the dump, then starts Hasura.
`setup-vps.sh --restore-backup ...` also applies Hasura metadata when supplied
or found near the backup. Without a metadata file it tracks restored public
tables/views as a fallback; this fallback does not replace a full production
Hasura metadata backup for custom relationships or permission rules.

## Common Failures

Hasura CORS still fails:

```bash
cd ~/projects/erp_dev
repo_erp/ops/smoke-vps.sh --project-dir . --env-file .env --compose-file docker-compose.yml
docker compose --env-file .env -f docker-compose.yml exec -T hasura printenv HASURA_GRAPHQL_CORS_DOMAIN
```

If the env is correct but the browser still fails, recreate Hasura:

```bash
cd ~/projects/erp_dev
docker compose --env-file .env -f docker-compose.yml up -d --force-recreate hasura
```

Let's Encrypt certificate is not issued:

- Check DNS `A` records for `HASURA_FQDN` and `BACKEND_FQDN`.
- Check VPS firewall allows ports `80` and `443`.
- Check no other service is using ports `80`/`443`.

Backend health fails:

```bash
cd ~/projects/erp_dev
docker compose --env-file .env -f docker-compose.yml logs --tail=200 backend
```

Postgres is not reachable:

- Keep `PG_BIND_IP=127.0.0.1` for local-only DB.
- Use a Tailscale IP only when remote backup/restore/admin access is required.
- Do not use `PG_BIND_IP=0.0.0.0` for production without hardening firewall and
  `pg_hba.conf`.
