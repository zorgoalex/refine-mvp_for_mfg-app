# Security Manual Checklist - 2026-05-17

## Scope

- Branch: `feat/backend-erp-stage1`
- Goal: close PRD v1 backend acceptance debt item `security/manual checklist`.
- Source handoff: `session-handoffs/2026-05-17-security-manual-checklist-handoff.md`
- Stage backend: `https://backend-test.mebelkz.app/api/v1`
- Stage frontend: `https://app-test.mebelkz.app`

## Status Legend

- `Pass`: verified by code/test/stage evidence in this document.
- `Follow-up`: not blocking this checklist, but recorded as a concrete remaining debt item.
- `Blocked`: could not be verified because required runtime, credentials, or network access was unavailable.
- `Fail`: verified defect that must be fixed before this checklist can close.

## Evidence Summary

| Area | Status | Evidence |
| --- | --- | --- |
| Auth and sessions | Pass | Focused auth/session tests passed; see Auth And Sessions section. |
| Cookies, CORS, and runtime env | Pass | Focused runtime/CORS/readiness tests passed; stage readiness is recorded in Stage Manual Smoke. |
| Legacy Vercel functions and rollback gates | Pass | Focused legacy/runtime-config tests passed; see Legacy Vercel Functions And Rollback Gates section. |
| API authorization boundaries | Pass | Focused backend authorization tests passed; broader Playwright client-phones no-fallback smoke failed on notification visibility and is not used as pass evidence. |
| Rate limit | Pass | Focused rate-limit tests passed for Redis-backed policy, local/test memory fallback, auth/order/VLM consumers, Redis readiness code coverage, live stage `/health/ready` Redis readiness, and login 429 stage smoke. The login smoke returned 10x `401 INVALID_CREDENTIALS`, then `429 RATE_LIMIT_EXCEEDED`. |
| Secrets and logging | Follow-up | Focused redaction/error tests passed for the backend redaction utility and public error responses, but production logger wiring is not proven and legacy `api/_lib/logger.ts` serializes meta/error directly. |
| Audit expectations | Follow-up | Implemented backend-owned command audit is covered for auth, users, orders, payments, client phones, production actions, VLM, and deadlines; denied sensitive action audit was not found as explicit coverage and remains follow-up. |
| Hasura boundary | Follow-up | Retained Hasura reads/report/reference usage and accepted no-mutation guards are documented; known `useOrderSave` nested payments `forceHasuraMutation` exception remains follow-up debt. |
| Stage manual smoke | Pass | Stage backend `/health/ready` passed on 2026-05-17 with database, Redis, and config ok. After loading `/home/ovhtest/projects/erp_dev/.env` without printing secrets, protected frontend runtime flags were checked and deadline/frontend pages stage canaries passed. |

## Auth And Sessions

