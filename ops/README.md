# VPS Bootstrap And Deploy

This folder contains scripts for quickly preparing a new VPS for the ERP stack:
Traefik, PostgreSQL, Hasura, and the backend service.

No real secrets are stored here. Copy `ops/templates/env.vps.example` to `.env`
on the VPS and fill real values there. `.env` is ignored by git.

## One Script Flow

Use one command on the VPS:

```bash
sudo ops/setup-vps.sh
```

On the first run it installs Docker, prepares folders, creates `.env`, and then
stops because placeholders are still present. Fill `.env`, make sure DNS points
to the VPS, then run the same command again:

```bash
sudo ops/setup-vps.sh
```

The second run validates `.env`, checks DNS, deploys the stack, and runs smoke
checks. If you want non-interactive deploy after `.env` is filled:

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
- `smoke-vps.sh` - checks HTTPS health endpoints and Hasura CORS preflight.
- `restore-prod-backup.sh` - destructive DB restore helper for a fresh backup.

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
mkdir -p /home/<user>/projects
git clone <repo-url> /home/<user>/projects/erp
cd /home/<user>/projects/erp
sudo ops/setup-vps.sh
```

Fill `.env`:

```bash
nano .env
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
sudo ops/setup-vps.sh
```

If DNS has not propagated but you know the target IP:

```bash
sudo ops/setup-vps.sh --expected-ip <VPS_PUBLIC_IP>
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
directory tree, globals are restored too. Missing path or empty directory is a
non-fatal skip by default; use strict mode when the restore must happen:

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
VITE_USE_BACKEND_USERS=true
VITE_USE_BACKEND_ORDER_EXPORT=true
VITE_USE_BACKEND_VLM=true
```

## Updating An Existing VPS

```bash
cd /opt/erp
git pull
ops/deploy-stack.sh
ops/smoke-vps.sh
```

If only CORS/domain variables changed:

```bash
ops/setup-vps.sh --skip-bootstrap --skip-deploy
docker compose --env-file .env -f docker-compose.yml up -d --force-recreate hasura backend
ops/smoke-vps.sh
```

## Restoring A Production Backup

Upload the backup to the VPS, for example into `/opt/erp/restore`.

For the normal one-script flow, prefer:

```bash
sudo ops/setup-vps.sh --yes --restore-backup /opt/erp/restore --require-restore-backup
```

Then run:

```bash
ops/restore-prod-backup.sh \
  --main-dump /opt/erp/restore/latest.dump \
  --confirm-db erpdb
```

With globals:

```bash
ops/restore-prod-backup.sh \
  --main-dump /opt/erp/restore/latest.dump \
  --globals-dump /opt/erp/restore/globals.sql.gz \
  --restore-globals \
  --confirm-db erpdb
```

The restore script stops Hasura, creates a pre-restore dump when the target DB
already exists, drops/recreates `PG_DB`, restores the dump, then starts Hasura.

## Common Failures

Hasura CORS still fails:

```bash
ops/smoke-vps.sh
docker compose --env-file .env -f docker-compose.yml exec -T hasura printenv HASURA_GRAPHQL_CORS_DOMAIN
```

If the env is correct but the browser still fails, recreate Hasura:

```bash
docker compose --env-file .env -f docker-compose.yml up -d --force-recreate hasura
```

Let's Encrypt certificate is not issued:

- Check DNS `A` records for `HASURA_FQDN` and `BACKEND_FQDN`.
- Check VPS firewall allows ports `80` and `443`.
- Check no other service is using ports `80`/`443`.

Backend health fails:

```bash
docker compose --env-file .env -f docker-compose.yml logs --tail=200 backend
```

Postgres is not reachable:

- Keep `PG_BIND_IP=127.0.0.1` for local-only DB.
- Use a Tailscale IP only when remote backup/restore/admin access is required.
- Do not use `PG_BIND_IP=0.0.0.0` for production without hardening firewall and
  `pg_hba.conf`.
