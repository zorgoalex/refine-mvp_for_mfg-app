# Разработка и тестирование

## Установка и запуск

```bash
npm install
npm run dev
```

Полный локальный frontend + Vercel Functions:

```bash
npm run dev:full
```

Основные scripts:

- `npm run dev` — Vite на `5173`;
- `npm run dev:api` — Vercel Functions на `3001`;
- `npm run dev:full` — UI и serverless API;
- `npm run build` — production frontend build;
- `npm run preview` — preview build;
- `npm run version:daily` — daily patch bump;
- `npm test` — root Vitest;
- `npm run test:e2e` — Playwright;
- `npm run test:backend` — backend tests;
- `npm run test:e2e:regression` — mocked frontend regression;
- `npm run test:e2e:order-ui-full-coverage` — durable stage order workflow;
- `npm run test:e2e:runtime-config` — runtime-config UI smoke;
- `npm run test:runtime-config-canary` — staged runtime examples;
- `npm run smoke:runtime-config` — runtime endpoint smoke;
- `npm run smoke:staging-gates` — stage runtime/backend health gates.

Полный актуальный список находится в `package.json` и
`backend/package.json`.

## Git hooks

`npm install` и `npm ci` автоматически подключают hooks из `.githooks`.
Для уже установленного проекта их можно подключить вручную:

```bash
npm run hooks:install
```

Перед каждым commit запускается `npm run typecheck:ratchet`. Проверка запрещает
новые TypeScript diagnostics относительно committed baseline; известный долг
может только уменьшаться. Перед push отдельно запускаются business-reference
contracts.

## Базовые проверки

Frontend/root:

```bash
npm test
npm run build
```

Backend:

```bash
cd backend
npm test
npm run build
```

Playwright:

```bash
npm run test:e2e
npx playwright test tests/reference-workflows.spec.ts --project=chromium
npm run test:e2e:frontend-pages
npm run test:e2e:calendar
```

Browser runtime:

```bash
npx playwright install chromium
```

## Mocked frontend regression

```bash
npm run test:e2e:regression
```

Набор запускается в Chromium и не требует stage/backend/PostgreSQL:
API перехватываются Playwright route mocks.

Покрывает:

- все зарегистрированные frontend pages;
- runtime config;
- CRUD справочников;
- order/payment finance flow;
- детали и платежи;
- inline edit;
- totals/payment status;
- кнопки JSON export/import и filters.

Скриншоты сохраняются в regression logs; точный путь задаётся
`SCREENSHOT_DIR` в `tests/regression/*.regression.spec.ts`.

## Обычный полный локальный прогон

```bash
npm test
cd backend && npm test
cd ..
npx playwright test
```

Полный Playwright поднимает `npm run dev:full` и использует
`http://localhost:5173`. Не загружайте весь внешний project `.env`: stage
flags и backend URLs могут изменить локальный runtime и сломать mocked tests.

Integration tests, которым нужна PostgreSQL, должны использовать test DB и
временную schema. Пример deadline integration:

```bash
bash -lc '
set -a
. /path/to/project/.env
set +a
npm run test:backend:deadline-integration
'
```

## Stage и canary

Stage/canary выполняются отдельным batch после локальных тестов.

Правила:

- использовать только test/stage backend и `erpdb`;
- secrets загружать во временный subshell;
- не печатать `.env`, tokens или connection strings;
- использовать постоянного stage smoke user, если test не требует временного;
- `skipped` из-за env не считать итогом, пока наличие env не проверено;
- write-canary обязан иметь explicit target и restore/cleanup contract;
- не запускать несовместимые write fixtures параллельно.

Основные scripts:

- `npm run test:e2e:frontend-pages-stage-canary`;
- `npm run test:e2e:calendar-stage-canary`;
- `npm run test:e2e:users-cutover`;
- `npm run test:e2e:order-export-cutover`;
- `npm run test:e2e:payments-stage-canary`;
- `npm run test:e2e:production-actions-cutover`;
- `npm run test:e2e:production-actions-stage-canary`;
- `npm run test:e2e:production-actions-mode-stage-canary`;
- `npm run test:e2e:deadline-engine-stage-canary`;
- `npm run test:e2e:deadline-create-override-stage-canary`;
- `npm run test:e2e:deadline-status-transition-stage-canary`;
- `npm run test:e2e:notification-engine-stage-canary`;
- `npm run test:e2e:notification-rules-group-scope-stage-canary`;
- `npm run test:e2e:order-created-by-stage-canary`;
- `npm run test:e2e:vlm-cutover`;
- `npm run test:e2e:bitrix24-sync-stage-canary`.

