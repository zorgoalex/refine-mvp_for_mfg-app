# UI redesign Phase A/B — implementation report

Дата snapshot/проверки: 2026-07-24 UTC
Ветка: `feat/ui-redesign-foundation`
Worktree: `/home/ovhtest/projects/erp_dev/.worktrees/ui-redesign-foundation`
Migration 084: применена в `erp_test`; stage frontend
`https://app-test.mebelkz.app` и backend
`https://backend-test.mebelkz.app` задеплоены; production merge/deploy ещё не
выполнялись

## Результат

Phase A discovery и Phase B foundation/shell реализованы. Десять handoff
screens используют прежние route components и бизнес-логику внутри нового
evolution shell. Их внутренняя визуальная миграция оставлена для Phase C–E.

| Область | До | После Phase B |
|---|---|---|
| Variant boundary | Один статически подключённый shell | `legacy|evolution`, fail-closed runtime resolver, marker до импорта `App`, оба shell в отдельных lazy chunks |
| Навигация | Узкая rail-first панель и старые глобальные стили | Постоянные labels, группы, collapse persistence, тот же RBAC/role visibility |
| Service bar | Бренд и разрозненные actions | Честный Kbar «Быстрый переход», scan, notifications, theme, profile |
| Open pages | Компактные legacy cards | Спокойная tab strip, прежние dirty confirmation/neighbor navigation |
| Foundation | Глобальные legacy Ant/CSS defaults | Semantic light/dark tokens, scoped forms/tables/focus/states/status primitives |
| Review environment | Shared test services | Отдельный Compose project, business/metadata DB snapshots, secrets, network и volumes; сейчас остановлен |

## Reversibility

- `ui.forceLegacy=true` имеет высший приоритет.
- `ui.evolutionEnabled=false`, отсутствующий, 404, timeout или malformed runtime
  config выбирает legacy.
- Выбор завершён до первого React render; live switch отсутствует.
- URLs, route tree, API clients, permissions, validations и domain state не
  зависят от variant.
- Legacy/evolution shell CSS/JS собраны отдельными chunks.

## Isolated stack

Project: `erp_ui_redesign`. По команде владельца стек остановлен 2026-07-21:
контейнеры не потребляют RAM, isolated volumes/snapshot сохранены для возможного
позднего запуска. После snapshot canonical base продвинулся до `8f429238` и
добавил migration `083_orders_production_done_backfill`; поэтому перед будущим
запуском нужно снова выполнить `clone-current-data.sh`, а не стартовать старый
snapshot напрямую.

| Service | Изоляция | Endpoint |
|---|---|---|
| frontend/nginx | Отдельный build/runtime config; bind только на Tailscale IP | `${PG_TAILSCALE_BIND_IP}:4174` (когда запущен) |
| backend | Отдельный image и private Compose network | `127.0.0.1:3301` diagnostic |
| Hasura | Отдельный container + cloned metadata DB | `127.0.0.1:8586` diagnostic |
| PostgreSQL | Отдельный named volume | `127.0.0.1:55433` diagnostic |
| metadata PostgreSQL | Отдельный named volume | internal only |
| Valkey | Отдельный named volume | internal only |

Business snapshot verification: `orders=4652`, `users=25` in source and clone.
Migration ledger на момент snapshot: 84/84 applied, 0 pending. Затем base получил
ещё одну migration; stopped snapshot намеренно не обновлялся. Existing source checksum drift for
023/054 is preserved and was not changed. Historical cut rows require the
function-backed CHECK to be recreated `NOT VALID` after restore; this preserves
the source's forward-write enforcement while allowing its pre-existing rows.

External side effects/background owners are disabled: export, VLM, WorkOS,
Twenty, deadline/notification workers and outbox relays. CAD/OCR/Freecut calls
point to disabled endpoints; inspection/read flows remain available, their
external processing actions are intentionally not part of review acceptance.

Important isolation hardening: the shared env contains
`COMPOSE_PROJECT_NAME=erp_test`. The first bootstrap attempt revealed that it
overrides top-level Compose `name:` and briefly stopped source Postgres,
metadata Postgres and Valkey. No volume was deleted and no clone/write started;
all three were immediately restarted and the complete source stack returned
healthy. Every committed start/clone/stop command now sets
`--project-name erp_ui_redesign`, and the clone script validates target Compose
labels before recreating either target database.

