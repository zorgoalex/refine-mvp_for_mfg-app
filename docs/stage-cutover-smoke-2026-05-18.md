# Stage/Cutover Smoke Evidence - 2026-05-18

## Scope

- Branch: `feat/backend-erp-stage1`
- Frontend: `https://app-test.mebelkz.app`
- Backend: `https://backend-test.mebelkz.app`
- Backend API: `https://backend-test.mebelkz.app/api/v1`
- Env file: `/home/ovhtest/projects/erp_dev/.env`; load only through allowlisted smoke keys; do not print secrets.

## Acceptance Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Runtime config matches `docs/runtime-config/canary/11-deadlines.json` | Pass | `npm run smoke:stage-cutover` first gate printed `Runtime config smoke ok`; enabled features: `backendAuth`, `backendPermissions`, `backendOrdersRead`, `backendOrdersWrite`, `backendPayments`, `backendClientPhones`, `backendProductionActions`, `backendDeadlines`, `backendOrderExport`, `backendUsers`, `backendVlm`. |
| Backend `/health/live` and `/health/ready` pass with DB/Redis/config ready | Pass | `npm run smoke:staging-gates` printed live health `ok`, ready health `ready`, and `Staging gates smoke ok.` |
| Legacy Vercel production-disable does not break `/runtime-config.json` | Pass | Runtime config gate and staging gates both loaded `https://app-test.mebelkz.app/runtime-config.json` successfully. |
| Frontend routes load without GraphQL/runtime errors | Pass | `npm run test:e2e:frontend-pages-stage-canary` = 1 passed. |
| Payments backend canary passes with no Hasura payment mutations | Pass | `npm run test:e2e:payments-stage-canary` = 1 passed. |
| Production actions backend canary passes with audit/outbox/idempotency | Pass | `npm run test:e2e:production-actions-stage-canary` = 1 passed. |
| Client phones backend canary passes with audit/outbox/idempotency | Pass | `npm run test:e2e:client-phones-stage-canary` = 1 passed. |
| Deadline read-only stage canary passes | Pass | `npm run test:e2e:deadline-engine-stage-canary` = 1 passed. |
| Local backend cutover regression specs pass | Pass | Grouped Playwright cutover command = 15 passed; isolated order-save boundary command = 1 passed. |
| `npm test` passes | Pass | 134 test files passed; 521 tests passed, 2 skipped. |
| `npm run build` passes | Pass | Vite production build completed; existing large chunk warning remains. |

## Command Log

```bash
npm run smoke:stage-cutover
```

Result on 2026-05-19: passed end-to-end. The orchestrator completed runtime config, staging gates, frontend pages, payments, production actions, client phones, deadline engine, local cutover regression specs, isolated order-save command boundary, full unit suite, and production build.

## Follow-Ups

- Runtime config blocker from 2026-05-18 is closed.
- Existing Vite large chunk warning remains a frontend performance backlog item, not a cutover smoke failure.
