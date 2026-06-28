# ERP Frontend — Refine + Hasura GraphQL

Веб-интерфейс ERP для управления заказами, производством, оплатами, материалами и справочниками. Приложение построено на React, Refine и Ant Design, работает с Hasura GraphQL и использует Vercel Functions для серверных API.

## Содержание

- Обзор
- Возможности
- Стек
- Структура проекта
- Ресурсы и маршруты
- Конфигурация и авторизация
- Установка и запуск
- Тесты
- Примечания по реализации

## Обзор

- Frontend: React + Vite + Refine + Ant Design.
- Backend data API: Hasura GraphQL.
- Serverless API: Vercel Functions в каталоге `api/`.
- Stage-1 NestJS backend: versioned `/api/v1/*` endpoints for auth/session, users, orders (read/write, export, JSON snapshot), payments, production actions/calendar moves, client phones, VLM, deadlines, projects and notifications, behind feature flags.
- Локальный dev server: `http://localhost:5173`.
- Локальный Hasura GraphQL по умолчанию: `http://localhost:8585/v1/graphql`.
- Актуальная схема БД: v14.

## Возможности

- Комплексная форма заказов: шапка, детали, платежи, присадки, статусы, даты, файлы и примечания.
- Список заказов с серверной сортировкой, поиском, расширенными фильтрами, быстрым фильтром "Мои заказы" и подсветкой строк.
- Финансы: платежи, статусы оплат, итоговые суммы, пересчёт оплачено/остаток.
- Производственный календарь: диапазон дат, Drag & Drop, контекстное меню статусов, компактные виды карточек, цветовая кодировка материалов.
- Этапы производства: независимые toggle-этапы, хранение фактов в `production_status_events`, отображение в списке, карточках календаря и карточке заказа.
- Текущий статус производства заказа: переключатель «Автообновление статусов производства» в карточке — в авто-режиме статус заказа выводится из статусов деталей (наименее продвинутая деталь), в ручном режиме фиксируется текущий статус; переключение и смена статуса идут через backend-команды с проверкой прав, optimistic-версией и аудитом.
- Настройки приложения: `app_settings`, вкладки заказов, финансов, этапов производства, видимости ресурсов и анализа фото.
- Импорт деталей: Excel, PDF и фото через VLM API.
- VLM-конфигурация из БД: провайдеры, модели, промпты и дефолтные настройки запросов.
- Печать заказа и экспорт в Excel.
- Экспорт заказов в Google Drive через защищённый Vercel API proxy к Google Apps Script.
- JWT-аутентификация с refresh token rotation и Hasura role-based permissions.
- Управление пользователями, ролями и ключевыми справочниками.
- Уведомления: backend-backed колокол и панель уведомлений в шапке через `/api/v1/notifications` (список, отметка прочитанным, удаление).
- Проекты (за feature flag): страница `/projects`, привязка заказов к проектам, фильтр и колонка проектов в списке заказов, редактор связей на карточке заказа.

## Стек

- React 18, Vite 4.
- Refine: `@refinedev/core`, `@refinedev/antd`, `@refinedev/react-router-v6`, `@refinedev/kbar`.
- UI: `antd@^5`.
- State: `zustand@^5`.
- Forms/validation: `react-hook-form@^7`, `@hookform/resolvers@^5`, `zod@^4`.
- Import/export/print: `xlsx`, `pdfjs-dist`, `exceljs`, `react-to-print`.
- Calendar: `date-fns`, `react-dnd`, `react-dnd-html5-backend`.
- Serverless/API: `@vercel/node`, `jsonwebtoken`, `bcryptjs`.
- Tests: Vitest, Playwright.

Точные версии указаны в `package.json`.

## Структура проекта

- `src/index.tsx` — точка входа React.
- `src/App.tsx` — Refine resources, routes, providers, layout и auth.
- `src/authProvider.ts` — Refine auth provider для legacy `/api/login`/`/api/refresh` и backend `/api/v1/auth/*` cutover mode.
- `src/utils/dataProvider.ts` — кастомный Hasura GraphQL data provider с JWT; `orders_view`/`orders` могут читать через `/api/v1/orders` за feature flag.
- `src/components/CustomLayout.tsx`, `src/components/CustomSider.tsx` — основной layout и меню.
- `src/pages/orders/` — список, просмотр, создание и редактирование заказов.
- `src/pages/orders/components/` — форма заказа, таблицы, вкладки, модальные окна, печать и импорт.
- `src/pages/calendar/` — производственный календарь, карточки, DnD, контекстные меню и хуки данных.
- `src/pages/configuration/` — настройки приложения, производства и VLM.
- `src/hooks/` — shared hooks: сохранение заказов, настройки, VLM, экспорт, подсветка, production events.
- `src/stores/` — Zustand stores для формы заказа и уведомлений.
- `src/schemas/` — Zod-схемы валидации.
- `src/types/` — типы доменных сущностей.
- `src/utils/excel/` — подготовка и отправка данных для Excel/Google Drive.
- `api/` — Vercel Functions: auth, users, refresh, VLM, export.
- `backend/` — NestJS backend stage-1: `/api/v1/*` + `/health/live`/`/health/ready`; модули auth/session, users, orders (read/write, export, JSON snapshot), payments, production actions, client phones, VLM, deadlines, projects, notifications, cut-jobs.
- `ops/` — VPS bootstrap/deploy scripts and tracked Docker Compose templates.
- `public/templates/order_template.xlsx` — шаблон Excel.
- `vercel.json` — rewrites, headers и настройки функций.
- `vite.config.ts` — порт dev server, proxy `/api/v1`/`/health` на NestJS и legacy `/api` на Vercel Functions.

## Ресурсы и маршруты

Ключевые routes:

- `/orders` — список заказов (`orders_view`).
- `/orders/edit/:id` — форма редактирования заказа, запись в `orders` и связанные таблицы.
- `/orders/show/:id` — просмотр заказа.
- `/calendar` — производственный календарь.
- `/doweling-orders` — присадки.
- `/payments` — платежи.
- `/payments-analytics` — агрегированный список платежей (`payments_view`).
- `/clients` и `/clients-analytics` — клиенты и клиентская аналитика.
- `/configuration` — настройки приложения.
- `/cut` — задания раскроя.

