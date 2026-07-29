# ERP Backend Stage 1

This directory is the starting point for the stage-1 backend migration described in
`../spec_back-erp/prd_v1/prd_backend-erp.md`.

Current implemented foundation:

- schema pre-flight checks for `spec_erp/postgresql_schema_v_14.sql`;
- read-only DB precheck SQL for DBeaver before any migration;
- additive stage-1 migration draft; applied only to the local test DB for enabled-flow smoke,
  not to any shared prod/stage DB;
- NestJS runtime skeleton with a shared Postgres pool module;
- env validation for runtime settings, CORS, DB pool/query timeout, readiness, Swagger,
  and feature flags;
- versioned backend API prefix `/api/v1` for new NestJS endpoints;
- persistent Basis-cut sets under `/api/v1/bazis-cut-sets`: typed header/detail snapshots,
  `cut.view`/`cut.manage` RBAC, order scope checks, optimistic versioning,
  idempotent audited mutations, outbox facts, and genuine BIFF8 `.xls` export behind
  `BACKEND_ENABLE_BAZIS_CUT`;
- `/health/live` live health contract;
- `/health/ready` readiness contract with real DB ping when
  `READINESS_REQUIRE_DATABASE=true`; Redis checks remain disabled unless explicitly required;
- Swagger/OpenAPI at `/docs` and `/docs-json`;
- Dockerfile and tracked VPS Docker Compose template under
  `../ops/templates/docker-compose.vps.yml`;
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
- users DB adapter:
  `GET/POST/PATCH /api/v1/users/*` read and mutate `users` through Postgres when
  `DATABASE_URL` is configured and `BACKEND_ENABLE_USERS=true`; password hashes are
  bcrypt-generated, role ids are mapped from canonical backend roles, sessions/tokens are
  revoked on password change/deactivation, and user DTOs never expose password fields;
- order export DB/GAS adapter:
  `POST /api/v1/orders/:orderId/export/google-drive` builds the export payload server-side
  from Postgres, enforces order export scope, rate-limits per user/order, writes audit rows,
  and calls Google Apps Script only when `BACKEND_ENABLE_ORDER_EXPORT=true`,
  `BACKEND_EXPORT_DISABLED=false`, `DATABASE_URL`, `GAS_WEBAPP_URL`, and `GAS_API_KEY`
  are configured;
- order JSON snapshot transfer:
  `GET /api/v1/orders/:orderId/snapshot`,
  `GET /api/v1/orders/snapshot/batch?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`,
  `POST /api/v1/orders/snapshot/import`, and
  `POST /api/v1/orders/snapshot/import-batch` export/import full order snapshots
  through Postgres when `DATABASE_URL` is configured and `BACKEND_ENABLE_ORDERS=true`;
  import also requires `BACKEND_ORDERS_READ_ONLY=false`. The file contract is
  versioned (`formatVersion=1.0.0`, `exporterService.version=1.0.0`), service
  version is included in exported file names, repeated imports are idempotent
  through `order_import_entity_map`, and batch export/import uses one ZIP with
  one `.erp-order.json` per order. Apply
  `db/migrations/005_order_snapshot_import_mapping.sql` before enabling import;
- production actions DB adapter:
  `PATCH /api/v1/orders/:orderId/calendar-date`,
  `PATCH /api/v1/orders/:orderId/status` (`/order-status` remains as a legacy alias),
  `PUT /api/v1/orders/:orderId/production-stage-events/:productionStatusId`,
  and `DELETE /api/v1/orders/:orderId/production-stage-events/:productionStatusId`
  update calendar/status/stage facts through Postgres when `DATABASE_URL` is configured
  and `BACKEND_ENABLE_PRODUCTION_ACTIONS=true`; writes use optimistic `version`,
  idempotency keys, audit rows, and outbox events;
- VLM DB/provider adapter:
  `GET /api/v1/vlm/health`, `POST /api/v1/vlm/upload`, and `POST /api/v1/vlm/analyze`
  are wired to Postgres upload records plus an external VLM provider when
  `BACKEND_ENABLE_VLM=true`, `BACKEND_VLM_DISABLED=false`, `DATABASE_URL`, `VLM_API_URL`,
  and Auth0 M2M env are configured; analyze accepts only trusted stored uploads or matching
  stored URLs, applies rate/daily limits, and writes audit rows;
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
- frontend cutover foundation on branch `feat/frontend-backend-cutover`:
  authProvider/authStorage can use `/api/v1/auth/*` and `/api/v1/me` behind
  `VITE_USE_BACKEND_AUTH`; navigation can use backend `permissions[]` behind
  `VITE_USE_BACKEND_PERMISSIONS`; orders list/show/edit load and order save can use
  `/api/v1/orders` behind `VITE_USE_BACKEND_ORDERS_READ` and
  `VITE_USE_BACKEND_ORDERS_WRITE`; calendar/order header production actions can use
  `/api/v1/orders/:id/*` behind `VITE_USE_BACKEND_PRODUCTION_ACTIONS`; users pages,
  order export, and VLM hooks can use
  `/api/v1/users`, `/api/v1/orders/:id/export/google-drive`, and `/api/v1/vlm/*` behind
  `VITE_USE_BACKEND_USERS`, `VITE_USE_BACKEND_ORDER_EXPORT`, and `VITE_USE_BACKEND_VLM`;
