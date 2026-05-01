# ERP Backend Stage 1

This directory is the starting point for the stage-1 backend migration described in
`../spec_back-erp/prd_v1/prd_backend-erp.md`.

Current implemented foundation:

- schema pre-flight checks for `spec_erp/postgresql_schema_v_14.sql`;
- read-only DB precheck SQL for DBeaver before any migration;
- additive stage-1 migration draft, not applied to any shared DB;
- NestJS runtime skeleton without DB connection;
- env validation for runtime-only settings, CORS, readiness, Swagger, and feature flags;
- versioned backend API prefix `/api/v1` for new NestJS endpoints;
- `/health/live` live health contract;
- `/health/ready` readiness contract with DB/Redis checks disabled unless explicitly required;
- Swagger/OpenAPI at `/docs` and `/docs-json`;
- Dockerfile and docker-compose skeleton;
- requestId helper/middleware;
- ApiError response contract and Nest exception filter;
- log redaction utility for sensitive fields;
- permissions runtime layer: `PermissionsService`, `RequirePermissions`, `PermissionsGuard`,
  `CurrentUser` decorator, and `PermissionsModule`;
- auth/session application layer without DB adapter or enabled HTTP cutover;
- refresh token helper contract: opaque token generation, HMAC hash, HttpOnly cookie options;
- auth HTTP shell without DB adapter or enabled cutover:
  `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`,
  and `GET /api/v1/me` exist but fail closed while `BACKEND_ENABLE_AUTH=false`;
  if the flag is forced on before DB adapters exist, unavailable auth ports return 503;
- domain policies for orders, payments, and users;
- OrdersModule domain core without DB adapter or enabled HTTP cutover:
  `SaveOrderDto` types, normalization, validation, totals/payment-status calculations,
  and `prepareOrderSave()`;
- orders transaction application layer without DB adapter or enabled HTTP cutover:
  transaction manager/unit-of-work ports, permission check, version conflict handling,
  child ownership check hook, ordered child upsert/delete orchestration, audit hook,
  and rollback-covered fake tests;
- orders HTTP write shell without DB adapter or enabled cutover:
  `POST /api/v1/orders` and `PUT /api/v1/orders/:orderId` controllers exist but fail closed
  while `BACKEND_ENABLE_ORDERS=false` or `BACKEND_ORDERS_READ_ONLY=true`; if write flags
  are forced on before DB adapter exists, the unavailable transaction manager returns 503;
- Deadline Engine shell without DB adapter or enabled cutover:
  `/api/v1/deadlines`, `/api/v1/deadline-policies`, `/api/v1/deadline-settings`,
  and order deadline read-model endpoints exist behind fail-closed feature flags;
  domain helpers, action dispatcher, worker core, unavailable adapters,
  `002_deadline_engine.sql`, and read-only precheck SQL are included;
- Vitest coverage for schema blockers, env validation, health, ApiError, redaction,
  prechecks, migrations, permissions, auth contracts, policies, orders domain core,
  and Deadline Engine shell/domain behavior.

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
BACKEND_ENABLE_AUTH=false
BACKEND_ENABLE_ORDERS=false
BACKEND_ORDERS_READ_ONLY=true
BACKEND_ENABLE_DEADLINES=false
BACKEND_DEADLINES_READ_ONLY=true
BACKEND_ENABLE_DEADLINE_WORKER=false
BACKEND_DEADLINE_ACTIONS_ENABLED=false
BACKEND_DEADLINE_NOTIFICATIONS_ENABLED=false
```

Docker:

```bash
docker build -t erp-backend-stage1:test .
docker compose up backend
```

Next implementation steps:

1. Add DB adapters only after a separate test DB is available.
2. Wire Deadline Engine to orders through an outbox/sync port after DB adapters exist.
3. Move frontend UI flows to backend APIs through feature flags after cutover testing.