Справочники и производственные сущности также зарегистрированы в `src/App.tsx`: материалы, плёнки, типы фрезеровок, типы кромок, поставщики, производители, статусы заказов/оплат/производства, цеха, участки, сотрудники, пользователи и другие ресурсы.

## Конфигурация и авторизация

Project-level secrets for local/stage smoke commands live outside this repo in
`/path/to/project/.env`. In particular,
`VERCEL_AUTOMATION_BYPASS_SECRET` for protected Vercel stage checks may be present
there even when it is not exported in the current shell. Load it only in a
subshell/command context and never print the file or secret values, for example:

```bash
set -a
. /path/to/project/.env
set +a
curl -fsS \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  https://<stage-frontend-domain>/runtime-config.json
```

Frontend env:

```env
VITE_HASURA_GRAPHQL_URL=http://localhost:8585/v1/graphql
VITE_API_URL=http://localhost:3000
VITE_LEGACY_API_URL=http://localhost:3001
VITE_USE_BACKEND_AUTH=false
VITE_USE_BACKEND_PERMISSIONS=false
VITE_USE_BACKEND_ORDERS_READ=false
VITE_USE_BACKEND_ORDERS_WRITE=false
VITE_USE_BACKEND_PAYMENTS=false
VITE_USE_BACKEND_PRODUCTION_ACTIONS=false
VITE_USE_BACKEND_CLIENT_PHONES=false
VITE_USE_BACKEND_USERS=false
VITE_USE_BACKEND_ORDER_EXPORT=false
VITE_USE_BACKEND_VLM=false
VITE_USE_BACKEND_DEADLINES=false
VITE_USE_BACKEND_PROJECTS=false
VITE_USE_BACKEND_REFERENCES=false
VITE_SHEET_MATERIALS_READS=false
VITE_ENABLE_LEGACY_HASURA=true
VITE_RUNTIME_CONFIG_URL=/runtime-config.json
```

Backend env для Vercel Functions:

```env
HASURA_URL=http://localhost:8585/v1/graphql
HASURA_ADMIN_SECRET=...
JWT_SECRET=...
JWT_REFRESH_SECRET=...
GAS_WEBAPP_URL=...
GAS_API_KEY=...
VLM_API_URL=...
AUTH0_M2M_DOMAIN=...
AUTH0_M2M_CLIENT_ID=...
AUTH0_M2M_CLIENT_SECRET=...
AUTH0_M2M_AUDIENCE=...
```

Аутентификация legacy mode:

- `/api/login` проверяет пользователя через Hasura admin query, выдаёт access token и refresh token.
- `/api/refresh` выполняет refresh token rotation.
- Access token содержит Hasura claims: allowed roles, default role и user id.
- Frontend хранит токены в `localStorage` и автоматически обновляет access token при истечении.

Backend cutover mode за `VITE_USE_BACKEND_AUTH=true` использует `/api/v1/auth/login`,
`/api/v1/auth/refresh`, `/api/v1/auth/logout` и `/api/v1/me`; refresh token остаётся в
HttpOnly cookie и не хранится в JS/localStorage.

Backend orders cutover mode за `VITE_USE_BACKEND_ORDERS_READ=true` и
`VITE_USE_BACKEND_ORDERS_WRITE=true` использует versioned `/api/v1/orders` для list/show/edit
load и create/update. Dual-write для заказов не используется: при выключенном write flag
остаётся legacy save path.

Листовые материалы в заказах (sheet materials) читаются из Hasura-схемы, которая
появляется только после применения соответствующей миграции и обновления Hasura
metadata. Frontend-флаг `VITE_SHEET_MATERIALS_READS` (runtime-config
`sheetMaterials`/`sheetMaterialsReads`, по умолчанию `false`) гейтит ВСЕ такие
чтения: дополнительные поля `sheet_material_type_id`/`sheet_eligible`, view
`order_details_view`, фильтр `materials.is_sheet_shadow` и сам picker. Порядок
включения строгий: сначала применить миграцию и Hasura metadata/permissions,
только потом поднимать флаг. Пока флаг `false`, заказы/календарь читаются как до
фичи, без обращения к новым колонкам.

Backend users/export/VLM cutover mode за `VITE_USE_BACKEND_USERS=true`,
`VITE_USE_BACKEND_ORDER_EXPORT=true` и `VITE_USE_BACKEND_VLM=true` использует versioned
`/api/v1/users`, `/api/v1/orders/:id/export/google-drive` и `/api/v1/vlm/*`.
Legacy Vercel Functions остаются rollback path, пока соответствующие backend flags и
external provider env не включены на runtime.

Backend payments/production/client-phones cutover mode за `VITE_USE_BACKEND_PAYMENTS=true`,
`VITE_USE_BACKEND_PRODUCTION_ACTIONS=true` и `VITE_USE_BACKEND_CLIENT_PHONES=true`
(client phones требует включённого production actions) использует `/api/v1/payments`,
order-scoped production/calendar/status/payment-status actions на `/api/v1/orders/:id/*`
и `/api/v1/client-phones`.

Backend projects mode за `VITE_USE_BACKEND_PROJECTS=true` (требует
`VITE_USE_BACKEND_ORDERS_READ=true`) включает страницу `/projects` и привязку заказов к
проектам через `/api/v1/projects` и `GET/PUT /api/v1/orders/:id/projects`. На backend
нужны `BACKEND_ENABLE_PROJECTS=true` и (для записи) `BACKEND_PROJECTS_READ_ONLY=false`.
Назначение проекта не входит в order-save payload — связи меняются только отдельной
project-link командой.

Backend deadlines read mode за `VITE_USE_BACKEND_DEADLINES=true` (требует backend auth и
orders read) показывает read-only deadline-панель заказа через `/api/v1/orders/:id/deadline-summary`,
`/deadlines` и `/deadline-events`.

Order JSON snapshot transfer работает через NestJS backend, когда
`BACKEND_ENABLE_ORDERS=true`. Экспорт доступен при `orders.export`, импорт —
при `orders.import` и выключенном `BACKEND_ORDERS_READ_ONLY`. UI добавляет:

