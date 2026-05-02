# Order Export Cutover Readiness

Purpose: move Google Drive order export from legacy Vercel/GAS proxy to the
stage-1 backend export API without sending full order/payment/client payloads
from the browser.

## Runtime Flags

Backend:

```env
BACKEND_ENABLE_AUTH=true
BACKEND_ENABLE_ORDERS=true
BACKEND_ENABLE_ORDER_EXPORT=true
BACKEND_EXPORT_DISABLED=false
GAS_WEBAPP_URL=<set>
GAS_API_KEY=<set>
```

Frontend:

```env
VITE_USE_BACKEND_ORDER_EXPORT=true
```

Keep legacy `/api/order-export-to-drive` deployed until canary and rollback
checks pass.

## Pre-Cutover Checklist

- Backend compiled build starts with DB/auth/orders/export env configured.
- `/health/ready` returns `status=ready` and `database.status=ok`.
- Admin or manager login through `/api/v1/auth/login` succeeds.
- `POST /api/v1/orders/:orderId/export/google-drive` works for an accessible
  order with `format=xlsx`.
- Browser sends only `{ "format": "xlsx" }` and optional `fileName`; it does
  not send `items`, `payments`, `clientPhone`, or `apiKey`.
- Backend writes `orders.export.requested` before the provider call and
  `orders.export` after provider success.
- Provider errors map to `EXPORT_PROVIDER_ERROR`; timeouts map to
  `EXPORT_PROVIDER_TIMEOUT`.
- Rate limit returns `RATE_LIMIT_EXCEEDED` before the provider call.

## Smoke

Automated mocked frontend cutover smoke:

```bash
npm run test:e2e:order-export-cutover
```

Runtime backend smoke should be run against the stage/test DB with real auth and
GAS env:

```bash
cd backend
npm run build
set -a
. ./.env.test-bd.local
set +a
PORT=3314 \
READINESS_REQUIRE_DATABASE=true \
BACKEND_ENABLE_AUTH=true \
BACKEND_ENABLE_ORDERS=true \
BACKEND_ENABLE_ORDER_EXPORT=true \
BACKEND_EXPORT_DISABLED=false \
JWT_ACCESS_SECRET=<local-smoke-secret> \
REFRESH_TOKEN_PEPPER=<local-smoke-pepper> \
npm start
```

Then verify:

- login as a user with `orders.export`;
- find an existing non-deleted order with at least one detail;
- call `POST /api/v1/orders/:orderId/export/google-drive` with
  `{ "format": "xlsx" }`;
- confirm the response has `success=true` and a file name or external id;
- confirm `audit_log` contains `orders.export.requested` and `orders.export`;
- confirm rollback with `BACKEND_EXPORT_DISABLED=true`.

Do not print real env values, bearer tokens, GAS keys, or full exported payloads
in logs.

## Rollback

Frontend-only rollback:

```env
VITE_USE_BACKEND_ORDER_EXPORT=false
```

Backend provider rollback:

```env
BACKEND_EXPORT_DISABLED=true
```

Backend module rollback:

```env
BACKEND_ENABLE_ORDER_EXPORT=false
```

Rollback is acceptable only while legacy `/api/order-export-to-drive` and its
GAS env remain deployed.