Auth/network hardening после code review:

- source containers зафиксированы именами и до clone проверяются по
  `com.docker.compose.project=erp_test`, running state, DB/user identity;
- `.env.secrets` генерируется mode `0600`, игнорируется Git и содержит отдельные
  JWT, refresh pepper, Hasura admin secret;
- после snapshot удалены `2320 refresh_tokens` и `317 auth_sessions`; users и
  permissions сохранены;
- review API/cookie path — `/ui-redesign/api/v1[/auth]`, source path —
  `/api/v1[/auth]`;
- frontend публикуется только на `${PG_TAILSCALE_BIND_IP}:4174`, остальные
  diagnostics — loopback; Compose runtime network имеет `internal: true`.

## Verification

| Check | Result |
|---|---|
| Targeted variant/profile/auth tests | 63/63 passed |
| Backend `npm run build` | passed (`tsc -p tsconfig.json`) |
| Frontend `npm run build` | passed; separate `WorkspaceLayout` and `EvolutionWorkspaceLayout` chunks |
| Full release suite on `main` base | 683 files / 5447 tests passed; 9 files / 34 tests skipped; 0 failed |
| Migration runner/head verification against `erp_test` | migration 084 applied; full head `PRESENT`; 101/101 migration tests passed |
| Compose config/bash syntax/git diff check | passed |
| Clone-script security guards | separate secrets/path, fixed source identity, session purge, bind/network invariants passed |
| Isolated stack runtime before stop | six services healthy; backend readiness and Hasura GraphQL passed |
| Browser authenticated smoke before final hardening/stop | ten routes 10/10, evolution marker/main shell, 0 console errors |
| Live stage variant canary on `https://app-test.mebelkz.app` | login, profile, legacy → evolution → legacy, exact URL reload, clean console |
| Responsive smoke before final hardening/stop | 1440×900, 1280×720, 1024×768 and 720×450: no document overflow |
| New-order modal before final hardening/stop | 684px within 720px viewport; vertical modal wrapper scroll enabled |
| Representative token contrast (calculated WCAG ratios) | sidebar 7.12:1; primary 5.17:1; body 14.71:1; selected nav 8.85:1; secondary text 4.90:1; group label 4.58:1 |

The initial anonymous refresh request returned the expected 401 before login;
after authentication and console reset, route smoke produced no console errors.
These browser results/screenshots predate the final auth/network hardening and
generic table-foundation adjustment. The owner then requested that the stack
remain stopped because host swap was nearly full; they are retained as
provisional evidence, not claimed as final live acceptance.

Screenshots:

- [Orders 1440×900](screenshots/orders-1440x900.png)
- [Orders 1280×720](screenshots/orders-1280x720.png)
- [Orders 1024×768](screenshots/orders-1024x768.png)
- [Orders 200% equivalent](screenshots/orders-200-percent-equivalent.png)
- [New order 200% equivalent](screenshots/new-order-200-percent-equivalent.png)

## Remaining acceptance work

- Internal content of all ten screens still has status `shared-legacy-body`; it
  must be migrated and visually diffed in Phase C–E.
- Cross-device per-user `uiVariant` is implemented by migration 084 and
  `GET/PATCH /api/v1/me/preferences`; migration acceptance in `erp_test` is
  complete and live stage acceptance passed; production acceptance remains
  separate.
- Final live cross-stack JWT/cookie rejection, all-ten-screen screenshot pass,
  keyboard navigation and post-hardening browser smoke remain deferred while
  the isolated stack is stopped.
- Pre-migration full suite exposed the expected pending migration 084 and a
  password-login SPA navigation gap. Migration 084 was then applied to
  `erp_test`, and login now overrides Refine's SPA redirect at hook level.
  The final post-merge full suite and both production builds are green.
- Repository has no formatter/lint/frontend typecheck scripts and no root
  `tsconfig.json`; build and Vitest transforms are the available frontend
  compilation checks. Existing dependency audit and main-bundle warnings are
  not remediated by this UI foundation change.
- Do not enable the evolution runtime flag until migration, backend, frontend,
  and version canaries are green in the target environment.

Final ERP Aggressive Critic verdict: `APPROVED`, no blocking findings and no ERP
debt markers. Live stage/production evidence is recorded after each deployment
gate completes.