- в просмотре заказа кнопку `JSON snapshot` для одиночной выгрузки
  `.erp-order.json`;
- в списке заказов кнопку `Выгрузка JSON` для ZIP-выгрузки заказов,
  созданных за выбранный период (`orders.created_at::date`);
- в списке заказов кнопку `Загрузка JSON` для одиночного `.erp-order.json`
  или batch `.erp-order-batch.zip`.

Перед использованием импорта нужно применить миграцию
`backend/db/migrations/005_order_snapshot_import_mapping.sql`. Формат
версионирован: `formatVersion=1.0.0`, `exporterService.version=1.0.0`; версия
сервиса включается в имя файла. Подробный контракт:
[docs/order-json-snapshot-v1.md](docs/order-json-snapshot-v1.md).

Stage note 2026-05-12: после frontend deploy кнопка выгрузки может получить
HTTP 404 `Cannot GET /api/v1/orders/:id/snapshot`, если VPS backend container
ещё не пересобран с новым контроллером. Лечение: rebuild/recreate только
`backend`, затем применить `005_order_snapshot_import_mapping.sql` для import
mapping и проверить authenticated single/batch export.

Frontend runtime config для canary/rollback загружается до React bootstrap из
`/runtime-config.json` или из `VITE_RUNTIME_CONFIG_URL`. Если файл отсутствует
или невалиден, используются build-time `VITE_*` значения. Пример лежит в
`public/runtime-config.example.json`; staged canary examples лежат в
`docs/runtime-config/canary/`. На Vercel `/runtime-config.json` отдаётся через
`api/runtime-config.ts` и env `RUNTIME_CONFIG_*`.

## VPS и Docker Compose

Vercel хостит только frontend и serverless runtime-config endpoint. Stage-1
NestJS backend, Hasura, PostgreSQL и Traefik хостятся на VPS через Docker
Compose.

Tracked source-of-truth для VPS Compose находится в
`ops/templates/docker-compose.vps.yml`; пример env — в
`ops/templates/env.vps.example`. В этих файлах не должно быть реальных секретов:
используются только ссылки вида `${PG_PASSWORD}`, `${HASURA_ADMIN_SECRET}`,
`${GAS_API_KEY}`. Реальные значения живут в VPS `.env`, который не коммитится.

`ops/setup-vps.sh` и `ops/deploy-stack.sh` создают live `docker-compose.yml` из
template, если его ещё нет. После ручного изменения live Compose на VPS нужно
перенести соответствующее не секретное изменение обратно в
`ops/templates/docker-compose.vps.yml`, иначе следующий bootstrap/deploy не будет
самодокументирован.

Можно запускать tracked template напрямую, без копирования в live
`docker-compose.yml`. В этом режиме `.env` должен лежать в runtime-корне,
который передан через `--project-directory`, потому что там же Compose будет
искать `data/`, `config/`, `backups/` и `restore/`.

Для текущей VPS-раскладки в этой ветке актуален прямой запуск tracked
template; root-level `docker-compose.yml` в `~/path/to/project`
не используется как отдельный source-of-truth.

```bash
cd ~/path/to/project

docker compose \
  --project-directory ~/path/to/project \
  -p <test-compose-project> \
  --env-file .env \
  -f repo_erp/ops/templates/docker-compose.vps.yml \
  up -d
```

Для этой раскладки `.env` лежит в `~/path/to/project/.env`, а
`BACKEND_BUILD_CONTEXT=./repo_erp/backend`, потому что backend находится не в
runtime-корне, а внутри checkout `repo_erp/`. `--project-directory` обязателен:
Compose должен искать runtime-директории `data/`, `config/`, `backups/` и
`restore/` именно в `~/path/to/project`, а не рядом с template.
Для обычного checkout, где `backend/`, `ops/`, `.env` и `data/` находятся в
одном корне, `BACKEND_BUILD_CONTEXT` можно не задавать: default `./backend`.

Frontend flags на Vercel и backend flags на VPS независимы. Например:

```env
# Vercel frontend runtime config
RUNTIME_CONFIG_BACKEND_PRODUCTION_ACTIONS=true

# VPS backend runtime
BACKEND_ENABLE_PRODUCTION_ACTIONS=true
```

Backend rate limit в `staging` и `production` требует Redis/Valkey-backed
storage. Пример non-secret Compose service для Valkey:

```yaml
services:
  valkey:
    image: valkey/valkey:7.2-alpine
    command: ["valkey-server", "--appendonly", "yes"]
    restart: unless-stopped
    volumes:
      - valkey_data:/data
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  backend:
    depends_on:
      valkey:
        condition: service_healthy
    environment:
      BACKEND_RATE_LIMIT_STORE: redis
      RATE_LIMIT_REDIS_URL: redis://valkey:6379
      READINESS_REQUIRE_REDIS: "true"

volumes:
  valkey_data:
```

Если используется managed Redis/Valkey, service `valkey` не нужен: достаточно
задать `RATE_LIMIT_REDIS_URL` или `REDIS_URL` в runtime `.env`.

После изменения backend Compose/env пересобирается и перезапускается только
backend service:

```bash
cd ~/path/to/project

docker compose \
  --project-directory ~/path/to/project \
  -p <test-compose-project> \
  --env-file .env \
  -f repo_erp/ops/templates/docker-compose.vps.yml \
  up -d --build --no-deps backend
```

Для изменения bind порта Postgres в этой раскладке используется
`PG_TAILSCALE_BIND_IP` в `.env`; текущий compose template публикует
`<postgres-service>` как `${PG_TAILSCALE_BIND_IP:-${PG_BIND_IP:-127.0.0.1}}:5432:5432`.

### Twenty CRM overlay и orphan-контейнеры

Twenty CRM запускается как отдельный overlay-файл
`repo_erp/ops/templates/docker-compose.twenty.yml` в том же compose-проекте, что
и основной стек (services `twenty`, `twenty_worker`, `twenty_db`, `twenty_redis`).
Так как контейнеры Twenty живут под тем же `-p <compose-project>`, любой вызов
`docker compose ... up` основного стека **без** overlay-файла пометит их как
orphan, а `--remove-orphans` их удалит.

