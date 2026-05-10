# Runtime Config Canary Readiness

Purpose: prepare staged frontend runtime config files and smoke commands for
turning on backend flows one at a time. This does not approve production
cutover and does not enable backend modules by itself.

## Staged Examples

Example files live in `docs/runtime-config/canary/`.

| Step | File | Enabled frontend features |
|---|---|---|
| 0 | `00-all-off.json` | none |
| 1 | `01-backend-auth.json` | `backendAuth` |
| 2 | `02-backend-permissions.json` | `backendAuth`, `backendPermissions` |
| 3 | `03-orders-read.json` | previous + `backendOrdersRead` |
| 4 | `04-orders-write.json` | previous + `backendOrdersWrite` |
| 5 | `05-order-export.json` | previous + `backendOrderExport` |
| 6 | `06-users.json` | previous + `backendUsers` |
| 7 | `07-vlm.json` | previous + `backendVlm` |
| 8 | `08-payments.json` | previous + `backendPayments` |
| rollback | `99-rollback-all-off.json` | none |

Each file is complete and explicit about every supported runtime feature key.
`apiUrl` is intentionally empty in the examples so the deployment can keep
using `VITE_API_URL`; set it only in the hosting runtime config source.

Vercel delivery is wired through `api/runtime-config.ts` and the
`/runtime-config.json -> /api/runtime-config` rewrite in `vercel.json`.
Production/staging should set `RUNTIME_CONFIG_*` env vars in hosting settings,
not commit an environment-specific `public/runtime-config.json`.

## Required Gates

- Backend `/health/ready` must return `status=ready` with database ok before
  any backend frontend flag is enabled for canary.
- Backend module flags remain the final safety gate. Frontend runtime flags
  only choose the browser route.
- Keep legacy `/api/*` endpoints deployed while the matching backend canary and
  rollback checks are still in progress.
- Do not put secrets, tokens, provider URLs with credentials, GAS keys, Auth0
  secrets, or database URLs into `/runtime-config.json`.
- Do not enable all backend frontend flags at once in production.

## Hosting Env Contract

```env
RUNTIME_CONFIG_API_URL=
RUNTIME_CONFIG_BACKEND_AUTH=false
RUNTIME_CONFIG_BACKEND_PERMISSIONS=false
RUNTIME_CONFIG_BACKEND_ORDERS_READ=false
RUNTIME_CONFIG_BACKEND_ORDERS_WRITE=false
RUNTIME_CONFIG_BACKEND_PAYMENTS=false
RUNTIME_CONFIG_BACKEND_ORDER_EXPORT=false
RUNTIME_CONFIG_BACKEND_USERS=false
RUNTIME_CONFIG_BACKEND_VLM=false
RUNTIME_CONFIG_BACKEND_REFERENCES=false
```

`RUNTIME_CONFIG_BACKEND_ORDERS=true` is accepted as a compatibility shortcut for
both orders read/write, but canary should use the split read/write flags.

## Validation

Validate committed canary examples:

```bash
npm run test:runtime-config-canary
```

The validator checks that:

- every example has the full `features.*` key set;
- all values are booleans;
- no unknown runtime feature keys are present;
- the staged sequence is cumulative and only adds one flow at a time;
- rollback returns every backend frontend flag to `false`;
- obvious secret-like keys are not present.

Unit/runtime coverage:

```bash
npm test -- featureFlags runtimeConfig runtimeConfigCanaryExamples
```

Mocked browser smoke:

```bash
npm run test:e2e:runtime-config
```

Fetch and compare a deployed runtime config:

```bash
npm run smoke:runtime-config -- \
  --url=https://example.com/runtime-config.json \
  --expect=docs/runtime-config/canary/03-orders-read.json
```

Smoke staging gates after deploy:

```bash
npm run smoke:staging-gates -- \
  --frontend-url=https://staging.example.com \
  --backend-url=https://api-staging.example.com \
  --expect=docs/runtime-config/canary/00-all-off.json
```

Add `--check-legacy` when the staging frontend domain should still expose legacy
rollback paths. The legacy check uses `HEAD`/`OPTIONS` only and treats `404` as
missing; it does not send business payloads.

Protected Vercel previews require a Protection Bypass for Automation secret:

```bash
VERCEL_AUTOMATION_BYPASS_SECRET=... \
npm run smoke:staging-gates -- \
  --frontend-url=https://staging.example.com \
  --backend-url=https://api-staging.example.com \
  --expect=docs/runtime-config/canary/00-all-off.json
```

The value is sent as `x-vercel-protection-bypass` and is not printed.

For local file smoke:

```bash
npm run smoke:runtime-config -- \
  --file=docs/runtime-config/canary/03-orders-read.json
```

The smoke script prints only the enabled flag names, not the config body.

## Canary Checklist

1. Deploy backend-capable frontend with `00-all-off.json` behavior.
2. Confirm legacy auth, orders, users, export, and VLM still work.
3. Enable `01-backend-auth.json` for canary; smoke login, refresh, `/api/v1/me`,
   logout, and auth rollback.
4. Enable `02-backend-permissions.json`; smoke menu visibility and backend
   permission enforcement.
5. Enable `03-orders-read.json`; compare orders list/show/edit-load with legacy
   data for the same filters.
6. Enable `04-orders-write.json`; smoke create/update, version conflict, audit,
   and read-only backend rollback. Do not retry failed saves through legacy.
7. Enable `05-order-export.json`; smoke minimal browser payload and backend
   export audit. Keep legacy GAS proxy available.
8. Enable `06-users.json` for admin canary; smoke users list/create/update,
   password change, deactivate/activate, and rollback.
9. Enable `07-vlm.json`; smoke health, upload, analyze by `uploadId`, arbitrary
   external `imageUrl` rejection, audit, quota/rate-limit behavior, and rollback.
10. Enable `08-payments.json`; smoke standalone payment create/update/delete,
    parent order paid/date/status/version recalculation, audit/session user, and
    rollback to legacy Hasura mutations by disabling `backendPayments` and
    `BACKEND_ENABLE_PAYMENTS`.
11. Expand canary only after scoped smoke, rollback smoke, logs, and audit checks
    are clean for the previous step.

## Rollback

Frontend-only rollback uses the previous staged file or
`99-rollback-all-off.json`. Backend rollback must use the matching module flag:

```env
BACKEND_ORDERS_READ_ONLY=true
BACKEND_EXPORT_DISABLED=true
BACKEND_VLM_DISABLED=true
BACKEND_ENABLE_USERS=false
BACKEND_ENABLE_ORDER_EXPORT=false
BACKEND_ENABLE_PAYMENTS=false
BACKEND_ENABLE_VLM=false
```

Auth rollback is higher risk because token storage changes. Prefer canary
disable first, then full frontend release rollback if backend auth cannot be
stabilized quickly.
