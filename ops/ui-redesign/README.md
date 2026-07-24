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

Only the frontend is published to the host:

- frontend: `http://${PG_TAILSCALE_BIND_IP}:4174`

Backend, Hasura, PostgreSQL, metadata PostgreSQL, and Valkey stay exclusively on
the internal `back` network. The frontend joins a separate `edge` network only
to publish the Tailscale-bound review port.

## Emergency legacy preview

Set `ui.forceLegacy` to `true` in `runtime-config.json`, rebuild only frontend,
then hard-refresh. Missing or malformed runtime config also fails closed to the
legacy shell.

## Resource guard

The preview services have hard memory, swap, CPU, and PID limits. The combined
memory ceiling is 1664 MiB, and container swap is disabled so the preview cannot
push unrelated Codex sessions into swap.

After the stack is healthy, run `memory-watchdog.sh` as a supervised background
process. It stops only containers labelled with the `erp_ui_redesign` Compose
project after available host memory stays below 1536 MiB for three checks. The
watchdog can also start up to 60 seconds before the first preview container.

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