Поэтому всегда передавай оба `-f` для любой операции над этим проектом, даже при
пересборке только backend:

```bash
docker compose \
  --project-directory ~/path/to/project \
  -p <test-compose-project> \
  --env-file .env \
  -f repo_erp/ops/templates/docker-compose.vps.yml \
  -f repo_erp/ops/templates/docker-compose.twenty.yml \
  up -d --build --no-deps backend
```

Не запускай `--remove-orphans` с одним только `docker-compose.vps.yml` — это
снесёт работающий Twenty-стек.

Audit:

- `created_by`, `edited_by`, `created_at`, `updated_at` управляются серверной стороной.
- Клиентские create/update payload очищаются от audit-полей в `dataProvider`.
- Backend command-модули (orders, payments, production actions, users) пишут
  системный журнал в таблицу `audit_log` в одной транзакции с командой.
  Записи содержат нормализованные измерения для выборки/отчётов: actor
  (user/role), entity type/id, request id, source, связи
  `related_order_id`/`related_client_id`/`related_payment_id`/`related_deadline_id`/`related_production_event_id`,
  status/stage коды и before/after/diff/metadata. Чувствительные поля
  (пароли, токены, секреты) редактируются перед сохранением. Permission-denied
  попытки логируются отдельными записями. Перед использованием применить
  миграции `audit_log`, включая `backend/db/migrations/012_audit_log_payment_deadline_dimensions.sql`.
- Чтение журнала: per-order `GET /api/v1/orders/:id/audit` и общий межсущностный
  `GET /api/v1/audit` с фильтрами по actor, entity type/id, связанным
  order/client/payment/deadline/production-event, event, source, request id и
  диапазону дат, пагинацией и маскированием чувствительных полей. Доступ к
  общему эндпоинту требует права `audit.view`.

## Twenty CRM sync

Backend поддерживает одностороннюю проекцию ERP→Twenty CRM: клиенты синхронизируются как Company, заказы — как ErpOrder. Синхронизация fail-closed по умолчанию и включается флагом `BACKEND_ENABLE_TWENTY_SYNC=true` на бэкенде. Дополнительные флаги управляют relay-owner (`BACKEND_TWENTY_SYNC_RELAY_OWNER`), dry-run режимом (`BACKEND_TWENTY_SYNC_DRY_RUN=true`) и параметрами воркера (интервал, batch size, lease). Для первоначальной синхронизации существующих данных запустить `npm run crm-sync:backfill` внутри пакета `backend/` (поддерживает `--dry-run`). Переменные `TWENTY_SYNC_BASE_URL` и `TWENTY_SYNC_API_KEY` настраиваются в `ops/templates/env.vps.example`; реальный ключ никогда не коммитится.

## Раскрой

Страница `/cut` отображает список заданий раскроя. Каждое задание охватывает набор деталей, сгруппированных по материалу; рассчитанные (ready) задания содержат SVG/PDF-рендер раскладки листов. Backend-модуль `cut-jobs` обслуживает операции через `/api/v1/cut-jobs`.

### Ручной редактор раскроя

Для готового задания оператор может нажать «Редактировать раскрой» и перейти в SVG-редактор:
перетащить детали между листами группы, повернуть каждую деталь — и сохранить результат как альтернативный (ручной) вариант через «Сохранить изменения». Изменения хранятся отдельно на сервере и не влияют на исходные данные заказа.

Переключатель «Показать альтернативный раскрой» позволяет сравнить авто- и ручной варианты прямо в карточке задания. Редактор доступен только пользователям с правом `cut.manage` и фиксирует каждое сохранение в системном журнале с outbox-событием.

### Параметр `variant` для рендер- и PDF-эндпоинтов

Эндпоинты рендера листов и PDF-экспорта принимают query-параметр `variant`:

| Значение | Поведение |
|---|---|
| `auto` (по умолчанию) | Автоматически рассчитанный вариант |
| `manual` | Сохранённый оператором ручной вариант |
| `active` | Тот вариант, который сейчас активен в задании |

Фронтенд передаёт `?variant=active` при печати задания, чтобы распечатать именно тот вариант, который видит оператор.

### Миграция существующих заданий (cutover)

Задания, рассчитанные до введения редактора, не содержат параметров `editorParams`, необходимых для SVG-редактора. При открытии такого задания будет показан промпт с предложением выполнить «Повторить расчёт». После однократного пересчёта `editorParams` заполняются и редактор становится доступен без потери уже размещённых деталей.

## Установка и запуск

```bash
npm install
npm run dev
```

Полный локальный запуск UI + API:

```bash
npm run dev:full
```

Доступные скрипты:

- `npm run dev` — только Vite UI на `5173`.
- `npm run dev:api` — только Vercel Functions на `3001`.
- `npm run dev:full` — UI и API вместе.
- `npm run build` — production build.
- `npm run preview` — preview build.
- `npm run version:daily` — если с последнего дневного обновления были изменения
  в коде, увеличивает patch-версию (`0.5.x`) на единицу и синхронизирует
  `package.json`, `package-lock.json` и `src/version.ts`.
