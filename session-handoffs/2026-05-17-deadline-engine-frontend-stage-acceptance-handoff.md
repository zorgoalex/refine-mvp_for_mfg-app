# Prompt for New Session: Deadline Engine Frontend/Stage Acceptance

Ты продолжаешь работу в проекте ERP backend stage. Цель новой сессии:
закрыть следующий PRD item — **Deadline Engine frontend/stage acceptance**.

Рабочая директория:

```bash
cd ~/projects/erp_dev/repo_erp
```

Перед началом обязательно изучи:

```bash
~/projects/erp_dev/CONTEXT.md
~/projects/erp_dev/MEMORY_AGENT.md
~/projects/erp_dev/repo_erp/README.md
~/projects/erp_dev/spec_erp/prd_backend-erp.md
~/projects/erp_dev/spec_erp/prd_v1/12-deadline-engine.md
~/projects/erp_dev/repo_erp/session-handoffs/2026-05-17-backend-erp-next-work-handoff.md
```

Важно:

- `CONTEXT.md` и `MEMORY_AGENT.md` лежат в `~/projects/erp_dev/`,
  не внутри `spec_erp`.
- `~/projects/erp_dev/.env` лежит вне repo git и содержит реальные stage env
  значения. Не коммитить и не печатать секреты.
- Не удаляй созданные тестовые заказы: `11160`, `11163`, `11164`, `11165`,
  `11166`.
- Не возвращайся к старому compose project `erp_dev`; актуальный stage —
  `erp_test`.
- Если меняешь файлы в `repo_erp`, commit/push только по явному запросу.
- `session-handoffs/` обычно не коммитить, кроме случаев, когда user явно
  попросил записать и закоммитить handoff.

## Текущая ветка и состояние

Текущая ветка:

```bash
feat/backend-erp-stage1
```

В конце предыдущей сессии были подготовлены и должны быть запушены изменения:

- `tests/frontend-pages-stage-canary.spec.ts`:
  - frontend pages stage canary после login теперь навигирует между routes
    через SPA history navigation;
  - причина: full reload на каждый route искусственно вызывал
    `/api/v1/auth/refresh` на каждом шаге и превышал Redis-backed
    `auth_refresh` limit `30/min`, после чего backend корректно возвращал
    HTTP 429 и UI уходил на `/login`.
- `session-handoffs/2026-05-17-deadline-engine-frontend-stage-acceptance-handoff.md`
  создан как prompt для новой сессии.

Проверить стартовое состояние:

```bash
git status --short --branch --untracked-files=all
git log -5 --oneline
```

Если commit/push предыдущей сессии прошёл, ожидай, что branch
`feat/backend-erp-stage1` синхронизирован с origin и последний commit связан с
frontend cleanup stage acceptance / Deadline Engine handoff.

## Актуальная VPS/Docker раскладка

Актуальный compose-файл для stage:

```bash
~/projects/erp_dev/repo_erp/ops/templates/docker-compose.vps.yml
```

Актуальный compose project:

```bash
erp_test
```

Команда для stage compose:

```bash
cd ~/projects/erp_dev
docker compose \
  --project-directory ~/projects/erp_dev \
  -p erp_test \
  --env-file ~/projects/erp_dev/.env \
  -f ~/projects/erp_dev/repo_erp/ops/templates/docker-compose.vps.yml \
  ps
```

Активные сервисы после Redis/Valkey acceptance:

```txt
erp_test-backend-1
erp_test-hasura-1
erp_test-postgresdb-1
erp_test-traefik-1
erp_test-hasura_metadata_db-1
erp_test-valkey-1
```

Postgres stage публикуется на Tailscale IP:

```txt
100.99.106.72:5432
```

## Что уже закрыто перед Deadline Engine

Frontend cleanup stage acceptance закрыта:

- `7574fd9 fix: isolate frontend legacy backend paths` был задеплоен на
  stage frontend.
- Vercel stage bundle был обновлён после commit `7574fd9`.
- `https://backend-test.mebelkz.app/health/ready` возвращал:
  `database=ok`, `redis=ok`, `config=ok`.
- `/runtime-config.json` на `https://app-test.mebelkz.app` с Vercel bypass
  отдавал backend flags:
  - `backendAuth=true`;
  - `backendPermissions=true`;
  - `backendOrdersRead=true`;
  - `backendOrdersWrite=true`;
  - `backendOrderExport=true`;
  - `backendUsers=true`;
  - `backendVlm=true`;
  - `backendReferences=true`;
  - `backendPayments=false`;
  - `backendClientPhones=false`;
  - `backendProductionActions=false`.
- После canary fix прошёл:

```bash
FRONTEND_PAGES_STAGE_CANARY=true \
FRONTEND_PAGES_STAGE_CREATE_USER=true \
FRONTEND_PAGES_STAGE_FRONTEND_URL=https://app-test.mebelkz.app \
FRONTEND_PAGES_STAGE_BACKEND_API_URL=https://backend-test.mebelkz.app \
FRONTEND_PAGES_STAGE_POSTGRES_CONTAINER=erp_test-postgresdb-1 \
PLAYWRIGHT_SKIP_WEB_SERVER=true \
bash -lc 'set -a; source ~/projects/erp_dev/.env; set +a; npx playwright test tests/frontend-pages-stage-canary.spec.ts --project=chromium'
```