| Check | Status | Evidence |
| --- | --- | --- |
| Login requires backend auth and returns access token only where expected. | Pass | `backend/src/modules/auth/http/auth.controller.test.ts` asserts disabled auth fails closed and login returns the auth response without `refreshToken`; `src/api/authApi.test.ts` asserts backend login stores only access token/user in memory. Focused command passed: `npm test -- backend/src/modules/auth src/authProvider.test.ts src/api/authApi.test.ts src/utils/auth.test.ts`. |
| Refresh token is HttpOnly cookie-backed in backend mode. | Pass | `backend/src/modules/auth/http/auth.controller.test.ts` asserts `httpOnly: true`, auth login JSON has no `refreshToken`, and refresh rotates the cookie; `backend/src/modules/auth/refresh-cookie.test.ts` asserts the refresh cookie contract. Focused command passed: `npm test -- backend/src/modules/auth src/authProvider.test.ts src/api/authApi.test.ts src/utils/auth.test.ts`. |
| Backend auth mode has no `localStorage refresh_token` dependency. | Pass | `src/authProvider.test.ts` asserts backend login stores no `refresh_token` or `access_token` in `localStorage`; `src/utils/auth.test.ts` asserts backend refresh uses `/api/v1/auth/refresh`, not the legacy refresh endpoint, and leaves `localStorage refresh_token` empty. Focused command passed: `npm test -- backend/src/modules/auth src/authProvider.test.ts src/api/authApi.test.ts src/utils/auth.test.ts`. |
| Refresh rotation/reuse detection tests exist and pass. | Pass | `backend/src/modules/auth/adapters/pg-auth-session-manager.test.ts` asserts atomic refresh rotation, revoked-token reuse detection, session status `reuse_detected`, and reuse audit logging without raw refresh token storage. Focused command passed: `npm test -- backend/src/modules/auth src/authProvider.test.ts src/api/authApi.test.ts src/utils/auth.test.ts`. |
| Logout/session revoke behavior is covered. | Pass | `backend/src/modules/auth/http/auth.controller.test.ts` asserts logout delegates session revocation and clears the HttpOnly refresh cookie; `backend/src/modules/auth/adapters/pg-auth-session-manager.test.ts` asserts logout audit/session revoke behavior without storing raw refresh tokens; `src/authProvider.test.ts` and `src/api/authApi.test.ts` assert frontend logout clears memory session. Focused command passed: `npm test -- backend/src/modules/auth src/authProvider.test.ts src/api/authApi.test.ts src/utils/auth.test.ts`. |
| `/api/v1/me` is protected and returns user + permissions. | Pass | `backend/src/modules/auth/http/auth.controller.test.ts` asserts `/api/v1/me` requires current user and returns user permissions without tokens; `src/api/authApi.test.ts` asserts `/api/v1/me` stores the current user without changing the access token. Focused command passed: `npm test -- backend/src/modules/auth src/authProvider.test.ts src/api/authApi.test.ts src/utils/auth.test.ts`. |

## Cookies, CORS, And Runtime Env

| Check | Status | Evidence |
| --- | --- | --- |
| CORS does not allow wildcard credentials in production/staging-like env. | Pass | `backend/src/config/env.validation.ts` rejects `CORS_ALLOWED_ORIGINS` containing `*` when `CORS_ALLOW_CREDENTIALS=true`; covered by `backend/src/config/cors.test.ts`. Verified with `npm test -- backend/src/config/cors.test.ts backend/src/config/env.validation.test.ts backend/src/modules/health/health.service.test.ts backend/src/modules/auth/refresh-cookie.test.ts`. |
| Refresh cookie flags are appropriate for production/staging. | Pass | `backend/src/config/env.validation.ts` requires `REFRESH_COOKIE_SECURE=true` when `REFRESH_COOKIE_SAME_SITE=none` and auth is enabled; `backend/src/modules/auth/refresh-cookie.test.ts` verifies production Secure cookies and staging cross-site canary attributes. Verified with focused command above. |
| Required backend env validation covers auth, CORS, DB, Redis/rate-limit, feature flags. | Pass | `backend/src/config/env.validation.ts` validates auth DB/secrets, CORS credentials, DB readiness requirements, Redis/rate-limit settings, staging/production Redis rate-limit store, and deadline feature flags. Covered by `backend/src/config/env.validation.test.ts`; focused command above exited 0. |
| `/health/ready` checks required dependencies in stage-like runtime. | Pass | Code readiness in `backend/src/modules/health/health.service.ts` verifies DB when `READINESS_REQUIRE_DATABASE=true` and Redis when `READINESS_REQUIRE_REDIS=true`; `backend/src/modules/health/health.service.test.ts` covers required DB ping, DB failure, and required Redis ping. Live stage command passed on 2026-05-17: `curl -fsS https://backend-test.mebelkz.app/health/ready | jq` returned `status: ready` with `database.status=ok`, `redis.status=ok`, and `config.status=ok`. |
| Runtime flags are fail-closed where needed and dependencies are explicit. | Pass | `backend/src/config/env.validation.ts` defaults deadline write/export controls to read-only/disabled and requires explicit dependencies for auth, readiness DB, Redis readiness, and Redis-backed rate limits; verified by `backend/src/config/env.validation.test.ts` with the focused command above. |

## Legacy Vercel Functions And Rollback Gates