- `npm run test` — unit/API tests через Vitest.
- `npm run test:e2e` — Playwright tests.
- `npm run test:e2e:frontend-pages` — Playwright smoke для всех зарегистрированных frontend routes.
- `npm run test:e2e:frontend-pages-stage-canary` — opt-in read-only smoke для deployed stage frontend routes.
- `npm run test:e2e:calendar` — Playwright smoke календаря, включая проверку `orders_view.version`.
- `npm run test:e2e:calendar-stage-canary` — opt-in Playwright smoke для deployed stage календаря против реальной Hasura schema.
- `npm run test:e2e:users-cutover` — Playwright smoke для backend users cutover flags.
- `npm run test:e2e:order-export-cutover` — Playwright smoke для backend order export cutover flag.
- `npm run test:e2e:payments-stage-canary` — opt-in Playwright smoke для stage payments UI/backend path с реальными DB writes на тестовом заказе.
- `npm run test:e2e:production-actions-cutover` — Playwright smoke для backend production actions/calendar moves cutover flag.
- `npm run test:e2e:production-actions-stage-canary` — opt-in Playwright smoke для stage production actions backend path с audit/outbox/idempotency checks.
- `npm run test:e2e:production-actions-mode-stage-canary` — opt-in write canary для backend команд переключения режима статуса производства (`/production-status-mode/auto` и `/manual`) на backend-test: enter-manual → restore-auto на тестовом заказе с audit/outbox/idempotency и restore-to-zero.
- `npm run test:e2e:deadline-engine-stage-canary` - opt-in read-only smoke for deployed Deadline Engine frontend/API stage acceptance.
- `npm run test:e2e:deadline-create-override-stage-canary` - opt-in write canary for deployed Deadline Engine create/override command acceptance on stage only.
- `npm run test:e2e:deadline-status-transition-stage-canary` - opt-in write canary for Deadline Engine `change_order_status` transition rules on backend-test only.
- `npm run test:e2e:notification-rules-project-scope-stage-canary` — opt-in write canary for project-scoped notification rules on backend-test only; requires explicit fixture key, credentials from external `.env`, and restore enabled.
- `npm run projects-live-backfill:manifest -- <manifest.json>` — local Projects live-backfill manifest validator and dry-run/write payload generator; does not call backend or mutate data.
- `npm run projects-live-backfill:proof-sql -- <manifest.json>` — local SQL proof query generator for a Projects live-backfill manifest; does not connect to the database.
- `npm run projects-live-backfill:run -- --manifest <manifest.json> --mode dry-run|write --target-env backend-test` — guarded Projects live-backfill runner for backend-test; write mode also requires `--approve-write` or `PROJECTS_LIVE_BACKFILL_APPROVE_WRITE=true`.
- `npm run test:e2e:projects-live-backfill-dry-run-stage-canary` — opt-in dry-run-only canary for an explicit Projects backfill manifest on backend-test; requires credentials from external `.env` and does not run write mode.
- `npm run test:e2e:order-ui-full-coverage` — opt-in durable Playwright coverage для заказа: заполняет формы, кликает кнопки, проверяет поля, вкладки, creator history и оставляет созданный заказ.
- `npm run test:e2e:order-created-by-stage-canary` — opt-in deployed backend canary: проверяет, что stage `/api/v1/orders/:id` отдает `createdBy/editedBy` для order UI.
- `npm run test:e2e:vlm-cutover` — Playwright smoke для backend VLM cutover flag.
- `npm run test:e2e:runtime-config` — Playwright smoke для runtime frontend flags.
- `npm run test:runtime-config-canary` — проверка staged runtime-config examples для canary.
- `npm run smoke:runtime-config` — проверка локального или deployed `/runtime-config.json`.
- `npm run smoke:staging-gates` — проверка staging runtime config и backend health gates.

## Тесты

### Регрессионный набор фронтенда

```bash
npm run test:e2e:regression
```

Запускает полный локальный mocked регрессионный набор через Playwright (Chromium):

- Рендер всех зарегистрированных frontend-страниц и runtime-config smoke.
- CRUD-покрытие справочников: все ресурсы из `reference-workflows.spec.ts`, включая четыре ранее непокрытых (`payments`, `users`, `order_workshops`, `order_resource_requirements`).
- Полный order+payment finance flow: добавление деталей, кнопки "Пересчитать суммы" / "Групповые действия" / "Удалить выбранные", инлайн-редактирование деталей и платежей, частичная и полная оплата, итого/оплачено/остаток, статус оплаты.
- Покрытие кнопок страницы заказов: "Выгрузка JSON", "Загрузка JSON", "Фильтры", "Применить".

Скриншоты артефактов сохраняются в каталог логов регрессии (`order/` и `reference/`, создаются автоматически при запуске); конкретный путь задаётся константой `SCREENSHOT_DIR` в `tests/regression/*.regression.spec.ts`.

Набор не требует поднятого stage/backend/PostgreSQL: все API-вызовы перехватываются Playwright route-моками. Рекомендуется запускать после значимых изменений frontend UI, форм, таблиц, вкладок или data-provider/mapping слоя.

Unit/API:

```bash
npm run test
cd backend && npm test
bash -lc 'set -a; . /path/to/project/.env; set +a; npm run test:backend:deadline-integration'
```

E2E:

```bash
npm run test:e2e
npx playwright test tests/reference-workflows.spec.ts --project=chromium
npm run test:e2e:frontend-pages
npm run test:e2e:calendar
npm run test:e2e:users-cutover
npm run test:e2e:order-export-cutover
npm run test:e2e:production-actions-cutover
npm run test:e2e:production-actions-stage-canary
npm run test:e2e:production-actions-mode-stage-canary
npm run test:e2e:deadline-engine-stage-canary
npm run test:e2e:deadline-create-override-stage-canary
npm run test:e2e:order-ui-full-coverage
npm run test:e2e:order-created-by-stage-canary
npm run test:e2e:payments-stage-canary
npm run test:e2e:vlm-cutover
npm run test:e2e:runtime-config
npm run test:runtime-config-canary
```

### Памятка по полному прогону

Обычный локальный полный Playwright прогон:

```bash
npx playwright test
```

Он поднимает `npm run dev:full`, использует `http://localhost:5173` и не должен
получать весь внешний `/path/to/project/.env` в окружение. Этот
файл может содержать stage/backend flags, которые меняют локальный runtime
(`VITE_USE_BACKEND_AUTH`, backend URLs и т.п.) и ломают mocked local E2E.

Stage/canary/integration правила:

- Stage/canary окружение на test-сервере считается доступным. Использовать
  `<test-postgres-container>`, `<test-backend-container>`, `<test-router-container>`,
  `<test-graphql-container>`.
- Stage URLs: `https://<stage-frontend-domain>` и
  `https://<stage-backend-domain>/api/v1`, если конкретный env override не
  задан во внешнем `.env`.
- Внешний `.env` грузить только в subshell/команду. Не печатать `.env`, `env`,
  `printenv`, `set`, connection strings, passwords, tokens или bypass secrets.
