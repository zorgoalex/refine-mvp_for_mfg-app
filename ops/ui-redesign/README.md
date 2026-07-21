# UI redesign isolated review stack

This stack is physically separate from `erp_test`: its own Compose project,
PostgreSQL volumes, Hasura metadata database, Valkey, backend, Hasura, and
frontend. The initial data is a one-time clone; reviewer writes never reach the
source stack.

## Start from a fresh clone

```bash
./ops/ui-redesign/clone-current-data.sh /home/ovhtest/projects/erp_dev/.env
docker compose --project-name erp_ui_redesign \
  --env-file /home/ovhtest/projects/erp_dev/.env \
  --env-file ops/ui-redesign/.env.secrets \
  -f ops/ui-redesign/docker-compose.yml up -d --build
```

The clone command creates mode-`0600`, git-ignored `.env.secrets` with fresh
JWT, refresh-token and Hasura secrets. It copies users and permissions, then
deletes copied `refresh_tokens` and `auth_sessions`. Source containers are
fixed to the `erp_test` Compose project and validated before any target DB is
recreated.

Open `http://${PG_TAILSCALE_BIND_IP}:4174` and sign in with an existing cloned
test account. The frontend is published only on that explicit Tailscale IP;
the runtime network is internal and has no outbound route.

Core endpoints are isolated:

- frontend: `http://${PG_TAILSCALE_BIND_IP}:4174`
- backend diagnostic port: `http://127.0.0.1:3301`
- Hasura diagnostic port: `http://127.0.0.1:8586`
- PostgreSQL diagnostic port: `127.0.0.1:55433`

## Emergency legacy preview

Set `ui.forceLegacy` to `true` in `runtime-config.json`, rebuild only frontend,
then hard-refresh. Missing or malformed runtime config also fails closed to the
legacy shell.

Nginx exposes the review backend under `/ui-redesign/api/v1` and rewrites the
backend's internal `/api/v1` prefix. It also rewrites the refresh cookie Path to
`/ui-redesign/api/v1/auth`; source cookies use `/api/v1/auth`. Combined with
separate signing/pepper secrets and deleted snapshot sessions, tokens and
cookies cannot cross stacks.

## Stop without deleting review data

```bash
docker compose --project-name erp_ui_redesign \
  --env-file /home/ovhtest/projects/erp_dev/.env \
  --env-file ops/ui-redesign/.env.secrets \
  -f ops/ui-redesign/docker-compose.yml stop
```

Do not use `down -v` unless permanent deletion of the isolated review data is
explicitly intended.
