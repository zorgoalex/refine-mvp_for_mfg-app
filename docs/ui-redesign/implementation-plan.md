# План реализации UI redesign — Phase A/B

Статус: утверждён как рабочий план после discovery; production merge не выполняется. Реализация ведётся только в worktree `/home/ovhtest/projects/erp_dev/.worktrees/ui-redesign-foundation`, branch `feat/ui-redesign-foundation`.

## Scope

В scope: discovery deliverables, reversible UI variant foundation, semantic tokens/shared primitives, evolution application shell, sidebar, top bar, open-page strip, responsive/accessibility QA, isolated preview stack.

Не в scope: визуальная миграция внутренних областей десяти screens, новые backend data fields, изменение permission/status/payment/cut rules, production deployment или merge.

## Architecture decision

1. Legacy remains default and keeps existing `WorkspaceLayout` and CSS behavior.
2. Runtime config is loaded before `App`; `uiEvolution=false/missing/invalid` is safe default and `uiForceLegacy=true` overrides every source.
3. `src/index.tsx` resolves variant and sets `document.documentElement.dataset.uiVariant` before dynamic `App` import/render. `UiVariantProvider` receives the immutable boot value; no wrong-shell flash.
4. A registry dynamically imports either legacy `WorkspaceLayout` or `EvolutionWorkspaceLayout`; neither shell is statically imported by `App`. Same `<Routes>`, route params and page components live below either shell.
5. Evolution CSS is fully scoped. Ant Design token overrides are conditional on variant.
6. Evolution shell reuses existing permissions, role visibility, navigation data, open tabs, dirty guards, keep-alive and services.
7. Phase B exposes evolution only through runtime config in isolated preview. Cross-device user preference is a documented backend follow-up, not a silent schema change.

## Work packages

### 1. Discovery artifacts

- Create `current-route-map.md`, `component-mapping.md`, this plan.
- Fill `SCREEN_MAP.csv` route/component/status.
- Add variant architecture, coverage matrix and rollout plan.
- Gate: all ten screens mapped; conflicts and backend candidates explicit.

### 2. Runtime-safe variant boundary

Files:

- `src/config/featureFlags.ts`
- `api/_lib/frontend-runtime-config.ts`
- `src/ui-variant/uiVariant.ts`
- `src/ui-variant/UiVariantProvider.tsx`
- `src/ui-variant/shellRegistry.ts`
- `src/index.tsx` / `src/App.tsx`

Tests:

- Feature flags default false and runtime true/false parsing.
- Resolver emergency-legacy precedence.
- 404/timeout/malformed config and `build evolution=true + runtime false` fail closed to legacy.
- Root marker exists before App import/render.
- Provider/root marker and no variant use in permissions.
- Build manifest proves selected shell chunks remain separate.
- Existing runtime config tests remain green.

Rollback: set `RUNTIME_CONFIG_UI_FORCE_LEGACY=true` (highest priority), or set `RUNTIME_CONFIG_UI_EVOLUTION=false`; legacy shell loads after next refresh. No DB rollback.

### 3. Semantic foundation

Files:

- `src/ui-evolution/theme/evolutionTheme.ts`
- `src/ui-evolution/styles/evolution.css`
- shared primitives under `src/ui-evolution/components/`

Deliver:

- canvas/surface/sidebar/primary/navigation/success/warning/danger/info tokens;
- derived hover/pressed/soft/border/focus/text tokens;
- spacing, radii, shadows, typography and tabular-number rules;
- conditional Ant tokens for buttons, forms, tables, tabs, cards and focus;
- status badge and loading/empty/error/forbidden primitives; existing `StatusColorSwatch` may be embedded only with readable text;
- page/form/table style contracts for Phases C–E; shared table visuals keep `usePersistentTable` and profile-backed pagination untouched.

Tests: semantic mappings and rendered accessible labels/status roles; CSS guard verifies every evolution selector is scoped.

### 4. Evolution shell

Files:

- `src/ui-evolution/shell/EvolutionWorkspaceLayout.tsx`
- `EvolutionSider.tsx`
- `EvolutionMobileNavigation.tsx`
- `EvolutionHeader.tsx`
- `EvolutionWorkspaceTabs.tsx`

Behavior:

- persistent labelled grouped navigation, collapsible rail;
- same RBAC and role-visibility filtering;
- top service bar with honest Kbar quick-navigation trigger, scan/notifications/theme/profile;
- calmer tabs backed by unchanged `tabStore`, with dirty close confirmation;
- unchanged keep-alive, beforeunload and footer/release notes;
- mobile drawer under existing 768px boundary.

Tests: route selection, permission parity, collapse persistence, keyboard labels, tab close/dirty behavior, legacy route shell unchanged.

### 5. Fully isolated preview stack

Files:

- `ops/ui-redesign/docker-compose.yml`
- `ops/ui-redesign/Dockerfile.frontend`
- `ops/ui-redesign/nginx.conf`
- `ops/ui-redesign/runtime-config.json`
- `ops/ui-redesign/README.md`

Topology:

```text
review browser :4174 -> isolated frontend/nginx
                        ├─ /ui-redesign/api/v1 -> isolated backend
                        └─ /v1/graphql -> isolated Hasura
isolated backend/Hasura -> isolated Postgres snapshot
isolated Hasura          -> isolated metadata Postgres
isolated backend         -> isolated Valkey + optional isolated Freecut
```

- Dedicated Compose project `erp_ui_redesign`; project-scoped networks and named volumes.
- Clone current `erp_test` business and Hasura metadata databases once with `pg_dump|pg_restore` into new containers. Source is read-only during snapshot; all reviewer mutations then hit isolated copies.
- Build backend and frontend from this worktree. No live container/source mounts.
- Disable external side effects and background owners: WorkOS, export, VLM, Twenty, notification/deadline workers/outbox relays. Keep required read/UI modules and permissions available.
- Branch-local `/runtime-config.json` points API/GraphQL at same-origin nginx proxies and enables evolution; no dependency on external Vercel runtime config.
- Bind only frontend to the explicit Tailscale address for review. Backend/Hasura/Postgres bind loopback-only diagnostic ports; the runtime network is internal.
- Publish URL, snapshot timestamp, container list, health evidence and exact `docker compose down` command. Do not use `down -v` unless user explicitly asks to discard review data.

### 6. Verification and evidence

- Targeted Vitest for variant/foundation/shell plus existing navigation/tab/theme/runtime tests.
- Full `npm test` and `npm run build` if host resources permit.
- Repository has no formatter/lint/frontend typecheck scripts; record as tooling gap instead of claiming success. Use build/Vitest TypeScript transforms as available checks.
- Browser QA: 1440×900, 1280×720, 1024×768; 200% browser zoom equivalent/actual Chromium zoom for orders and order-create entry.
- Keyboard pass: sidebar collapse/navigation, quick navigation, notifications/profile, tabs close; visible focus.
- Capture review screenshots under `docs/ui-redesign/screenshots/` and record comparison notes in `implementation-report.md`.
- Update `implementation-report.md` with evidence and incomplete Phase C–F acceptance items left unchecked.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Legacy visual regression from global Ant tokens | Conditional token object; evolution-scoped CSS; legacy screenshot/smoke check |
| Permission leak in new navigation | Same `canViewNavigationResource`, role visibility matrix and feature-gated Refine resources; parity tests |
| Lost form state when shell changes | Variant fixed for boot; no live switch in pilot; same `KeepAliveOutlet` and tab store |
| Wrong-shell flash | `index.tsx` sets root marker before dynamic `App` import; provider never starts from a guessed variant |
| 1024/200% width loss | labelled sidebar collapses to rail; responsive header hides low-priority text; horizontal content may scroll only where existing data tables require it |
| Kbar looks like entity search | Label “Быстрый переход”; no fake placeholder promises |
| Dark mode conflict | Separate evolution dark tokens; retain existing theme preference |
| Backend preference absent | User-facing selector withheld; future API contract documented in variant architecture |
| Reviewer mutation reaches shared test DB | Same-origin proxies target only isolated backend/Hasura over private Compose network; copied DB volumes |
| External side effects from copied config | Explicit environment overrides disable export/VLM/WorkOS/Twenty/workers/relays |

## Stop conditions

Stop and report if tests show permission escalation, dirty-state loss, route mismatch, page remount/data loss, or if isolated frontend cannot safely reach test APIs without exposing secrets. No production deployment or merge is authorized.
