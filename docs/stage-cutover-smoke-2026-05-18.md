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
| Runtime config matches `docs/runtime-config/canary/11-deadlines.json` | Fail | `npm run smoke:stage-cutover` failed in `npm run smoke:runtime-config -- --url https://app-test.mebelkz.app/runtime-config.json --expect docs/runtime-config/canary/11-deadlines.json` because runtime config feature flags differed from the canary: `backendPayments`, `backendClientPhones`, and `backendProductionActions` were `false`; `backendReferences` was `true`. Classified as runtime config mismatch. No later gates were claimed. |
| Backend `/health/live` and `/health/ready` pass with DB/Redis/config ready | Not run | Run through `npm run smoke:staging-gates`. |
| Legacy Vercel production-disable does not break `/runtime-config.json` | Not run | Record runtime config smoke result; optionally record legacy endpoint probe separately. |
| Frontend routes load without GraphQL/runtime errors | Not run | Run `npm run test:e2e:frontend-pages-stage-canary`. |
| Payments backend canary passes with no Hasura payment mutations | Not run | Run `npm run test:e2e:payments-stage-canary`. |
| Production actions backend canary passes with audit/outbox/idempotency | Not run | Run `npm run test:e2e:production-actions-stage-canary`. |
| Client phones backend canary passes with audit/outbox/idempotency | Not run | Run `npm run test:e2e:client-phones-stage-canary`. |
| Deadline read-only stage canary passes | Not run | Run `npm run test:e2e:deadline-engine-stage-canary`. |
| Local backend cutover regression specs pass | Not run | Run the grouped Playwright command from `scripts/stage-cutover-smoke.js`. |
| `npm test` passes | Not run | Record file/test counts. |
| `npm run build` passes | Not run | Record existing Vite large chunk warning if still present. |

## Command Log

Result: Protected Vercel bypass env key presence check exited 0 and printed only `"Vercel bypass env key present"`.

```bash
npm run smoke:stage-cutover
```

Result: Failed at the first gate. Runtime config smoke printed mismatches for `features.backendPayments`, `features.backendClientPhones`, `features.backendProductionActions`, and `features.backendReferences`, then `Stage cutover smoke failed: runtime config all-on expectation failed with exit code 1`.

## Follow-Ups

- Align the staging runtime config feature flags with `docs/runtime-config/canary/11-deadlines.json` before rerunning the full `npm run smoke:stage-cutover` smoke.
