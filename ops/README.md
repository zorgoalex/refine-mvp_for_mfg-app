# VPS Bootstrap And Deploy

This folder contains scripts for quickly preparing a new VPS for the ERP stack:
Traefik, PostgreSQL, Hasura, backend, freecut (cut optimizer), cad-service
(SVG/DXF milling layouts), and the Twenty CRM overlay.

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
- If the live VPS Compose file needs a machine-local path or bind override, keep
  that override out of secrets and mirror any general service/env change back
  into the tracked template.
- Backend runtime flags such as `BACKEND_ENABLE_PRODUCTION_ACTIONS` belong to
  the VPS backend service; frontend runtime flags such as
  `RUNTIME_CONFIG_BACKEND_PRODUCTION_ACTIONS` belong to the Vercel frontend
  project.
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
**both** compose files (`docker-compose.vps.yml` + `docker-compose.twenty.yml`).
This prevents the classic mistakes: dropping the Twenty overlay (which marks the
CRM as orphan, so a later `--remove-orphans` deletes it) and running from the
wrong directory (which renders traefik labels and build contexts from empty env).

The base file already defines `freecut` (cut optimizer) and `cad-service`
(SVG/DXF milling layouts) alongside the core stack, so they come up with the
rest. Twenty CRM comes up via the overlay the wrapper always passes.

```bash
cd ~/projects/erp_dev

repo_erp/ops/up-all.sh up                  # bring up / update the whole complex
repo_erp/ops/up-all.sh rebuild backend     # rebuild + restart one service
repo_erp/ops/up-all.sh rebuild cad-service # SVG/DXF service
repo_erp/ops/up-all.sh rebuild freecut     # cut optimizer
repo_erp/ops/up-all.sh ps                  # status
repo_erp/ops/up-all.sh logs backend        # tail logs
repo_erp/ops/up-all.sh config              # render merged config (dry check)
repo_erp/ops/up-all.sh down-crm            # service-scoped Twenty teardown only
```

The wrapper self-locates its runtime root (three levels up from the script), so
it can be invoked from any directory. It refuses a bare `down`/`stop` on the
merged stack (that would stop ERP too); use `down-crm` for the CRM, or the
`-- <raw args>` escape hatch for deliberate one-off compose subcommands.
Preflight checks (`.env` present, Twenty upload dir owned by uid 1000, no
`REPLACE_ME` placeholders) are warn-only, since `erp_test` is the test contour.

## apply-migrations.sh — ledgered DB migration runner

The backend has no built-in migration runner; schema lands from a DB dump
restore or by applying `backend/db/migrations/[0-9]*.sql` in order.
`ops/apply-migrations.sh` does the latter safely, tracking applied files in a
`schema_migrations` ledger so re-runs are idempotent. It reaches Postgres via
`docker exec` and resolves the user/db from the container env, so no DB password
enters the host shell.

```bash
cd ~/projects/erp_dev/repo_erp

ops/apply-migrations.sh                 # dry-run (default): what is pending? read-only
ops/apply-migrations.sh status          # applied vs pending + checksum drift, read-only
ops/apply-migrations.sh apply --yes     # apply pending in order, record in ledger
ops/apply-migrations.sh baseline --yes  # adopt the ledger on an ALREADY-migrated DB
                                        # (record history as applied WITHOUT running it)
```

Run `baseline` once on a DB that was migrated before this ledger existed (e.g.
the live `erp_test` / a restored dump) so `apply` does not try to replay history.
Selection excludes the manual Variant-B side files (`*_preflight/_verify/_rollback.sql`)
and `*.test.ts`. Override the target with `--container`, `--user`, `--db`, `--dir`.

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
`repo_freecut` checkout (set `FREECUT_BUILD_CONTEXT`, default `./repo_freecut`)
and comes up automatically with the rest of the stack. It is **internal-only**:
attached to the `back` network with no Traefik route and no public domain, so it
is not reachable from the browser. A backend integration can later call it at
`http://freecut:8088` over the internal network.

The service is standalone (no DB/Hasura/Valkey dependency), so it has no
`depends_on` and starts in parallel. Tuning knobs live in `.env` as
`FREECUT_*` (body/instance/time/restart limits, `FREECUT_MAX_CONCURRENT_OPTIMIZE`,
`FREECUT_CPUS`, `FREECUT_MEM_LIMIT`); none are secrets.

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
git pull --ff-only
sudo ops/setup-vps.sh --yes
```

If only backend code or backend Compose/env flags changed:

```bash
cd ~/projects/erp_dev
git -C repo_erp pull --ff-only
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
