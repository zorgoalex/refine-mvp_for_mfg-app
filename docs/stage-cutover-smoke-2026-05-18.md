# Stage/Cutover Smoke Evidence - 2026-05-18

## Scope

- Branch: `feat/backend-erp-stage1`
- Frontend: `https://app-test.mebelkz.app`
- Backend: `https://backend-test.mebelkz.app`
- Backend API: `https://backend-test.mebelkz.app/api/v1`
- Env file: `/home/ovhtest/projects/erp_dev/.env` loaded only through allowlisted smoke keys; secrets were not printed.

## Acceptance Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Runtime config matches `docs/runtime-config/canary/11-deadlines.json` | Not run | Run `npm run smoke:runtime-config -- --url=https://app-test.mebelkz.app/runtime-config.json --expect=docs/runtime-config/canary/11-deadlines.json`. |
| Backend `/health/live` and `/health/ready` pass with DB/Redis/config ready | Not run | Run through `npm run smoke:staging-gates`. |
| Legacy Vercel production-disable does not break `/runtime-config.json` | Not run | Runtime config smoke passes; optional legacy endpoint probe recorded separately. |
| Frontend routes load without GraphQL/runtime errors | Not run | Run `npm run test:e2e:frontend-pages-stage-canary`. |
| Payments backend canary passes with no Hasura payment mutations | Not run | Run `npm run test:e2e:payments-stage-canary`. |
| Production actions backend canary passes with audit/outbox/idempotency | Not run | Run `npm run test:e2e:production-actions-stage-canary`. |
| Client phones backend canary passes with audit/outbox/idempotency | Not run | Run `npm run test:e2e:client-phones-stage-canary`. |
| Deadline read-only stage canary passes | Not run | Run `npm run test:e2e:deadline-engine-stage-canary`. |
| Local backend cutover regression specs pass | Not run | Run the grouped Playwright command from `scripts/stage-cutover-smoke.js`. |
| `npm test` passes | Not run | Record file/test counts. |
| `npm run build` passes | Not run | Record existing Vite large chunk warning if still present. |

## Command Log

```bash
npm run smoke:stage-cutover
```

Result: Not run yet.

## Follow-Ups

- No follow-ups recorded before the smoke run.