Результат:

```txt
1 passed (44.4s)
```

PRD и CONTEXT были обновлены вне `repo_erp`:

- `~/projects/erp_dev/spec_erp/prd_backend-erp.md`:
  - `Последнее обновление: 2026-05-17`;
  - добавлен журнал `Frontend cleanup stage acceptance`;
  - строка `Frontend cleanup` переведена в `Stage acceptance пройден`.
- `~/projects/erp_dev/CONTEXT.md`:
  - Done обновлён frontend cleanup stage acceptance;
  - next priority: Deadline Engine frontend/stage acceptance и открытые
    business decisions.

Эти два файла вне git repo `repo_erp`; не пытайся коммитить их из
`repo_erp`.

## Текущее состояние PRD для Deadline Engine

В `~/projects/erp_dev/spec_erp/prd_backend-erp.md` строка:

```txt
Deadline Engine | DB adapter и orders sync выполнены на test DB без frontend cutover
```

Уже реализовано:

- `DeadlinesModule`;
- feature flags / runtime config service;
- permissions;
- domain helpers;
- HTTP API под `/api/v1`;
- Postgres repository / transaction manager / target resolver /
  notification / outbox adapters;
- due scan `FOR UPDATE SKIP LOCKED`;
- action executions;
- orders deadline sync из planned/completed dates;
- smoke на test DB:
  - create заказа создал `order:active` и `order_stage:active`;
  - update final deadline сделал `order:superseded + order:active`;
  - completed stage deadline стал `completed_late`;
  - `GET /api/v1/orders/:id/deadlines` и
    `/api/v1/orders/:id/deadline-summary` возвращали HTTP 200;
  - `deadline_events` и `outbox_events` создавались;
  - test rows очищались.

Нужно закрыть frontend/stage acceptance, не меняя business policies.

## Что сделать дальше

### 1. Изучить текущую реализацию Deadline Engine

Минимально прочитать:

```bash
sed -n '1,260p' ~/projects/erp_dev/spec_erp/prd_v1/12-deadline-engine.md
sed -n '1,260p' backend/src/modules/deadlines/http/deadlines.controller.ts
sed -n '1,260p' backend/src/modules/deadlines/http/deadlines-runtime-config.service.ts
sed -n '1,220p' src/api/apiRoutes.ts
sed -n '1,220p' src/api/deadlinesApi.ts
sed -n '1,220p' src/api/deadlinesApi.test.ts
```

Then search frontend usage:

```bash
rg -n "deadline|deadlines|deadline-summary|Deadline" src tests backend/src/modules/deadlines
```

### 2. Проверить runtime/stage flags

Не печатать секреты.

```bash
curl -fsS https://backend-test.mebelkz.app/health/ready | jq .

set -a
source ~/projects/erp_dev/.env
set +a

curl -fsS \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  https://app-test.mebelkz.app/runtime-config.json | jq '{apiUrl, features}'
```

Проверить backend env/flags только без вывода секретов:

```bash
docker exec erp_test-backend-1 sh -lc 'printenv | sort | grep -E "DEADLINE|BACKEND_ENABLE_DEADLINES|BACKEND_DEADLINES_READ_ONLY|API_PREFIX|NODE_ENV"'
```

Если deadline env не включён на stage, сначала выяснить intended rollout:
read-only acceptance может требовать `BACKEND_ENABLE_DEADLINES=true` и
write/manual actions disabled/read-only.

### 3. Проверить API routes и stage read model

Обязательные endpoints для read acceptance:

```txt
GET /api/v1/orders/:id/deadlines
GET /api/v1/orders/:id/deadline-summary
GET /api/v1/orders/:id/deadline-events   # если frontend/read model использует events
GET /api/v1/deadlines                    # если есть list/admin surface
```

Проверить, что `src/api/apiRoutes.ts` и `src/api/deadlinesApi.ts` используют
только versioned `/api/v1/*`.

Stage API smoke должен использовать authenticated backend auth. Не печатать
токены. Можно создать временного smoke-user через stage Postgres по паттерну
существующих Playwright canary tests и очистить/deactivate после проверки.

### 4. Найти frontend surface для deadlines

Возможные места:

- order show/edit summary;
- order header/meta block;
- calendar cards;
- configuration/deadline settings;
- отдельный deadlines admin/list surface, если уже есть;
- отсутствует вообще — тогда acceptance может быть read-model API + planned
  frontend cutover doc/test, а PRD статус должен честно остаться без frontend
  UI cutover.

Не добавлять большой UI без явного понимания UX. Если surface отсутствует,
сначала предложить минимальный acceptance:

- API client tests;
- stage Playwright/API canary для read models;
- optionally small non-invasive display only if existing order page has a clear
  slot and permissions are settled.

