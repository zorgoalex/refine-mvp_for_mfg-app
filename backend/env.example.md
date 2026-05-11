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
CORS_ALLOWED_ORIGINS=http://localhost:5173
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
BACKEND_ENABLE_PAYMENTS=false
BACKEND_ENABLE_PRODUCTION_ACTIONS=false
BACKEND_ENABLE_ORDER_EXPORT=false
BACKEND_ENABLE_USERS=false
BACKEND_ENABLE_VLM=false
BACKEND_ENABLE_DEADLINES=false

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

`BACKEND_ENABLE_PRODUCTION_ACTIONS=true` enables the narrow calendar/order
header production actions API: calendar date move, order status change, and
order-level production stage activate/deactivate. It requires `DATABASE_URL` and
should be paired with the frontend/runtime-config flag only after the DB
migration for production action audit/outbox/idempotency contracts is applied.

## Auth Session Adapter

Use only local/dev secrets here. Real secrets must stay in local untracked env
files or deployment secret storage.

```env
JWT_ACCESS_SECRET=change-me-dev-access-secret-at-least-32-chars
REFRESH_TOKEN_PEPPER=change-me-dev-refresh-pepper-at-least-32-chars
ACCESS_TOKEN_TTL_SECONDS=900
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