| Check | Status | Evidence |
| --- | --- | --- |
| Legacy endpoints are disabled in production/staging-like env except `/runtime-config.json`. | Pass | `api/_lib/legacy-production-gate.ts` disables production-like `production`/`prod`/`staging`/`stage`/`preview` legacy functions with `LEGACY_VERCEL_FUNCTION_DISABLED`; `api/legacy-vercel-functions-disabled.test.ts` covers login, refresh, users, order export, and VLM handlers returning 410 while `api/runtime-config.ts` remains the production exception that serves `/runtime-config.json`. |
| Emergency opt-in variables are explicit. | Pass | `api/_lib/legacy-production-gate.ts` only bypasses the production-like legacy gate when `ENABLE_LEGACY_VERCEL_FUNCTIONS` or `ENABLE_LEGACY_API` is explicitly truthy; `api/_lib/legacy-production-gate.test.ts` covers both emergency opt-ins. |
| Tests for `LEGACY_VERCEL_FUNCTION_DISABLED` behavior pass. | Pass | Focused command passed on 2026-05-17: `npm test -- api/legacy-vercel-functions-disabled.test.ts api/_lib/legacy-production-gate.test.ts api/_lib/frontend-runtime-config.test.ts api/runtime-config.test.ts src/api/legacyApiRoutes.test.ts src/config/featureFlags.test.ts` (6 files, 34 tests). |
| Frontend backend-enabled paths do not silently fall back to legacy endpoints for auth/users/orders/export/VLM/deadlines. | Pass | `src/api/legacyApiRoutes.ts` centralizes rollback-only unversioned `/api/*` endpoints and `src/api/legacyApiRoutes.test.ts` asserts they do not include `/api/v1/`; `api/_lib/frontend-runtime-config.test.ts`, `api/runtime-config.test.ts`, and `src/config/featureFlags.test.ts` cover fail-closed runtime flags and backend-enabled overrides. Stage canary code references `tests/frontend-pages-stage-canary.spec.ts` and `tests/deadline-engine-stage-canary.spec.ts` assert backend `/api/v1/auth/login`, runtime `backendAuth`/`backendOrdersRead`/`backendDeadlines`, and no mutating deadline GraphQL fallback paths. |

## API Authorization Boundaries

| Check | Status | Evidence |
| --- | --- | --- |
| Representative protected endpoints reject missing/invalid auth. | Pass | `backend/src/permissions/permissions.guard.test.ts` asserts missing user returns `AUTH_REQUIRED` 401 and missing `orders.update` permission returns `PERMISSION_DENIED` 403; controller tests in orders/users/VLM also reject missing `request.user`. |
| Orders policy tests cover API denial. | Pass | `backend/src/permissions/policies/order-access.policy.test.ts` denies manager access to foreign orders, worker whole-order update, and viewer update/export; `backend/src/modules/orders/http/orders.controller.test.ts` and `backend/src/modules/orders/http/order-export.controller.test.ts` reject missing users and service-level denials. |
| Payments policy tests cover API denial. | Pass | `backend/src/permissions/policies/payment-access.policy.test.ts` denies manager payment creation/update on foreign orders and operator payment view; `backend/src/modules/payments/http/payments.controller.test.ts` covers controller rejection paths. |
| Users policy tests cover API denial. | Pass | `backend/src/permissions/policies/user-access.policy.test.ts` blocks lower-role administration, admin peer/superadmin management, self-deactivation, and activation without target manageability; `backend/src/modules/users/http/users.controller.test.ts` rejects missing users and service denials. |
| Production actions policy tests cover API denial. | Pass | `backend/src/modules/production-actions/application/production-action.service.test.ts` requires command-specific permissions before delegation; `backend/src/modules/production-actions/adapters/pg-production-action-repository.test.ts` denies manager actions outside own order scope before mutation. Focused backend command `npm test -- backend/src/modules/production-actions backend/src/modules/client-phones` passed (6 files, 27 tests); targeted Playwright manager-scope denial case also passed. |
| Client phones policy tests cover API denial. | Pass | `backend/src/modules/client-phones/application/client-phone.service.test.ts` returns `PERMISSION_DENIED` 403 for worker/viewer create attempts before repository calls; `backend/src/modules/client-phones/http/client-phones.controller.test.ts` covers fail-closed runtime and validation paths. Focused backend command `npm test -- backend/src/modules/production-actions backend/src/modules/client-phones` passed (6 files, 27 tests). `tests/client-phones-backend-cutover.spec.ts` no-fallback UI smoke was attempted separately but failed on notification visibility, so it is not used as pass evidence here. |
| VLM policy tests cover API denial. | Pass | `backend/src/modules/vlm/application/vlm.service.test.ts` requires `vlm.health.view` for health and `vlm.use` for upload/analyze; `backend/src/modules/vlm/http/vlm.controller.test.ts` rejects missing users. |
| Deadline Engine policy tests cover API denial. | Pass | `backend/src/modules/deadlines/application/deadline-query.service.test.ts` and `backend/src/modules/deadlines/application/deadline-command.service.test.ts` assert `PERMISSION_DENIED` 403 for missing deadline permissions; deadline HTTP tests fail closed when disabled/read-only. |
| UI hiding is not treated as a security boundary. | Pass | Authorization evidence above is from backend guard, policy, service, repository, controller, and backend-enabled cutover tests; UI-only hiding was not used as pass evidence. |