- Stage UI credentials брать из постоянного пользователя `<stage-test-username>`;
  password хранится только как `CODEX_PLAYWRIGHT_PASSWORD` во внешнем `.env`.
- Для stage specs, где нужны `FRONTEND_PAGES_STAGE_USERNAME/PASSWORD`,
  прокидывать тот же `<stage-test-username>` username/password, не создавая
  временного пользователя без причины.
- `DEADLINE_REPOSITORY_INTEGRATION_DATABASE_URL` должен указывать на test DB
  `erpdb`. Integration сам создает временную schema и удаляет ее. Не
  использовать production DB.
- Если canary скипается из-за env, сначала проверить и загрузить внешний `.env`
  в subshell; не оставлять skipped как итог, пока не проверено, что значения
  действительно отсутствуют.

Рекомендуемый порядок полного прогона:

```bash
npm test
cd backend && npm test
bash -lc 'set -a; . /path/to/project/.env; set +a; npm run test:backend:deadline-integration'
npx playwright test
```

После этого stage/canary Playwright запускать отдельным batch, а не смешивать с
локальным full run. Причина: для Deadline fixture canary нужны fail-closed
target guards, а полный внешний `.env` может одновременно включить stage flags
и backend auth для локальных mocked specs.

```bash
bash -lc '
set -a
. /path/to/project/.env
set +a

export CODEX_PLAYWRIGHT_USERNAME="${CODEX_PLAYWRIGHT_USERNAME:-<stage-test-username>}"
export FRONTEND_PAGES_STAGE_USERNAME="${FRONTEND_PAGES_STAGE_USERNAME:-$CODEX_PLAYWRIGHT_USERNAME}"
export FRONTEND_PAGES_STAGE_PASSWORD="${FRONTEND_PAGES_STAGE_PASSWORD:-$CODEX_PLAYWRIGHT_PASSWORD}"

export CALENDAR_STAGE_CANARY=true
export CLIENT_PHONES_STAGE_CANARY=true
export DEADLINE_CREATE_OVERRIDE_STAGE_CANARY=true
export DEADLINE_CREATE_OVERRIDE_RESTORE=true
export DEADLINE_ENGINE_STAGE_CANARY=true
export DEADLINE_ENGINE_STAGE_WORKER_WRITE_CANARY=true
export DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY=true
export DEADLINE_NOTIFICATION_ACTION_RESTORE=true
export DEADLINE_NOTIFICATION_ACTION_TARGET_ENV=<test-target-env>
export DEADLINE_SCHEDULER_EXTERNAL_OWNER_STAGE_CANARY=true
export BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER=external
export FRONTEND_PAGES_STAGE_CANARY=true
export FRONTEND_PAGES_STAGE_CREATE_USER=true
export ORDER_CREATED_BY_STAGE_CANARY=true
export PAYMENTS_STAGE_CANARY=true
export PRODUCTION_ACTIONS_STAGE_CANARY=true

export DEADLINE_WORKER_TARGET_ENV=<test-target-env>
export COMPOSE_PROJECT_NAME=<test-compose-project>
export APP_ENV=<test-target-env>
export BACKEND_ENV=<test-target-env>
export BACKEND_NODE_ENV=test
export NODE_ENV=test
export BACKEND_FQDN=<stage-backend-domain>
export FRONTEND_ORIGIN=https://<stage-frontend-domain>

export FRONTEND_PAGES_STAGE_FRONTEND_URL="${FRONTEND_PAGES_STAGE_FRONTEND_URL:-https://<stage-frontend-domain>}"
export FRONTEND_PAGES_STAGE_BACKEND_API_URL="${FRONTEND_PAGES_STAGE_BACKEND_API_URL:-https://<stage-backend-domain>/api/v1}"
export CALENDAR_STAGE_FRONTEND_URL="${CALENDAR_STAGE_FRONTEND_URL:-https://<stage-frontend-domain>}"
export CLIENT_PHONES_STAGE_FRONTEND_URL="${CLIENT_PHONES_STAGE_FRONTEND_URL:-https://<stage-frontend-domain>}"
export CLIENT_PHONES_STAGE_BACKEND_API_URL="${CLIENT_PHONES_STAGE_BACKEND_API_URL:-https://<stage-backend-domain>/api/v1}"
export PRODUCTION_ACTIONS_STAGE_FRONTEND_URL="${PRODUCTION_ACTIONS_STAGE_FRONTEND_URL:-https://<stage-frontend-domain>}"
export PRODUCTION_ACTIONS_STAGE_BACKEND_API_URL="${PRODUCTION_ACTIONS_STAGE_BACKEND_API_URL:-https://<stage-backend-domain>/api/v1}"
export PAYMENTS_STAGE_FRONTEND_URL="${PAYMENTS_STAGE_FRONTEND_URL:-https://<stage-frontend-domain>}"
export PAYMENTS_STAGE_BACKEND_API_URL="${PAYMENTS_STAGE_BACKEND_API_URL:-https://<stage-backend-domain>/api/v1}"
export DEADLINE_ENGINE_STAGE_FRONTEND_URL="${DEADLINE_ENGINE_STAGE_FRONTEND_URL:-https://<stage-frontend-domain>}"
export DEADLINE_ENGINE_STAGE_BACKEND_API_URL="${DEADLINE_ENGINE_STAGE_BACKEND_API_URL:-https://<stage-backend-domain>/api/v1}"
export ORDER_CREATED_BY_STAGE_BACKEND_API_URL="${ORDER_CREATED_BY_STAGE_BACKEND_API_URL:-https://<stage-backend-domain>/api/v1}"

export CALENDAR_STAGE_POSTGRES_CONTAINER="${CALENDAR_STAGE_POSTGRES_CONTAINER:-<test-postgres-container>}"
export CLIENT_PHONES_STAGE_POSTGRES_CONTAINER="${CLIENT_PHONES_STAGE_POSTGRES_CONTAINER:-<test-postgres-container>}"
export PRODUCTION_ACTIONS_STAGE_POSTGRES_CONTAINER="${PRODUCTION_ACTIONS_STAGE_POSTGRES_CONTAINER:-<test-postgres-container>}"
export PAYMENTS_STAGE_POSTGRES_CONTAINER="${PAYMENTS_STAGE_POSTGRES_CONTAINER:-<test-postgres-container>}"
export FRONTEND_PAGES_STAGE_POSTGRES_CONTAINER="${FRONTEND_PAGES_STAGE_POSTGRES_CONTAINER:-<test-postgres-container>}"
export DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER="${DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER:-<test-postgres-container>}"

export PLAYWRIGHT_SKIP_WEB_SERVER=true
npx playwright test \
  tests/calendar-frontend.spec.ts \
  tests/client-phones-stage-canary.spec.ts \
  tests/deadline-engine-create-override-stage-canary.spec.ts \
  tests/deadline-engine-notification-action-stage-canary.spec.ts \
  tests/deadline-engine-stage-canary.spec.ts \
  tests/deadline-engine-worker-stage-canary.spec.ts \
  tests/deadline-scheduler-external-owner-stage-canary.spec.ts \
  tests/frontend-pages-stage-canary.spec.ts \
  tests/order-created-by-stage-canary.spec.ts \
  tests/payments-stage-canary.spec.ts \
  tests/production-actions-stage-canary.spec.ts \
  tests/production-actions-mode-stage-canary.spec.ts \
  --project=chromium
'
```