Для deployed Playwright обычно задаётся:

```env
PLAYWRIGHT_SKIP_WEB_SERVER=true
```

## Обязательный full coverage для крупных frontend-изменений

Крупные изменения UI, форм, вкладок, таблиц, кнопок, data-provider/mapping или
order flow должны обновлять
`tests/order-ui-full-form-coverage.spec.ts`.

Тест обязан:

- пройти пользовательский workflow через UI;
- заполнить затронутые формы и вкладки;
- нажать заявленные действия;
- проверить display и persistence полей;
- снять ключевые screenshots;
- проверить creator history;
- использовать постоянного stage test user.

Запуск:

```bash
bash -lc '
set -a
. /path/to/project/.env
set +a
npm run test:e2e:order-ui-full-coverage
'
```

Тест создаёт durable orders с префиксом `E2E codex full coverage`. Если
изменение не затрагивает order UI, review должен явно объяснить, почему этот
workflow не обновлялся и не запускался.

## Deadline canary guards

Deadline worker/scheduler/notification canaries fail-closed, если target
содержит `prod`, `production` или `live`.

Для test target задавайте явно:

```env
DEADLINE_WORKER_TARGET_ENV=<test-target-env>
DEADLINE_NOTIFICATION_ACTION_TARGET_ENV=<test-target-env>
COMPOSE_PROJECT_NAME=<test-compose-project>
APP_ENV=<test-target-env>
BACKEND_ENV=<test-target-env>
BACKEND_NODE_ENV=test
NODE_ENV=test
BACKEND_FQDN=<stage-backend-domain>
FRONTEND_ORIGIN=https://<stage-frontend-domain>
```

Не используйте `*_ALLOW_PRODUCTION=true`.

Особые workflows:

- Deadline Engine read canary проверяет summary/list/events и UI panel.
- Create/override canary создаёт изолированные manual deadlines и восстанавливает
  fixture rows.
- Status-transition canary создаёт scoped rule/deadline, запускает manual
  worker, проверяет audit/outbox и восстанавливает status.
- Notification engine canary проверяет exactly-once delivery, visibility,
  privacy и cleanup.
- Notification group-scope canary требует explicit fixture key и не запускается
  параллельно с другими write fixtures.

Runbook:
[Deadline status-transition rules](deadline-status-transition-rules-runbook.md).

## WorkOS stage canary

WorkOS canary запускается отдельно после включения SSO. Он выполняет hosted
AuthKit login, проверяет backend audit `source='workos'` и logout provider.

Требуются:

- `WORKOS_STAGE_CANARY=true`;
- durable E2E identity;
- password во внешнем `.env`;
- опционально TOTP secret при MFA.

Secrets нельзя передавать в CLI history или сохранять в repo.

## Groups backfill utilities

- `npm run groups-live-backfill:manifest -- <manifest.json>` — validate и
  generate payload без backend mutation.
- `npm run groups-live-backfill:proof-sql -- <manifest.json>` — generate proof
  SQL без DB connection.
- `npm run groups-live-backfill:run -- --manifest <manifest.json> --mode dry-run|write --target-env backend-test`
  — guarded runner.
- `npm run test:e2e:groups-live-backfill-dry-run-stage-canary` — read-only
  canary.

Write mode требует explicit approval flag.

## Связанные readiness-документы

- [Users cutover](users-cutover-readiness.md)
- [Order export cutover](order-export-cutover-readiness.md)
- [VLM cutover](vlm-cutover-readiness.md)
- [Frontend runtime config](frontend-runtime-config-readiness.md)
- [Runtime config canary](runtime-config-canary-readiness.md)
- [VPS deploy](../ops/README.md)