## Rate Limit

| Check | Status | Evidence |
| --- | --- | --- |
| Redis/Valkey-backed rate limit is enabled for stage/prod-like runtime. | Pass | `backend/src/rate-limit/rate-limit.module.ts` selects `RedisRateLimitStore` when `BACKEND_RATE_LIMIT_STORE=redis` using `RATE_LIMIT_REDIS_URL` or `REDIS_URL`; `backend/src/config/env.validation.test.ts` confirms staging requires `BACKEND_RATE_LIMIT_STORE=redis` plus a Redis URL. Focused test command passed 2026-05-17. |
| Memory fallback is only local/test-safe. | Pass | `backend/src/rate-limit/rate-limit.module.ts` falls back to `MemoryRateLimitStore` only when the store is not `redis`; `backend/src/config/env.validation.test.ts` rejects staging without Redis-backed settings while focused memory-store tests cover local/test behavior. Focused test command passed 2026-05-17. |
| Stage readiness includes Redis. | Pass | Live stage command passed on 2026-05-17: `curl -fsS https://backend-test.mebelkz.app/health/ready | jq` returned `status: ready` with `redis.status=ok`. Code/test coverage also verifies `READINESS_REQUIRE_REDIS=true` pings Redis through the rate-limit service and staging Redis settings are required. |
| Login rate-limit smoke evidence is documented or rerun. | Pass | Stage smoke rerun on 2026-05-17 against `https://backend-test.mebelkz.app/api/v1/auth/login` with a unique nonexistent username and dummy password. Attempts 1-10 returned `401 INVALID_CREDENTIALS`; attempt 11 returned `429 RATE_LIMIT_EXCEEDED`. No secrets were printed. |

## Secrets And Logging

| Check | Status | Evidence |
| --- | --- | --- |
| Passwords and password hashes are redacted from logs/errors/tests. | Follow-up | Utility-level evidence exists: `backend/src/common/logging/redaction.ts` treats `/password/i` and `/password_hash/i` keys as sensitive, and `backend/src/common/logging/redaction.test.ts` asserts recursive password redaction and `password_hash` key detection. Focused command passed 2026-05-17: `npm test -- backend/src/common/logging/redaction.test.ts backend/src/common/errors api/legacy-vercel-functions-disabled.test.ts` (3 files, 16 tests). Gap: Step 1 search did not find production logger wiring for `redactLogValue`/`redactLogFields`, and legacy `api/_lib/logger.ts` serializes `meta`/`error` directly. |
| Access/refresh tokens and Authorization header are redacted. | Follow-up | Utility-level evidence exists: `backend/src/common/logging/redaction.ts` redacts token-like keys, bearer tokens, JWT strings, and `access_token`/`refresh_token` query values; `backend/src/common/logging/redaction.test.ts` asserts `Authorization: Bearer ...`, `access_token`, and `refresh_token` string redaction. Gap: redaction utility wiring into all actual log sinks was not proven. |
| GAS/VLM/Auth0/provider secrets are redacted. | Follow-up | Utility-level evidence exists: `backend/src/common/logging/redaction.ts` treats `secret`, `api_key`, `gas_api_key`, and `client_secret` keys as sensitive; `backend/src/common/logging/redaction.test.ts` asserts `GAS_API_KEY` and `AUTH0_M2M_CLIENT_SECRET` key coverage. Gap: redaction utility wiring into all actual log sinks was not proven. |
| Raw file content is not logged in covered paths. | Pass | Covered VLM upload path reads bytes for provider upload but audit metadata is limited to `contentType`, `size`, and `purpose` in `backend/src/modules/vlm/adapters/pg-vlm-provider.ts`; `backend/src/modules/vlm/adapters/pg-vlm-provider.test.ts` asserts upload audit metadata. Search evidence found no backend VLM raw byte logging; legacy `useOrderSave` logs file-link fields and errors, not uploaded raw file bytes. |
| Error responses expose request IDs and public error codes, not secrets. | Pass | `backend/src/common/errors/api-error.ts` formats `{ error: { code, message, details?, requestId } }`; `createInternalError` emits `INTERNAL_ERROR` with request ID only. `backend/src/common/errors/api-error.test.ts` covers public code/request ID and generic internal errors. `api/legacy-vercel-functions-disabled.test.ts` passed in the focused command above, covering disabled legacy responses. |