### 5. Добавить или прогнать acceptance

Предпочтительный focused stage canary:

- создаёт или выбирает stage order with planned dates/workshops;
- вызывает backend orders save/update, если нужно создать deadline rows;
- проверяет:
  - `/api/v1/orders/:id/deadlines` returns active/superseded/completed rows;
  - `/api/v1/orders/:id/deadline-summary` returns aggregate counts/status;
  - no duplicate active final deadline after repeated save/update;
  - `deadline_events` rows exist;
  - `outbox_events` rows exist for deadline events;
  - request/correlation id is present where expected;
  - no manual action endpoint is required for read acceptance.

Если используешь browser frontend canary, не делай full reload на десятки
routes: backend auth refresh rate limit на stage равен 30/min. Используй
SPA-навигацию после login или API request context.

### 6. Не включать manual actions без отдельного анализа

Manual/action endpoints:

```txt
POST /api/v1/deadlines
PATCH /api/v1/deadlines/:deadlineId
POST /api/v1/deadlines/:deadlineId/pause
POST /api/v1/deadlines/:deadlineId/resume
POST /api/v1/deadlines/:deadlineId/cancel
```

Не включать их во frontend/stage acceptance, пока не проверены:

- UX;
- permissions;
- audit event contract;
- actor/current user;
- request/correlation id;
- idempotency;
- outbox/notification readiness;
- stale-safe behavior.

### 7. После успешного acceptance обновить docs

Если stage acceptance проходит, обновить:

```bash
~/projects/erp_dev/spec_erp/prd_backend-erp.md
~/projects/erp_dev/CONTEXT.md
```

В PRD:

- добавить `0.1` journal entry с конкретными endpoint/test/DB/outbox checks;
- обновить строку `Deadline Engine` с текущего
  `DB adapter и orders sync выполнены на test DB без frontend cutover` на
  честный новый статус, например:
  - `Stage read-model acceptance пройден без manual actions`, если UI cutover
    не делался;
  - или более конкретный статус, если frontend display реально подключён.

В CONTEXT:

- коротко добавить Done;
- next оставить business permissions/security/OpenAPI debt.

## Открытые business decisions

Не смешивать с Deadline Engine:

- должен ли `operator` иметь какие-либо `payments.*`;
- должен ли `viewer` видеть финансовые поля.

Safe v1 policy уже зафиксирована:

- `operator` не получает `payments.*` до бизнес-подтверждения;
- `viewer` read-only.

Не менять эти policies самовольно.

## Полезные команды

Backend ready:

```bash
curl -fsS https://backend-test.mebelkz.app/health/ready | jq .
```

VPS smoke:

```bash
ops/smoke-vps.sh \
  --project-dir ~/projects/erp_dev \
  --env-file ~/projects/erp_dev/.env \
  --compose-file ~/projects/erp_dev/repo_erp/ops/templates/docker-compose.vps.yml \
  --skip-docker
```

Focused frontend cleanup canary, если нужно перепроверить baseline:

```bash
FRONTEND_PAGES_STAGE_CANARY=true \
FRONTEND_PAGES_STAGE_CREATE_USER=true \
FRONTEND_PAGES_STAGE_FRONTEND_URL=https://app-test.mebelkz.app \
FRONTEND_PAGES_STAGE_BACKEND_API_URL=https://backend-test.mebelkz.app \
FRONTEND_PAGES_STAGE_POSTGRES_CONTAINER=erp_test-postgresdb-1 \
PLAYWRIGHT_SKIP_WEB_SERVER=true \
bash -lc 'set -a; source ~/projects/erp_dev/.env; set +a; npx playwright test tests/frontend-pages-stage-canary.spec.ts --project=chromium'
```

Focused local tests likely relevant:

```bash
npm test -- deadlinesApi apiRoutes
cd backend && npm run test -- deadlines
```

## Важные правила работы

- Не печатай секреты из `~/projects/erp_dev/.env`.
- Не коммить `~/projects/erp_dev/.env`.
- Не удаляй stage тестовые заказы `11160`, `11163`, `11164`, `11165`,
  `11166`.
- Не используй старый compose project `erp_dev`.
- Не включай Deadline manual actions без audit/outbox/idempotency/permission
  проверки.
- Если меняешь файлы в `repo_erp`, commit/push только по явному запросу.
- Если меняешь `spec_erp/prd_backend-erp.md` или `~/projects/erp_dev/CONTEXT.md`,
  помни, что это вне git repo `repo_erp`.

## Что сделать первым в новой сессии

1. Прочитать обязательные документы.
2. Проверить git/runtime:

```bash
git status --short --branch --untracked-files=all
git log -5 --oneline
curl -fsS https://backend-test.mebelkz.app/health/ready | jq .
```

3. Изучить current Deadline Engine frontend/API surface.
4. Проверить stage deadline flags.
5. Спланировать минимальный acceptance для read models.
6. Только после этого добавлять/запускать tests или stage canary.