- staged frontend runtime-config canary readiness:
  examples under `docs/runtime-config/canary/`, checklist in
  `docs/runtime-config-canary-readiness.md`, validator
  `npm run test:runtime-config-canary`, and deployed-config smoke script
  `npm run smoke:runtime-config`;
- frontend runtime-config delivery on Vercel:
  `GET /runtime-config.json` rewrites to `api/runtime-config.ts`, reads only
  whitelisted `RUNTIME_CONFIG_*` env keys, sets `Cache-Control: no-store`, and
  defaults all backend frontend flags to `false`;
- staging gate smoke:
  `npm run smoke:staging-gates -- --frontend-url=<url> --backend-url=<url> --expect=<canary-json>`
  checks deployed runtime config, backend live/ready health, and optionally legacy rollback paths;
- Vite dev proxy now routes versioned `/api/v1/*` and `/health/*` to NestJS while
  keeping legacy `/api/*` Vercel Functions available for non-cutover users/export/VLM flows;
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
GET http://localhost:3000/api/v1/orders/1/snapshot
GET http://localhost:3000/api/v1/orders/snapshot/batch?dateFrom=2026-05-01&dateTo=2026-05-11
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
BACKEND_RATE_LIMIT_STORE=memory
RATE_LIMIT_REDIS_URL=
DATABASE_SSL=false
DATABASE_POOL_MIN=1
DATABASE_POOL_MAX=10
DATABASE_QUERY_TIMEOUT_MS=10000
JWT_ACCESS_SECRET=
REFRESH_TOKEN_PEPPER=
ACCESS_TOKEN_TTL_SECONDS=900
AUTH_SESSION_TTL_SECONDS=36000
REFRESH_TOKEN_TTL_DAYS=7
BACKEND_ENABLE_AUTH=false
BACKEND_ENABLE_ORDERS=false
BACKEND_ENABLE_PAYMENTS=false
BACKEND_ENABLE_PRODUCTION_ACTIONS=false
BACKEND_ENABLE_ORDER_EXPORT=false
BACKEND_ENABLE_USERS=false
BACKEND_ENABLE_VLM=false
BACKEND_ORDERS_READ_ONLY=true
BACKEND_EXPORT_DISABLED=true
BACKEND_VLM_DISABLED=true
BACKEND_ENABLE_DEADLINES=false
BACKEND_DEADLINES_READ_ONLY=true
BACKEND_ENABLE_DEADLINE_WORKER=false
BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS=60000
BACKEND_DEADLINE_WORKER_BATCH_SIZE=100
BACKEND_DEADLINE_WORKER_ID=backend-local
BACKEND_DEADLINE_ACTIONS_ENABLED=false
BACKEND_DEADLINE_NOTIFICATIONS_ENABLED=false
GAS_WEBAPP_URL=
GAS_API_KEY=
GAS_EXPORT_TIMEOUT_MS=55000
VLM_API_URL=
VLM_HEALTH_TIMEOUT_MS=10000
VLM_UPLOAD_TIMEOUT_MS=30000
VLM_ANALYZE_TIMEOUT_MS=90000
VLM_ANALYZE_DAILY_LIMIT=100
AUTH0_M2M_DOMAIN=
AUTH0_M2M_CLIENT_ID=
AUTH0_M2M_CLIENT_SECRET=
AUTH0_M2M_AUDIENCE=
VLM_MAX_UPLOAD_MB=20
VLM_ALLOWED_MIME_TYPES=image/jpeg,image/png,image/webp
```

Docker:

```bash
docker build -t erp-backend-stage1:test .
docker compose up backend
```

For Redis/Valkey-backed rate limit in staging or production, run a Redis-compatible
service and configure the backend to use it. Local development and tests may keep
`BACKEND_RATE_LIMIT_STORE=memory`.

Example Compose service:

```yaml
services:
  valkey:
    image: valkey/valkey:7.2-alpine
    command: ["valkey-server", "--appendonly", "yes"]
    restart: unless-stopped
    volumes:
      - valkey_data:/data
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  backend:
    depends_on:
      valkey:
        condition: service_healthy
    environment:
      BACKEND_RATE_LIMIT_STORE: redis
      RATE_LIMIT_REDIS_URL: redis://valkey:6379
      READINESS_REQUIRE_REDIS: "true"