## Audit Expectations

| Check | Status | Evidence |
| --- | --- | --- |
| Existing backend-owned commands write audit events where implemented. | Pass | Step 3 search found implemented `INSERT INTO audit_log` coverage for auth failed login/session events, orders create/update/delete/export/snapshot, users create/change-password/deactivate, payments create/update/delete, client phones create/update/delete/primary demote, production actions, VLM upload/analyze, and deadline events. Representative tests include `backend/src/modules/auth/adapters/pg-auth-audit-repository.test.ts`, `backend/src/modules/orders/adapters/pg-order-transaction-manager.test.ts`, `backend/src/modules/users/adapters/pg-user-repository.test.ts`, `backend/src/modules/payments/adapters/pg-payment-repository.test.ts`, `backend/src/modules/client-phones/adapters/pg-client-phone-repository.test.ts`, `backend/src/modules/production-actions/adapters/pg-production-action-repository.test.ts`, `backend/src/modules/vlm/adapters/pg-vlm-provider.test.ts`, `backend/src/modules/deadlines/adapters/pg-deadline-repository.test.ts`, and `backend/db/migrations/004_production_actions_audit_outbox.test.ts`. |
| Denied sensitive action audit is documented as implemented or follow-up. | Follow-up | Step 3 search found many denial paths returning `AUTH_REQUIRED`/`PERMISSION_DENIED` and backend-cutover forbidden cases, but no explicit denied-action `audit_log` write/test comparable to successful command audit. Keep as follow-up before claiming denied sensitive action audit coverage. |

## Hasura Boundary

| Check | Status | Evidence |
| --- | --- | --- |
| Retained Hasura use is read/report/reference only. | Pass | Step 4 search found retained Hasura configuration/data-provider usage and spec evidence in `/home/ovhtest/projects/erp_dev/spec_erp/docs/frontend-data-source-parity-matrix.md` allowing lookup/report/reference reads, plus `tests/payments-backend-cutover.spec.ts` explicitly keeps Hasura reads while routing payment mutations to `/api/v1`. |
| Backend-owned mutation flows have tests or network guards preventing forbidden Hasura mutations where accepted. | Pass | `tests/production-actions-backend-cutover.spec.ts` guards `update_orders`, `insert_production_status_events`, and `delete_production_status_events` mutations and asserts no matches; `tests/payments-backend-cutover.spec.ts` guards `insert/update/delete_payments` and asserts none; `src/hooks/useOrderSaveBackend.test.ts` covers backend order create/update behavior. |
| Known exception `useOrderSave` / nested payments is documented as next command-boundary debt. | Follow-up | `src/hooks/useOrderSave.ts` still defines `LEGACY_ORDER_SAVE_PAYMENT_META = { forceHasuraMutation: true }` and applies it to nested payment create/update/delete within the legacy order-save path. Step 4 search and `/home/ovhtest/projects/erp_dev/spec_erp/docs/full-backend-remaining-work-2026-05-11.md` identify this as the next backend-owned command-boundary debt, not a failure for this checklist. |