Deadline worker/scheduler/notification fixture canary guards are intentional.
They fail-closed if `prod`, `production`, or `live` appears in target env keys.
For `<test-target-env>` runs, set all of these explicitly in the subshell:
`DEADLINE_WORKER_TARGET_ENV=<test-target-env>`,
`DEADLINE_NOTIFICATION_ACTION_TARGET_ENV=<test-target-env>`,
`COMPOSE_PROJECT_NAME=<test-compose-project>`, `APP_ENV=<test-target-env>`,
`BACKEND_ENV=<test-target-env>`, `BACKEND_NODE_ENV=test`, `NODE_ENV=test`,
`BACKEND_FQDN=<stage-backend-domain>`,
`FRONTEND_ORIGIN=https://<stage-frontend-domain>`. Do not use
`DEADLINE_WORKER_ALLOW_PRODUCTION=true` for stage/test canaries.

### Обязательное правило для крупных изменений фронта

Любое крупное изменение frontend UI, форм, вкладок, таблиц, кнопок, data-provider/mapping слоя или backend/frontend order flow должно обновлять `tests/order-ui-full-form-coverage.spec.ts`. Тест обязан оставаться полноценным пользовательским E2E: через UI заполнить все затронутые формы и вкладки, прокликать заявленные кнопки, проверить отображение и сохранение всех затронутых полей, снять скриншоты ключевых форм/вкладок и проверить историю создания через постоянного пользователя `<stage-test-username>`.

Перед завершением такого изменения нужно запускать:

```bash
set -a; . /path/to/project/.env; set +a
npm run test:e2e:order-ui-full-coverage
```

Тест создает durable-заказы с префиксом `E2E codex full coverage` и не удаляет их. Если изменение сознательно не затрагивает order UI, в ревью нужно явно написать, почему этот full coverage тест не обновлялся и не запускался.

Opt-in stage canaries require the deployed stage environment and VPS DB/Docker
access where noted by the specific checklist:

```bash
npm run test:e2e:frontend-pages-stage-canary
npm run test:e2e:calendar-stage-canary
npm run test:e2e:deadline-engine-stage-canary
```

`test:e2e:frontend-pages-stage-canary` is read-only by default and expects
`FRONTEND_PAGES_STAGE_USERNAME` / `FRONTEND_PAGES_STAGE_PASSWORD` for an
existing stage smoke user. For local VPS validation only, set
`FRONTEND_PAGES_STAGE_CREATE_USER=true` to create and deactivate a temporary
smoke user during the run.

Playwright запускает `npm run dev:full` через `webServer` и использует `http://localhost:5173` как `baseURL`.
GitHub Actions пока не используется; проверки перед коммитом и пушем выполняются
локально. Для mocked frontend e2e можно запустить только Vite и выставить
`PLAYWRIGHT_SKIP_WEB_SERVER=true`, потому что эти тесты сами мокают runtime-config
и GraphQL.
`tests/reference-workflows.spec.ts` покрывает CRUD справочников: создание записи,
редактирование всех полей формы, удаление записи и отдельный workflow телефонов
клиента.
Users backend cutover checklist: [docs/users-cutover-readiness.md](docs/users-cutover-readiness.md).
Order export backend cutover checklist: [docs/order-export-cutover-readiness.md](docs/order-export-cutover-readiness.md).
Order JSON snapshot transfer contract: [docs/order-json-snapshot-v1.md](docs/order-json-snapshot-v1.md).
VLM backend cutover checklist: [docs/vlm-cutover-readiness.md](docs/vlm-cutover-readiness.md).
Frontend runtime config checklist: [docs/frontend-runtime-config-readiness.md](docs/frontend-runtime-config-readiness.md).
Runtime config canary checklist: [docs/runtime-config-canary-readiness.md](docs/runtime-config-canary-readiness.md).
VPS Docker Compose/deploy checklist: [ops/README.md](ops/README.md).
Payments stage canary creates/updates/deletes a standalone payment through the
stage UI/backend path and verifies DB audit/order recalculation. It uses a
temporary test user and requires access to the stage `erpdb` Docker Postgres.
Deadline Engine stage canary is read-only for deadline data. It creates a temporary backend user, verifies runtime `backendDeadlines`, reads `/api/v1/orders/:id/deadline-summary`, `/deadlines`, and `/deadline-events`, then opens the deployed order show page and checks the read-only deadline panel. By default it targets stage order `11166` (`TEST-CODEX-STATUS3-DEBUG-20260516192743`); override with `DEADLINE_ENGINE_STAGE_ORDER_ID` and `DEADLINE_ENGINE_STAGE_ORDER_NAME` when using a different fixture.
Deadline create/override stage canary writes isolated manual deadline fixture rows through deployed backend endpoints, verifies idempotent create/override side effects in the stage DB, and restores all rows scoped by fixture key/request ids. The package script enables both `DEADLINE_CREATE_OVERRIDE_RESTORE=true` and `DEADLINE_CREATE_OVERRIDE_STAGE_CANARY=true`; it must not be run against production.
Deadline policy/settings stage canary writes one temporary policy and flips one
deadline settings-backed action-rule group through deployed backend endpoints.
It verifies denied policy/settings writes, config audit rows, no outbox writes,
and restores the temporary policy/audit rows plus the previous action-rule
snapshot. The package script enables `DEADLINE_POLICY_SETTINGS_RESTORE=true`,
`DEADLINE_POLICY_SETTINGS_STAGE_CANARY=true`, and
`DEADLINE_POLICY_SETTINGS_TARGET_ENV=backend-test`; it must not be run against
production or concurrently with another stage fixture mutation stream.