volumes:
  valkey_data:
```

For managed Redis/Valkey, omit the `valkey` service and set
`RATE_LIMIT_REDIS_URL` or `REDIS_URL` in the runtime `.env`. Do not log or commit
connection strings when they include credentials.

For VPS deploys, keep Docker Compose changes in the repo template
`../ops/templates/docker-compose.vps.yml` and runtime secret values in the VPS
`.env`. The live VPS `docker-compose.yml` is generated from the template on a
fresh setup and may contain only machine-local path differences. Backend feature
gates, including `BACKEND_ENABLE_PRODUCTION_ACTIONS`, belong to the VPS backend
runtime, not to the frontend Vercel project.

If the template is run directly with `-f ../ops/templates/docker-compose.vps.yml`,
the `.env` file should live in the Compose runtime root passed through
`--project-directory`. For the current split VPS layout, that is
`/home/ovhtest/projects/erp_dev/.env`, and it should include
`BACKEND_BUILD_CONTEXT=./repo_erp/backend` so Compose can build this backend
from the nested repo checkout.

DB readiness with test database:

```bash
set -a
. ./.env.test-bd.local
set +a
READINESS_REQUIRE_DATABASE=true \
npm start
```

Do not print real values from `.env.test-bd.local`.

Enabled-flow smoke status:

- 2026-05-02 local test DB prechecks passed for stage-1 blockers; `001_backend_stage1_additive.sql`
  and `002_deadline_engine.sql` were applied to the recreated local `postgresdb`.
- Production-like backend runtime was started from compiled `dist` with
  `API_PREFIX=/api/v1`, `BACKEND_ENABLE_AUTH=true`, `BACKEND_ENABLE_ORDERS=true`.
- Smoke passed for auth login/refresh/me/logout, manager permissions, orders list/get/create/update,
  and audit rows `orders.create`/`orders.update`.
- Rollback smoke passed with `BACKEND_ORDERS_READ_ONLY=true`: orders read stayed available and
  write returned HTTP 503 `SERVICE_UNAVAILABLE` with `mode=read_only`.
- Smoke-created users/orders/audit rows were cleaned up. Do not print real values from
  `.env.test-bd.local`.
- `npm run dev` was verified after adding explicit Nest `@Inject(...)` annotations for
  controller/service dependencies that should not rely on compiled decorator metadata.
- 2026-05-02 real adapter smoke was run from compiled `dist` with auth/orders/users enabled,
  export/VLM external actions disabled: `/health/ready` returned ready with DB ok, users
  list/create/update/change-password/deactivate/activate passed through HTTP and the temporary
  user was cleaned up, export returned fail-closed HTTP 503 while disabled, and VLM returned
  fail-closed HTTP 503 without provider config.
- 2026-05-02 VLM provider smoke was run from compiled `dist` with real test DB, VLM provider,
  and Auth0 M2M env: readiness/auth/VLM health passed, arbitrary external `imageUrl` was
  rejected, image upload returned `uploadId`, analyze by `uploadId` succeeded, audit rows
  `vlm.upload`/`vlm.analyze` were verified, smoke rows were cleaned up, and
  `BACKEND_VLM_DISABLED=true` returned HTTP 503 for upload/analyze rollback.
- 2026-05-11 order JSON snapshot transfer was added locally: unit/API coverage
  and production builds passed for backend/frontend. Migration
  `005_order_snapshot_import_mapping.sql` is required before real DB import.
- 2026-05-12 stage snapshot export incident was caused by deploy drift: Vercel
  frontend already called `/api/v1/orders/:orderId/snapshot`, while the VPS
  backend container was still an older image without `OrderSnapshotController`.
  Rebuilding/recreating only `backend` fixed the 404; startup logs now map the
  single export, batch export, single import, and batch import routes.
  Migration `005_order_snapshot_import_mapping.sql` was applied on stage.
  Authenticated probes passed: order `11157` single export returned snapshot
  v1 with client, phones, details, and payments; batch export for
  `2026-05-11` returned ZIP with `X-Order-Snapshot-Count=4`; empty import
  returned expected HTTP 422 validation. `ops/smoke-vps.sh --skip-docker`
  passed.

Next implementation steps:

1. Stage/prod cutover can start only after runtime env/secrets are delivered for auth, DB, GAS,
   VLM, and Auth0 M2M; toggle each frontend runtime flag one flow at a time with smoke and
   rollback checks. After restoring a prod backup into a new environment, run
   `npm run smoke:db-cutover -- --env-file <path> --database-url-env DATABASE_URL`
   from `backend/` before browser smoke.
2. Add a scheduled Deadline Worker poller only after operations agrees on runtime ownership.
3. Configure staging/production `RUNTIME_CONFIG_*` env and run deployed runtime-config smoke
   before each canary step.