## Stage Manual Smoke

| Check | Status | Evidence |
| --- | --- | --- |
| Stage backend readiness was checked. | Pass | Command passed on 2026-05-17 without secrets: `curl -fsS https://backend-test.mebelkz.app/health/ready | jq` returned JSON `status: ready`; checks included `database.status=ok`, `redis.status=ok`, and `config.status=ok`. |
| Stage frontend runtime flags were checked without printing secrets. | Pass | After loading `/home/ovhtest/projects/erp_dev/.env` without printing secrets, `https://app-test.mebelkz.app/runtime-config.json` was checked through the Vercel bypass header. Runtime features included `backendAuth=true`, `backendPermissions=true`, `backendOrdersRead=true`, `backendOrdersWrite=true`, `backendPayments=false`, `backendClientPhones=false`, `backendProductionActions=false`, `backendDeadlines=true`, `backendOrderExport=true`, `backendUsers=true`, `backendVlm=true`, `backendReferences=true`, and `enableLegacyHasura=true`. |
| Stage deadline/frontend canaries were rerun. | Pass | `npm run test:e2e:deadline-engine-stage-canary` passed on 2026-05-17 (1 passed). `npm run test:e2e:frontend-pages-stage-canary` passed on 2026-05-17 (1 passed) with explicit overrides: `FRONTEND_PAGES_STAGE_FRONTEND_URL=https://app-test.mebelkz.app`, `FRONTEND_PAGES_STAGE_BACKEND_API_URL=https://backend-test.mebelkz.app/api/v1`, `FRONTEND_PAGES_STAGE_POSTGRES_CONTAINER=erp_test-postgresdb-1`, and `FRONTEND_PAGES_STAGE_CREATE_USER=true`. |

## Follow-Up Items

| Item | Severity | Owner Area | Evidence |
| --- | --- | --- | --- |
| `useOrderSave` / nested payments Hasura mutation exception remains the next command-boundary debt after this checklist. | High | Frontend/backend command boundary | Current priority context keeps this out of this checklist scope. |
| Denied sensitive action audit is not explicitly implemented for permission-denied/backend-forbidden paths. | Medium | Backend audit/security | Step 3 found `PERMISSION_DENIED`/forbidden tests and successful command audit writes, but did not find explicit denied-action audit writes/tests. |
| Production logger redaction wiring is not proven for all log sinks. | Medium | Backend/legacy logging | Redaction utility tests pass, but Step 1 did not find production imports of `redactLogValue`/`redactLogFields`; legacy `api/_lib/logger.ts` serializes `meta` and `error` directly. |

## Final Decision

- Checklist result: Closed with documented follow-up items.
- Blocking failures: none.
- Blocked checks: none after rerun with `/home/ovhtest/projects/erp_dev/.env`.
- Follow-up items:
  - `useOrderSave` / nested payments Hasura mutation exception remains the next command-boundary debt.
  - Denied sensitive action audit remains future work because explicit denied-action audit evidence was not found.
  - Production logger redaction wiring remains future work because utility tests pass, but all production log sinks are not proven to use it.
- Verification before completion:
  - `npm test`: passed on 2026-05-17 (130 files, 500 tests passed, 2 skipped).
  - `npm run build`: passed on 2026-05-17 with the existing Vite large chunk warning.
  - Protected `runtime-config.json`: passed on 2026-05-17 with `backendAuth=true`, `backendOrdersRead=true`, and `backendDeadlines=true`.
  - `npm run test:e2e:deadline-engine-stage-canary`: passed on 2026-05-17 (1 passed).
  - `npm run test:e2e:frontend-pages-stage-canary`: passed on 2026-05-17 (1 passed) with explicit app-test/backend-test/container/create-user overrides.
  - Login 429 stage smoke: passed on 2026-05-17 with 10x `401 INVALID_CREDENTIALS`, then `429 RATE_LIMIT_EXCEEDED`.
  - `git status --short --branch --untracked-files=all`: branch `feat/backend-erp-stage1` ahead of origin; only intentional untracked `session-handoffs/*.md` files remain.
