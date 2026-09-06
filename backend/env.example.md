# Backend Env Examples

Do not commit real secrets. Copy only the needed block into a local untracked file,
for example `backend/.env.local` or `backend/.env.test-db.local`.

## Local Backend Runtime

```env
NODE_ENV=development
APP_NAME=erp-backend
PORT=3000
API_PREFIX=/api/v1
FRONTEND_ORIGIN=http://localhost:5173
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
CORS_ALLOW_CREDENTIALS=true
LOG_LEVEL=info
TRUST_PROXY=false
REQUEST_ID_HEADER=x-request-id
SWAGGER_ENABLED=true
SWAGGER_PATH=/docs
READINESS_REQUIRE_DATABASE=false
READINESS_REQUIRE_REDIS=false
```

## Test DB Access

Use this when a separate test PostgreSQL database is available and migrations or
DB adapters need to be tested.

```env
DATABASE_URL=postgres://PG_USER:PG_PASSWORD@127.0.0.1:5432/PG_DB
DATABASE_SSL=false
DATABASE_POOL_MIN=1
DATABASE_POOL_MAX=5
DATABASE_QUERY_TIMEOUT_MS=10000
BACKEND_PERFORMANCE_QUERY_TELEMETRY=false
BACKEND_ENABLE_PERFORMANCE_RUM=false
READINESS_REQUIRE_DATABASE=true
```

If the database is exposed through the PRD compose bind address, use:

```env
DATABASE_URL=postgres://PG_USER:PG_PASSWORD@100.70.138.94:5432/PG_DB
DATABASE_SSL=false
```

If backend runs inside the same Docker network as `postgresdb`, use:

```env
DATABASE_URL=postgres://PG_USER:PG_PASSWORD@postgresdb:5432/PG_DB
DATABASE_SSL=false
```

## Feature Flags

All risky stage-1 APIs are disabled or read-only by default.

```env
BACKEND_ENABLE_AUTH=false
BACKEND_ENABLE_ORDERS=false
BACKEND_ENABLE_ORDER_LIVE_SNAPSHOT=false
BACKEND_ENABLE_ORDER_REALTIME_WRITES=false
BACKEND_ENABLE_ORDER_REALTIME_STREAM=false
BACKEND_ENABLE_PAYMENTS=false
BACKEND_ENABLE_PRODUCTION_ACTIONS=false
BACKEND_ENABLE_ORDER_EXPORT=false
BACKEND_ENABLE_USERS=false
BACKEND_ENABLE_VLM=false
BACKEND_ENABLE_DEADLINES=false
BACKEND_ENABLE_BAZIS_CUT=false

BACKEND_ORDERS_READ_ONLY=true
BACKEND_EXPORT_DISABLED=true
BACKEND_VLM_DISABLED=true
BACKEND_DEADLINES_READ_ONLY=true

BACKEND_ENABLE_DEADLINE_WORKER=false
BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS=60000
BACKEND_DEADLINE_WORKER_BATCH_SIZE=100
BACKEND_DEADLINE_WORKER_ID=backend-local
BACKEND_DEADLINE_ACTIONS_ENABLED=false
BACKEND_DEADLINE_NOTIFICATIONS_ENABLED=false
```

Order realtime remains off until migrations `097` and `098` are applied, the
three backend flags above are enabled, and both `order_realtime.writes` and
`order_realtime.rollout` are explicitly enabled in `app_settings`. Enable
frontend `RUNTIME_CONFIG_ORDER_REALTIME` last.

`BACKEND_ENABLE_PRODUCTION_ACTIONS=true` enables the narrow calendar/order
header production actions API: calendar date move, order status change, and
order-level production stage activate/deactivate. It requires `DATABASE_URL` and
should be paired with the frontend/runtime-config flag only after the DB
migration for production action audit/outbox/idempotency contracts is applied.

## Bitrix24 One-Way Sync

Keep the relay paused while running the initial backfill. The webhook is a
secret and belongs only in an untracked runtime env file.

```env
BACKEND_ENABLE_BITRIX24_SYNC=true
BACKEND_BITRIX24_SYNC_RELAY_OWNER=external
BACKEND_BITRIX24_SYNC_LEASE_MS=300000
BITRIX24_WEBHOOK_URL=https://bitrix24.example.com/rest/USER/SECRET
BITRIX24_PAY_SYSTEM_ID=12
BITRIX24_REQUEST_TIMEOUT_MS=30000
BITRIX24_MAX_REQUESTS_PER_SECOND=2
BITRIX24_LIMIT_RETRY_MAX_ATTEMPTS=11
BITRIX24_QUERY_LIMIT_BASE_DELAY_MS=1000
BITRIX24_OPERATION_LIMIT_FALLBACK_MS=60000
BITRIX24_CURRENCY_ID=KZT
```

The standard cloud limit is two sustained requests per second. Use five only
after confirming an Enterprise portal limit. Backfill requires an explicit
scope and resumes its last committed database checkpoint:

```bash
npm --prefix backend run crm-sync:backfill -- --dry-run --scope clients
npm --prefix backend run crm-sync:backfill -- --scope clients
```

## Bitrix24 Reverse Sync

Reverse sync uses a server local application and OAuth. Keep it disabled until
migrations `144_bitrix24_reverse_sync.sql` and
`145_order_kinds_bitrix_crm_requests.sql` are applied and the installation
callback has successfully bound CRM events.

```env
BACKEND_ENABLE_BITRIX24_REVERSE_SYNC=false
BACKEND_BITRIX24_REVERSE_SYNC_RELAY_OWNER=none
BACKEND_BITRIX24_REVERSE_SYNC_DRY_RUN=false
BACKEND_BITRIX24_REVERSE_SYNC_POLL_INTERVAL_MS=5000
BACKEND_BITRIX24_REVERSE_SYNC_BATCH_SIZE=25
BACKEND_BITRIX24_REVERSE_SYNC_MAX_ATTEMPTS=10
BACKEND_BITRIX24_REVERSE_SYNC_WORKER_ID=bitrix24-reverse-local
BACKEND_BITRIX24_REVERSE_SYNC_LEASE_MS=300000
BACKEND_BITRIX24_REVERSE_SYNC_ACTOR_USER_ID=
BACKEND_ORDER_INITIAL_STATUS_CODE=
BACKEND_ORDER_INITIAL_PRODUCTION_STATUS_CODE=
BACKEND_BITRIX24_RECONCILE_INTERVAL_MS=900000
BITRIX24_APP_CLIENT_ID=local.REPLACE
BITRIX24_APP_CLIENT_SECRET=replace
BITRIX24_APP_TOKEN_ENCRYPTION_KEY=base64-of-exactly-32-random-bytes
BITRIX24_APP_PUBLIC_BASE_URL=https://backend.example.invalid
BITRIX24_APP_PORTAL_DOMAIN=mebelkz.bitrix24.kz
BITRIX24_PORTAL_TIMEZONE=Asia/Almaty
BACKEND_ENABLE_BITRIX24_PAYMENT_WIDGET=false
BITRIX24_WIDGET_SESSION_ENCRYPTION_KEY=base64-of-another-32-random-bytes
BITRIX24_WIDGET_COMMAND_TOKEN_ENCRYPTION_KEY=base64-of-a-third-32-random-bytes
BITRIX24_WIDGET_SESSION_TTL_SECONDS=600
BITRIX24_WIDGET_COMMAND_TOKEN_RETENTION_DAYS=30
BITRIX24_WIDGET_PAY_SYSTEM_CACHE_TTL_SECONDS=900
BITRIX24_WIDGET_COMMAND_LEASE_MS=180000
```

Set local application installation callback to
`https://backend.example.invalid/api/v1/integrations/bitrix24/install`. Event
handler is bound automatically at
`https://backend.example.invalid/api/v1/integrations/bitrix24/events`.
Installation is accepted only when `app.info` confirms configured local
application code. The callback `application_token` is stored only as a hash and
authenticates all later event deliveries.

For the Deal payment widget, disable `Использует только API`, set the main
handler to `/api/v1/integrations/bitrix24/app`, and the initial-install handler
to `/api/v1/integrations/bitrix24/install-ui`. Grant `crm`, `sale`,
`pay_system`, `placement`, and a user scope supporting `user.current`. The two
widget encryption keys must differ from each other and from the installation
token key.

## Auth Session Adapter

Use only local/dev secrets here. Real secrets must stay in local untracked env
files or deployment secret storage.

```env
JWT_ACCESS_SECRET=change-me-dev-access-secret-at-least-32-chars
REFRESH_TOKEN_PEPPER=change-me-dev-refresh-pepper-at-least-32-chars
ACCESS_TOKEN_TTL_SECONDS=900
AUTH_SESSION_TTL_SECONDS=172800
REFRESH_TOKEN_TTL_DAYS=7
BACKEND_ENABLE_AUTH=true
```

## Optional Hasura Legacy Access

Use only for backend-side legacy reads or compatibility adapters. Never expose
admin secrets to frontend code.

```env
HASURA_GRAPHQL_URL=http://localhost:8585/v1/graphql
HASURA_ADMIN_SECRET=change-me
HASURA_TIMEOUT_MS=10000
```

## Optional VLM Upload Policy

```env
VLM_MAX_UPLOAD_MB=20
VLM_ALLOWED_MIME_TYPES=image/jpeg,image/png,image/webp
```

## Minimum Needed From Test DB Owner

```env
PG_HOST=127.0.0.1
PG_PORT=5432
PG_DB=...
PG_USER=...
PG_PASSWORD=...
DATABASE_SSL=false
```

Before running migrations, confirm the target is a test database and the user
has permission for `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, and
`CREATE EXTENSION pgcrypto`.