Deadline status transition stage canary creates fixture-scoped `change_order_status`
action rules and one temporary deadline, previews an order-level disabled
override, executes the real manual worker once, verifies production-action
audit/outbox evidence, and restores the original order status plus all fixture
rows. It requires `DEADLINE_STATUS_TRANSITION_TARGET_ENV=backend-test` and
`DEADLINE_STATUS_TRANSITION_RESTORE=true`; it must not be run against production.

Notification engine stage canary (`npm run test:e2e:notification-engine-stage-canary`)
is an opt-in, fail-closed scaffold that creates one isolated notification rule
and one pending outbox event fixture, triggers a manual outbox relay batch,
and proves exactly-once delivery to the visible recipient, denial for a
non-visible recipient, replay idempotency (no duplicate notification rows),
and a privacy scan of the delivered title/message before restoring all
fixture rows to zero. It refuses to run unless
`NOTIFICATION_ENGINE_TARGET_ENV=backend-test` and the backend API host
contains `backend-test` (prod/production/live targets are rejected), and it
skips locally when `NOTIFICATION_ENGINE_STAGE_CANARY` is unset.

Notification rules project-scope canary is guarded by
`NOTIFICATION_RULES_PROJECT_SCOPE_STAGE_CANARY=true`,
`NOTIFICATION_RULES_PROJECT_SCOPE_TARGET_ENV=backend-test`,
`NOTIFICATION_RULES_PROJECT_SCOPE_RESTORE=true`, and an explicit
`NOTIFICATION_RULES_PROJECT_SCOPE_FIXTURE_KEY`. It creates one temporary
project and two temporary notification rules, then restores scoped residue to
zero. Do not run it concurrently with other stage write canaries.

### Deadline notification action-rule stage canary

The notification action-rule stage canary targets `<test-target-env>` / `<test-compose-project>` only and uses isolated fixture key `deadline-notification-action-canary-2026-05-24`. Required gates:

```bash
npm run test:deadline-notification-action-fixture
DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY=deadline-notification-action-canary-2026-05-24 DEADLINE_NOTIFICATION_ACTION_ORDER_ID=<eligible-test-order-id> npm run test:e2e:deadline-notification-action-stage-canary
DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY=true DEADLINE_NOTIFICATION_ACTION_RESTORE=true DEADLINE_NOTIFICATION_ACTION_TARGET_ENV=<test-target-env> DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY=deadline-notification-action-canary-2026-05-24 DEADLINE_NOTIFICATION_ACTION_ORDER_ID=<eligible-test-order-id> npm run deadline-notification-action:fixture -- snapshot
```

Accepted restored snapshot has zero fixture deadlines, deadline events, action rules, action executions, and notifications. `BACKEND_DEADLINE_ACTIONS_ENABLED` and `BACKEND_DEADLINE_NOTIFICATIONS_ENABLED` remain default `false`; intentionally enable them only for isolated canary runs, then restore runtime config and rerun smoke.

### Deadline Engine residual scope

Stage accepted 2026-05-24: backend-backed notification API/build evidence for current-user persisted notifications. `NotificationBell`/`NotificationPanel` use `/api/v1/notifications`; local Zustand notification store remains transient frontend-only. Stage fixture `deadline-notification-ui-canary-2026-05-23` proved list, mark-read, delete, and zero residue after applying additive <test-target-env> migration `006_deadline_notifications_idempotency.sql`. Manual <stage-frontend> UI verification was attempted but blocked by Vercel login/SSO before the ERP login form loaded. Next residual slice is isolated notification action-rule stage canary.

Still disabled without separate approval:

- Production rollout for pause/resume/create/override.
- Global Deadline Engine action rules.
- Policy/settings writes.
- Order-save deadline sync.
- In-process or external always-on scheduler ownership.
- Production fixture writes.
- Non-notification action handlers: `set_overdue_flag`, `change_order_status`, `change_production_status`, `create_task`, `escalate`, and `webhook`.

Браузерный runtime проверяется через `npx playwright install chromium`.

Acceptance check 2026-05-02: `npm test`, `npm run build` и
`npm run test:e2e -- --project=chromium` прошли; backend enabled-flow smoke на локальной test DB
проверил auth/permissions/orders read-write через `/api/v1`.

## Примечания по реализации

- В legacy mode `orders_view` и аналитические views используются для чтения; запись идёт в базовые таблицы через Hasura.
- В backend orders mode `OrderList`, `OrderShow`, `OrderForm` и `useOrderSave` используют `/api/v1/orders` за feature flags.
- Для новых ресурсов нужно добавить primary key в `ID_COLUMNS` и selection fields в `RESOURCE_FIELDS`.
- `dataProvider` автоматически добавляет `is_active = true` для активируемых справочников, если фильтр `is_active` не задан явно.
- Форма заказа хранит черновик в Zustand store и использует `temp_id` для новых строк до сохранения.
- Сохранение заказа последовательное: header, детали, удаления, пересчёт итогов, платежи, production/workshop/resource блоки, присадки, invalidation.
- Этапы производства отображаются по workflow-настройке из `app_settings`; факты этапов хранятся отдельно от текущего статуса заказа.
- VLM upload/analyze проходит через Vercel API, проверку ERP JWT и Auth0 M2M token.
- Google Drive export не раскрывает GAS API key на frontend: ключ добавляется только в serverless function.
- Глобальная локаль интерфейса — `ru_RU`.
