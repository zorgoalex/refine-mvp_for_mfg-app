# Rollout and rollback plan

## Stage 0 — isolated branch preview

- Branch/worktree only; evolution enabled by dedicated preview runtime config.
- Dedicated Compose project, frontend/backend/Hasura/Postgres/metadata DB/Valkey networks and volumes.
- One-time snapshot from `erp_test`; reviewer writes never return to the source contour.
- External side effects/workers disabled in isolated backend.
- No production URL, DB migration, PR merge or default change.

Exit evidence: route/RBAC/tab parity tests, build, screenshots/responsive/zoom checks, implementation report.

## Stage 1 — merged dark launch (future authorization required)

- Merge only after manual review.
- Ship code with `uiEvolution=false` everywhere.
- Verify legacy screenshots, runtime config endpoint and emergency rollback.
- Monitor client errors/bundle load; no user selector.

## Stage 2 — internal shell pilot

- Enable runtime flag for a dedicated preview/organization contour.
- Pilot only shell while page bodies remain shared.
- Collect navigation/task completion and support feedback; never infer authorization from variant.

## Stage 3 — screen batches

- Phase C: orders/clients/payments/materials lists.
- Phase D: order card/create/client card.
- Phase E: calendar/cut/configuration.
- Each batch updates coverage matrix and carries legacy regression plus role parity evidence.

## Stage 4 — per-user opt-in

Prerequisites:

- backend `uiVariant` preference and confirmed-value error handling;
- no wrong-shell flash;
- dirty/long-operation switch guard;
- complete target-role coverage;
- E2E legacy→evolution→legacy, deep links, logout/login and second-browser persistence.

## Stage 5 — default evolution

- Organization default only after canary and human acceptance.
- Keep explicit legacy preference and emergency runtime force-legacy for one full release window.
- Remove legacy only under a separate approved deprecation task.

## Emergency rollback

1. Set runtime `uiEvolution=false` (future force flag overrides all preferences).
2. Refresh/restart frontend delivery; no DB rollback needed.
3. Verify `/orders`, deep link, login and permissions in legacy shell.
4. Preserve user preference data for later recovery; do not delete it during incident response.

Phase B isolated stop command and URL are recorded in `implementation-report.md` after stack launch.
