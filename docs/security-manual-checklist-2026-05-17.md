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
| Auth and sessions | Blocked | Evidence not collected yet. |
| Cookies, CORS, and runtime env | Blocked | Evidence not collected yet. |
| Legacy Vercel functions and rollback gates | Blocked | Evidence not collected yet. |
| API authorization boundaries | Blocked | Evidence not collected yet. |
| Rate limit | Blocked | Evidence not collected yet. |
| Secrets and logging | Blocked | Evidence not collected yet. |
| Audit expectations | Blocked | Evidence not collected yet. |
| Hasura boundary | Blocked | Evidence not collected yet. |
| Stage manual smoke | Blocked | Evidence not collected yet. |

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
| `/health/ready` checks required dependencies in stage-like runtime. | Pass | Code readiness in `backend/src/modules/health/health.service.ts` verifies DB when `READINESS_REQUIRE_DATABASE=true` and Redis when `READINESS_REQUIRE_REDIS=true`; `backend/src/modules/health/health.service.test.ts` covers required DB ping, DB failure, and required Redis ping. Stage runtime evidence is recorded later in Task 10. |
| Runtime flags are fail-closed where needed and dependencies are explicit. | Pass | `backend/src/config/env.validation.ts` defaults deadline write/export controls to read-only/disabled and requires explicit dependencies for auth, readiness DB, Redis readiness, and Redis-backed rate limits; verified by `backend/src/config/env.validation.test.ts` with the focused command above. |

## Legacy Vercel Functions And Rollback Gates

| Check | Status | Evidence |
| --- | --- | --- |
| Legacy endpoints are disabled in production/staging-like env except `/runtime-config.json`. | Blocked | Evidence not collected yet. |
| Emergency opt-in variables are explicit. | Blocked | Evidence not collected yet. |
| Tests for `LEGACY_VERCEL_FUNCTION_DISABLED` behavior pass. | Blocked | Evidence not collected yet. |
| Frontend backend-enabled paths do not silently fall back to legacy endpoints for auth/users/orders/export/VLM/deadlines. | Blocked | Evidence not collected yet. |

## API Authorization Boundaries

| Check | Status | Evidence |
| --- | --- | --- |
| Representative protected endpoints reject missing/invalid auth. | Blocked | Evidence not collected yet. |
| Orders policy tests cover API denial. | Blocked | Evidence not collected yet. |
| Payments policy tests cover API denial. | Blocked | Evidence not collected yet. |
| Users policy tests cover API denial. | Blocked | Evidence not collected yet. |
| Production actions policy tests cover API denial. | Blocked | Evidence not collected yet. |
| Client phones policy tests cover API denial. | Blocked | Evidence not collected yet. |
| VLM policy tests cover API denial. | Blocked | Evidence not collected yet. |
| Deadline Engine policy tests cover API denial. | Blocked | Evidence not collected yet. |
| UI hiding is not treated as a security boundary. | Blocked | Evidence not collected yet. |

## Rate Limit

| Check | Status | Evidence |
| --- | --- | --- |
| Redis/Valkey-backed rate limit is enabled for stage/prod-like runtime. | Blocked | Evidence not collected yet. |
| Memory fallback is only local/test-safe. | Blocked | Evidence not collected yet. |
| Stage readiness includes Redis. | Blocked | Evidence not collected yet. |
| Login rate-limit smoke evidence is documented or rerun. | Blocked | Evidence not collected yet. |

## Secrets And Logging

| Check | Status | Evidence |
| --- | --- | --- |
| Passwords and password hashes are redacted from logs/errors/tests. | Blocked | Evidence not collected yet. |
| Access/refresh tokens and Authorization header are redacted. | Blocked | Evidence not collected yet. |
| GAS/VLM/Auth0/provider secrets are redacted. | Blocked | Evidence not collected yet. |
| Raw file content is not logged in covered paths. | Blocked | Evidence not collected yet. |
| Error responses expose request IDs and public error codes, not secrets. | Blocked | Evidence not collected yet. |

## Audit Expectations

| Check | Status | Evidence |
| --- | --- | --- |
| Existing backend-owned commands write audit events where implemented. | Blocked | Evidence not collected yet. |
| Denied sensitive action audit is documented as implemented or follow-up. | Blocked | Evidence not collected yet. |

## Hasura Boundary

| Check | Status | Evidence |
| --- | --- | --- |
| Retained Hasura use is read/report/reference only. | Blocked | Evidence not collected yet. |
| Backend-owned mutation flows have tests or network guards preventing forbidden Hasura mutations where accepted. | Blocked | Evidence not collected yet. |
| Known exception `useOrderSave` / nested payments is documented as next command-boundary debt. | Blocked | Evidence not collected yet. |

## Stage Manual Smoke

| Check | Status | Evidence |
| --- | --- | --- |
| Stage backend readiness was checked. | Blocked | Evidence not collected yet. |
| Stage frontend runtime flags were checked without printing secrets. | Blocked | Evidence not collected yet. |

## Follow-Up Items

| Item | Severity | Owner Area | Evidence |
| --- | --- | --- | --- |
| `useOrderSave` / nested payments Hasura mutation exception remains the next command-boundary debt after this checklist. | High | Frontend/backend command boundary | Current priority context keeps this out of this checklist scope. |
