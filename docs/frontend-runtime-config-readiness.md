# Frontend Runtime Config Readiness

Purpose: let production canary and rollback switch backend frontend flows
without rebuilding the Vite bundle.

## Runtime Config

The app tries to load this file before rendering React:

```txt
/runtime-config.json
```

If the file is missing, invalid, or times out, frontend falls back to build-time
`VITE_*` env values.

Example:

```json
{
  "apiUrl": "https://api.example.com",
  "features": {
    "backendAuth": false,
    "backendPermissions": false,
    "backendOrdersRead": false,
    "backendOrdersWrite": false,
    "backendOrderExport": false,
    "backendUsers": false,
    "backendVlm": false,
    "backendReferences": false
  }
}
```

`public/runtime-config.example.json` is an example only. The deployed
`/runtime-config.json` should be provided by the hosting environment, not
committed with production secrets or environment-specific values.

## Build-Time Fallback

These env values remain supported:

```env
VITE_API_URL=http://localhost:3000
VITE_USE_BACKEND_AUTH=false
VITE_USE_BACKEND_PERMISSIONS=false
VITE_USE_BACKEND_ORDERS_READ=false
VITE_USE_BACKEND_ORDERS_WRITE=false
VITE_USE_BACKEND_ORDER_EXPORT=false
VITE_USE_BACKEND_USERS=false
VITE_USE_BACKEND_VLM=false
VITE_USE_BACKEND_REFERENCES=false
VITE_ENABLE_LEGACY_HASURA=true
```

Optional:

```env
VITE_RUNTIME_CONFIG_URL=/runtime-config.json
```

## Rollback Rules

- Frontend soft rollback should change `features.*` in `/runtime-config.json`.
- Missing runtime keys do not override build-time fallback values.
- `backendOrders` is accepted as a compatibility shortcut for both
  `backendOrdersRead` and `backendOrdersWrite`.
- `apiUrl` overrides `VITE_API_URL` only when it is a non-empty string.
- Backend module flags remain the final safety gate; frontend flags only choose
  the browser route.

## Staged Canary

Staged canary examples and the full checklist live in
`docs/runtime-config-canary-readiness.md`.

Example runtime config files:

```txt
docs/runtime-config/canary/00-all-off.json
docs/runtime-config/canary/01-backend-auth.json
docs/runtime-config/canary/02-backend-permissions.json
docs/runtime-config/canary/03-orders-read.json
docs/runtime-config/canary/04-orders-write.json
docs/runtime-config/canary/05-order-export.json
docs/runtime-config/canary/06-users.json
docs/runtime-config/canary/07-vlm.json
docs/runtime-config/canary/99-rollback-all-off.json
```

Validate staged examples:

```bash
npm run test:runtime-config-canary
```

Smoke a deployed runtime config without printing the config body:

```bash
npm run smoke:runtime-config -- \
  --url=https://example.com/runtime-config.json \
  --expect=docs/runtime-config/canary/03-orders-read.json
```

## Smoke

Automated mocked frontend runtime-config smoke:

```bash
npm run test:e2e:runtime-config
```

Unit coverage:

```bash
npm test -- featureFlags runtimeConfig runtimeConfigCanaryExamples httpClient
```
