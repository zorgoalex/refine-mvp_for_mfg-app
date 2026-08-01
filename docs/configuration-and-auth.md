# Конфигурация, авторизация и аудит

## Секреты

Project-level `.env` для локальных и stage smoke-команд хранится вне
репозитория. Загружайте его только для нужной команды и никогда не печатайте
файл, connection strings, passwords, tokens или bypass secrets.

Безопасный шаблон:

```bash
bash -lc '
set -a
. /path/to/project/.env
set +a
<command>
'
```

`VERCEL_AUTOMATION_BYPASS_SECRET` может находиться в этом файле, даже если
переменная не экспортирована в текущем shell.

## Frontend env

Основные build-time значения:

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
VITE_USE_BACKEND_GROUPS=false
VITE_USE_BACKEND_REFERENCES=false
VITE_USE_BACKEND_CUT=false
VITE_USE_BACKEND_BAZIS_CUT=false
VITE_ORDER_STATUS_BOARD=false
VITE_USE_BACKEND_CNC_TELEGRAM=false
VITE_SHEET_MATERIALS_READS=false
VITE_ENABLE_LEGACY_HASURA=true
VITE_WORKOS_AUTH=false
VITE_BITRIX24_URL=https://bitrix24.example.com/
VITE_BITRIX24_LABEL=Битрикс24
VITE_RUNTIME_CONFIG_URL=/runtime-config.json
```

Frontend runtime overlay загружается до React bootstrap из
`/runtime-config.json` либо `VITE_RUNTIME_CONFIG_URL`. При отсутствии или
невалидном документе используются build-time `VITE_*` значения.

Пример: `public/runtime-config.example.json`. Canary-конфиги:
`docs/runtime-config/canary/`.

Подробности:

- [Frontend runtime config](frontend-runtime-config-readiness.md)
- [Runtime config canary](runtime-config-canary-readiness.md)

## Vercel Functions env

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

## Legacy и backend auth

Legacy mode:

- `/api/login` проверяет пользователя через Hasura admin query;
- `/api/refresh` выполняет refresh token rotation;
- access token содержит Hasura allowed/default role и user id;
- frontend хранит legacy tokens в `localStorage`.

Backend cutover mode за `VITE_USE_BACKEND_AUTH=true` использует:

- `/api/v1/auth/login`;
- `/api/v1/auth/refresh`;
- `/api/v1/auth/logout`;
- `/api/v1/me`.

Пользовательская сессия имеет абсолютный срок 10 часов
(`AUTH_SESSION_TTL_SECONDS=36000`). Внутри неё access token действует 15 минут
(`ACCESS_TOKEN_TTL_SECONDS=900`) и обновляется автоматически. Технический
refresh-token не может жить дольше 7 дней (`REFRESH_TOKEN_TTL_DAYS=7`), но его
фактический срок всегда ограничен абсолютным сроком пользовательской сессии.
Access token, выданный перед концом сессии, также обрезается по этой границе.

Refresh token остаётся в HttpOnly cookie и не хранится в JavaScript.

## WorkOS AuthKit

WorkOS даёт опциональный гибридный вход через hosted AuthKit: email/password,
Google и MFA TOTP. WorkOS подтверждает identity, но ERP-сессию, роли и
permissions выдаёт backend из PostgreSQL. Автоматического создания ERP-users
нет.

- Кнопка SSO появляется при `VITE_WORKOS_AUTH=true` и включённом backend auth.
- Привязка identity выполняется из живой ERP-сессии.
- Пользователь может иметь несколько SSO identities.
- Отвязка требует подтверждения паролем и запрещена, если учётной записи
  разрешён только внешний вход.
- Чужие identities доступны администратору только с `users.manage_sso`.
- `users.login_policy`: `local`, `external` или `both`.

Backend env:

```env
BACKEND_ENABLE_WORKOS_AUTH=false
WORKOS_API_KEY=...
WORKOS_CLIENT_ID=...
WORKOS_REDIRECT_URI=https://<frontend-domain>/auth/workos/callback
```

Redirect URI регистрируется в WorkOS dashboard. Backend routes:

- `GET /api/v1/auth/workos/authorize`;
- `POST /api/v1/auth/workos/callback`;
- `POST /api/v1/auth/workos/link/start`;
- `POST /api/v1/auth/workos/link/callback`;
- `GET /api/v1/auth/workos/links`;
- `DELETE /api/v1/auth/workos/links/:identityId`;
- `GET /api/v1/auth/workos/admin/users/:userId/links`;
- `DELETE /api/v1/auth/workos/admin/users/:userId/links/:identityId`.

При выключенном backend-флаге эти routes возвращают 503; локальный password
login продолжает работать.

## Backend cutover modes

### Заказы

`VITE_USE_BACKEND_ORDERS_READ=true` и
`VITE_USE_BACKEND_ORDERS_WRITE=true` переводят list/show/edit/create/update на
`/api/v1/orders`. Dual-write отсутствует: при выключенном write-флаге остаётся
legacy save path.

### Листовые материалы

`VITE_SHEET_MATERIALS_READS` либо runtime
`sheetMaterials`/`sheetMaterialsReads` гейтит чтение новых sheet-material
полей, views и picker. Порядок включения:

1. применить DB migration;
2. обновить Hasura metadata и permissions;
3. включить frontend-флаг.

### Users, export и VLM

`VITE_USE_BACKEND_USERS`, `VITE_USE_BACKEND_ORDER_EXPORT`,
`VITE_USE_BACKEND_VLM` переключают соответствующие flows на:

- `/api/v1/users`;
- `/api/v1/orders/:id/export/google-drive`;
- `/api/v1/vlm/*`.

Legacy Vercel Functions остаются rollback path до полного cutover.

### Payments, production actions и client phones

`VITE_USE_BACKEND_PAYMENTS`, `VITE_USE_BACKEND_PRODUCTION_ACTIONS` и
`VITE_USE_BACKEND_CLIENT_PHONES` включают backend commands. Client phones
требует production-actions mode.

### Groups

`VITE_USE_BACKEND_GROUPS=true` требует backend orders read. Backend:
`BACKEND_ENABLE_GROUPS=true`; для записи также
`BACKEND_GROUPS_READ_ONLY=false`. Связи заказа и группы меняются отдельной
командой, не order-save payload.

### Deadlines

`VITE_USE_BACKEND_DEADLINES=true` требует backend auth и orders read.
Frontend читает `/api/v1/orders/:id/deadline-summary`, `/deadlines` и
`/deadline-events`.

### CNC Telegram

`VITE_USE_BACKEND_CNC_TELEGRAM=true` включает на странице досок статусов
визуальный поток «Работы сегодня» с выбором даты за последнюю неделю.
Эффективный frontend-флаг требует `VITE_ORDER_STATUS_BOARD=true` и backend
orders read.

Backend включается отдельно:

```env
BACKEND_ENABLE_CNC_TELEGRAM=true
```

API:

- `GET /api/v1/cnc-telegram/today` требует `orders.view`;
- `POST /api/v1/cnc-telegram/ingest` требует `cut.manage`,
  header `Idempotency-Key` и принимает только структурированный JSON. Если
  `date` не передан в today-read, backend использует `CURRENT_DATE` PostgreSQL
  в business timezone контура.

Backend не принимает и не хранит raw screenshot/G-code payload. Временные файлы
Telegram-бота или OCR worker удаляют на своей стороне; файлы старше 24 часов
должны hard-delete без архивации.

Для исторической проверки worker перечитывает Telegram history за нужный день и
повторно отправляет structured packet. Backend хранит только structured
projection, поэтому это не нарушает raw-retention.

Prod worker включается Compose profile:

```env
COMPOSE_PROFILES=cnc-telegram
TELEGRAM_API_ID=<api-id>
TELEGRAM_API_HASH=<api-hash>
TELEGRAM_CHAT=<chat-id-or-username>
TELEGRAM_ALLOWED_CHAT_ID=<expected-chat-id>
CNC_TELEGRAM_ERP_API_URL=http://backend:3000/api/v1
ERP_WORKER_LOGIN=<user-with-cut.manage>
ERP_WORKER_PASSWORD=<password>
CNC_TEMP_TTL_HOURS=24
CNC_HISTORY_DAYS=7
CNC_POLL_INTERVAL_SECONDS=120
GLM_OCR_MODEL_FILE=GLM-OCR-Q8_0.gguf
GLM_OCR_MMPROJ_FILE=mmproj-GLM-OCR-Q8_0.gguf
GLM_OCR_RUNNER_URL=http://glm-ocr-runner:8001/ocr
```

`ERP_BEARER_TOKEN` может заменить `ERP_WORKER_LOGIN/PASSWORD`.
`CNC_OCR_COMMAND` по умолчанию вызывает internal `glm-ocr-runner`; переопределять
его нужно только для кастомного OCR pipeline.
Первый start profile скачивает GLM-OCR GGUF и multimodal projector в Docker
volume через `glm-ocr-model-init`; дальше `llama-server` читает локальные файлы.

## JSON snapshot заказов

Snapshot export/import работает через NestJS, когда
`BACKEND_ENABLE_ORDERS=true`.

- карточка заказа: одиночный `.erp-order.json`;
- список заказов: ZIP-выгрузка за период;
- импорт: одиночный `.erp-order.json` или `.erp-order-batch.zip`.

Импорт требует миграцию
`backend/db/migrations/005_order_snapshot_import_mapping.sql`.
`formatVersion=1.0.0`, `exporterService.version=1.0.0`.

Полный контракт: [JSON snapshot заказов](order-json-snapshot-v1.md).

## Аудит

- `created_by`, `edited_by`, `created_at`, `updated_at` задаются сервером.
- Frontend очищает audit-поля из create/update payload.
- Backend command-модули пишут `audit_log` в одной транзакции с бизнес-командой.
- Запись содержит actor, role, entity type/id, request id, source, related
  dimensions, status/stage codes, before/after/diff/metadata.
- Пароли, tokens и secrets редактируются до сохранения.
- Permission-denied попытки логируются отдельно.
- Общий read endpoint: `GET /api/v1/audit`.
- Аудит заказа: `GET /api/v1/orders/:id/audit`.
- Общий endpoint требует `audit.view`.

Для актуального read-model должны быть применены все audit migrations, включая
`backend/db/migrations/012_audit_log_payment_deadline_dimensions.sql`.
