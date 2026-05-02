# ERP Backend Stage 1

This directory is the starting point for the stage-1 backend migration described in
`../spec_back-erp/prd_v1/prd_backend-erp.md`.

Current implemented foundation:

- schema pre-flight checks for `spec_erp/postgresql_schema_v_14.sql`;
- read-only DB precheck SQL for DBeaver before any migration;
- additive stage-1 migration draft, not applied to any shared DB;
- NestJS runtime skeleton with a shared Postgres pool module;
- env validation for runtime settings, CORS, DB pool/query timeout, readiness, Swagger,
  and feature flags;
- versioned backend API prefix `/api/v1` for new NestJS endpoints;
- `/health/live` live health contract;
- `/health/ready` readiness contract with real DB ping when
  `READINESS_REQUIRE_DATABASE=true`; Redis checks remain disabled unless explicitly required;
- Swagger/OpenAPI at `/docs` and `/docs-json`;
- Dockerfile and docker-compose skeleton;
- requestId helper/middleware;
- ApiError response contract and Nest exception filter;
- log redaction utility for sensitive fields;
- permissions runtime layer: `PermissionsService`, `RequirePermissions`, `PermissionsGuard`,
  `CurrentUser` decorator, and `PermissionsModule`;
- auth/session application layer with DB adapters enabled only when auth DB env is configured;
- refresh token helper contract: opaque token generation, HMAC hash, HttpOnly cookie options;
- auth HTTP flow:
  `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`,
  and `GET /api/v1/me` fail closed while `BACKEND_ENABLE_AUTH=false`; when enabled with
  `DATABASE_URL`, `JWT_ACCESS_SECRET`, and `REFRESH_TOKEN_PEPPER`, login creates
  `auth_sessions` + hashed `refresh_tokens`, refresh rotates tokens atomically,
  logout revokes the session, and `/me` reads the Bearer access token;
- domain policies for orders, payments, and users;
- OrdersModule domain core:
  `SaveOrderDto` types, normalization, validation, totals/payment-status calculations,
  and `prepareOrderSave()`;
- orders read DB adapter:
  `GET /api/v1/orders` and `GET /api/v1/orders/:orderId` read from base tables
  through Postgres when `DATABASE_URL` is configured and `BACKEND_ENABLE_ORDERS=true`;
  list filtering/sorting is whitelisted and soft-deleted rows are hidden;
- orders transaction DB adapter:
  `POST /api/v1/orders` and `PUT /api/v1/orders/:orderId` save the full aggregate
  through one Postgres transaction when DB/auth/orders write flags are enabled;
  the adapter writes base tables directly, checks optimistic `version`, validates child
  ownership, updates totals/version, writes audit rows, and reads the saved aggregate back;
- orders transaction application layer:
  transaction manager/unit-of-work ports, permission check, version conflict handling,
  child ownership check hook, ordered child upsert/delete orchestration, audit hook,
  and rollback-covered fake tests;
- orders HTTP write endpoints:
  `POST /api/v1/orders` and `PUT /api/v1/orders/:orderId` controllers exist but fail closed
  while `BACKEND_ENABLE_ORDERS=false` or `BACKEND_ORDERS_READ_ONLY=true`;
- Deadline Engine DB adapter without frontend cutover:
  `/api/v1/deadlines`, `/api/v1/deadline-policies`, `/api/v1/deadline-settings`,
  and order deadline read-model endpoints exist behind fail-closed feature flags;
  Postgres repository/transaction/target resolver/notification/outbox adapters are wired
  when `DATABASE_URL` is configured; due scans use `FOR UPDATE SKIP LOCKED`; lifecycle
  events write `deadline_events`, `audit_log`, and `outbox_events`;
- orders-to-deadlines sync through a port/outbox:
  when `BACKEND_ENABLE_DEADLINES=true`, order save emits order outbox events and syncs
  final/stage deadlines from `plannedCompletionDate` plus stage completion from
  `completedDate`;
  domain helpers, action dispatcher, worker core, unavailable adapters,
  `002_deadline_engine.sql`, and read-only precheck SQL are included;
- Vitest coverage for schema blockers, env validation, health, ApiError, redaction,
  prechecks, migrations, permissions, auth contracts, policies, orders domain core,
  Deadline Engine shell/domain behavior, and Postgres DB adapters.

Local commands:

```bash
npm install
npm run build
npm run test
npm run dev
```

Live health:

```txt
GET http://localhost:3000/health/live
GET http://localhost:3000/health/ready
GET http://localhost:3000/docs-json
POST http://localhost:3000/api/v1/auth/login
```

Runtime env defaults are local-only:

```env
NODE_ENV=development
PORT=3000
API_PREFIX=/api/v1
FRONTEND_ORIGIN=http://localhost:5173
LOG_LEVEL=info
REQUEST_ID_HEADER=x-request-id
SWAGGER_ENABLED=true
READINESS_REQUIRE_DATABASE=false
READINESS_REQUIRE_REDIS=false
DATABASE_SSL=false
DATABASE_POOL_MIN=1
DATABASE_POOL_MAX=10
DATABASE_QUERY_TIMEOUT_MS=10000
JWT_ACCESS_SECRET=
REFRESH_TOKEN_PEPPER=
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=7
BACKEND_ENABLE_AUTH=false
BACKEND_ENABLE_ORDERS=false
BACKEND_ORDERS_READ_ONLY=true
BACKEND_ENABLE_DEADLINES=false
BACKEND_DEADLINES_READ_ONLY=true
BACKEND_ENABLE_DEADLINE_WORKER=false
BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS=60000
BACKEND_DEADLINE_WORKER_BATCH_SIZE=100
BACKEND_DEADLINE_WORKER_ID=backend-local
BACKEND_DEADLINE_ACTIONS_ENABLED=false
BACKEND_DEADLINE_NOTIFICATIONS_ENABLED=false
```

Docker:

```bash
docker build -t erp-backend-stage1:test .
docker compose up backend
```

DB readiness with test database:

```bash
set -a
. ./.env.test-bd.local
set +a
DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@100.70.138.94:5432/${PG_DB}" \
READINESS_REQUIRE_DATABASE=true \
npm start
```

Do not print real values from `.env.test-bd.local`.

Next implementation steps:

1. Move frontend critical order flows to backend APIs through feature flags.
2. Add backend export/users/VLM real adapters where the frontend is ready to cut over.
3. Add a scheduled Deadline Worker poller only after operations agrees on runtime ownership.
