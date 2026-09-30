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

Пользовательская сессия имеет абсолютный срок 48 часов
(`AUTH_SESSION_TTL_SECONDS=172800`). Внутри неё access token действует 15 минут
(`ACCESS_TOKEN_TTL_SECONDS=900`) и обновляется заранее, до истечения. Технический
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

### CAD

`BACKEND_ENABLE_CAD=true` включает интеграцию с CAD. Новый редактор дополнительно
требует `BACKEND_CAD_EDITOR_V2=true` (по умолчанию false).

`cad.technology` разрешает защищённые настройки; `cad.approve` — индивидуальное
одобрение с причиной и подтверждением CAD. Оба права по умолчанию только у
админа/суперадмина. «Расширенный режим» меняет отображение, но не расширяет права.

См. [работу в редакторе](feature-guides.md#cad-редактор-фрезеровок) и
[порядок включения и отката](deployment-and-operations.md#cad-редактор-фрезеровок).

### Заказы

`VITE_USE_BACKEND_ORDERS_READ=true` и
`VITE_USE_BACKEND_ORDERS_WRITE=true` переводят list/show/edit/create/update на
`/api/v1/orders`. Dual-write отсутствует: при выключенном write-флаге остаётся
legacy save path.

### Потребности заказов: отметка «Закуплено»

`BACKEND_RESOURCE_PROCUREMENT_ENABLED` (backend, по умолчанию `false`) включает
отметки «Закуплено» у материалов заказа: команды
`PUT /api/v1/orders/{orderId}/resource-procurement/{resourceKey}` и
`POST /api/v1/orders/resource-procurement/bulk`, карточку
`GET /api/v1/orders/{orderId}/resource-demands` и сводку
`GET /api/v1/orders/resource-demands/by-material`. Отдельного frontend-флага нет:
интерфейс включает эти функции по полю `capabilities` в ответе backend, поэтому
выключение флага возвращает экран к прежнему виду без пересборки frontend.
Отмечать закуп может роль с правом `procurement.manage`; видимость заказов — по
scope `orders.view`. Порядок включения:

1. применить миграции `194_order_resource_procurement.sql` и
   `197_onec_purchase_documents.sql` (197 требует таблицу `onec_sources` из
   `193_onec_agent_foundation.sql`);
2. выставить `BACKEND_RESOURCE_PROCUREMENT_ENABLED=true` и пересоздать backend.

При выключенном флаге таблицы закупа и документов 1С не читаются, а команды и
экран документов отвечают `503 PROCUREMENT_DISABLED`.

Тот же флаг включает раздел «Закупки → Документы 1С»:
`GET /api/v1/procurement/onec-documents` (вкладки приходов и оплат),
`GET /api/v1/procurement/onec-documents/{documentId}` и распределение строк
документа на материалы заказов
`POST|DELETE /api/v1/procurement/onec-documents/{documentId}/lines/{lineId}/allocations[/{allocationId}]`.
Чтение — право `procurement.view`, распределение — `procurement.manage`; суммы и
распределение оплат — только с `finance.view`. Документы появляются в ERP из
интеграции с 1С; до её подключения список пуст. Пока у материала есть приход из
проведённого документа 1С, отметку «Закуплено» снять нельзя (`409
PROCUREMENT_LOCKED_BY_ONEC`) — сначала снимается распределение прихода.

### Потребности заказов: экран снабжения

`BACKEND_PROCUREMENT_WORKSPACE_ENABLED` (backend, по умолчанию `false`) вместе с
`BACKEND_RESOURCE_PROCUREMENT_ENABLED` включает на экране «Потребности заказов в
ресурсах» вторую вкладку «Экран снабжения» — рабочий список «заказ × материал»:
`GET /api/v1/procurement/worklist` (покрытие приходами 1С и ручной отметкой,
дефицит, срок «нужно к», срочность, основной поставщик; все фильтры на сервере) и
сохранённые представления `GET|PUT /api/v1/procurement/worklist/saved-views`.
Вкладка «Потребность заказов» от флага не зависит. Интерфейс показывает вкладку
по `capabilities.supplyWorkspace` и праву `procurement.view`; групповая отметка
«Закуплено» — право `procurement.manage`.

Настройки — вкладка «Закупки» на экране «Конфигурация»
(`GET|PUT /api/v1/procurement/settings`, изменение — право `settings.manage`):
«нужно к» = плановая дата завершения заказа минус N рабочих дней (по умолчанию 2),
пороги «срочно»/«скоро» (3/7 дней), запас на обрезки (5 %), время утренней сводки,
срок напоминания о нераспределённом приходе и глубину просрочки для рабочего списка
(по умолчанию 30 дней). Рабочий список берёт незавершённые и невыданные заказы: без
плановой даты — всегда, с датой — от «сегодня − глубина просрочки» до «сегодня + 60
дней»; более старые находятся поиском или фильтром «Нужно к: с».

Поставщик материала: заполненный вручную в справочнике листовых материалов;
иначе — первый поставщик, от которого материал пришёл по документу 1С. Каждый
новый поставщик только добавляется в список (`resource_suppliers`), первый не
затирается.

Порядок включения (миграция меняет источник отметок «Закуплено», поэтому запись
закупа на время выкладки выключается):

1. `BACKEND_RESOURCE_PROCUREMENT_ENABLED=false`, пересоздать backend (команды
   закупа отвечают 503, экран работает без отметок);
2. выложить backend с `204_procurement_workspace.sql` и применить миграцию: она
   создаёт настройки, реестр поставщиков, колонку сохранённых представлений и
   помечает отметки, поставленные приходом 1С, как `origin='onec'`;
3. сверочный запрос: нет отмеченных записей с `origin='manual'`, у которых
   последнее «ставящее» событие аудита — распределение прихода;
4. `BACKEND_RESOURCE_PROCUREMENT_ENABLED=true`, затем
   `BACKEND_PROCUREMENT_WORKSPACE_ENABLED=true`, пересоздать backend.

#### Заявки поставщикам

`BACKEND_SUPPLIER_REQUESTS_ENABLED` (backend, по умолчанию `false`; нужны оба флага
выше и миграция `214_supplier_requests.sql`) включает раздел «Заявки поставщикам»
на экране снабжения: `GET /api/v1/procurement/supplier-requests` (список),
`POST …/drafts` (черновики из выделенных позиций рабочего списка — по заявке на
поставщика, по строке на материал; повтор с тем же `requestId` возвращает прежний
результат), `GET|PATCH …/:id` (карточка и правка черновика) и
`POST …/:id/send|close|cancel`. Чтение — `procurement.view`, команды —
`procurement.manage`. Номер заявки — `ГГ-NNNN`, счётчик на год. Количество в
заявке — дефицит позиции плюс запас на обрезки (для потребности по площади),
листы — целыми, остаток сверх заказов — «на склад». Отправка только меняет статус;
во внешние системы ничего не уходит. Количество по отправленным заявкам рабочий
список показывает как «заказано» и не считает дефицитом, пока заявка не закрыта или
не отменена. При выключенном флаге маршруты отвечают `503 SUPPLIER_REQUESTS_DISABLED`,
а раздел и кнопка «Сформировать заявки» не показываются.

### Справочник плёнок: импорт каталога 1С

`BACKEND_FILM_CATALOG_IMPORT_ENABLED` (backend, по умолчанию `false`) включает
импорт каталога плёнок: `/api/v1/catalog-imports*` (черновик, сопоставление,
применение, отмена, откат, выгрузка в Excel). При выключенном флаге эти маршруты
отвечают `404`. Кнопку «Импорт каталога 1С» на странице `/films` показывает
frontend-флаг `RUNTIME_CONFIG_FILM_CATALOG_IMPORT`.

Права: импорт — `references.manage`; источник «Зеркало 1С» и пакеты, созданные из
него, — дополнительно `onec.view` (проверяется при каждом запросе к пакету).
История названий `GET /api/v1/films/{filmId}/name-history` и поиск похожих
`GET /api/v1/films/similar` — `references.view`, работают без флага.

Колонки `films.canonical_film_id`, `films.catalog_key` и `films.ref_key_1c`
записывает только backend: Hasura разрешает запись в `films` лишь по явному списку
колонок, а триггер базы отклоняет изменение служебных колонок вне операции
импорта. Порядок включения:

1. применить миграции `202_film_catalog_import.sql` и `203_film_stock.sql`
   (аддитивны, совместимы с прежними frontend/backend) и перезагрузить схему Hasura
   (`reload_metadata`), чтобы новые колонки `films` стали доступны для чтения;
2. выкатить frontend (читает новые колонки, форма `/films` больше не отправляет
   `ref_key_1c`) и backend;
3. применить Hasura metadata для `films` (явный список колонок записи + preset
   `edited_by`) — только после шага 2, иначе прежний frontend не сможет сохранить плёнку;
4. выставить `BACKEND_FILM_CATALOG_IMPORT_ENABLED=true`, пересоздать backend и
   включить `RUNTIME_CONFIG_FILM_CATALOG_IMPORT`.

Миграция `212_films_note.sql` (колонка `films.note`) применяется ДО выкладки
frontend и backend этой версии (frontend запрашивает `note` у Hasura) и затем
`reload_metadata`; права insert/update `films` в Hasura получают колонку `note`.
Минимальная версия backend для черновиков из файла решений — эта; перед откатом
backend ниже неё отменить черновики с источником «Файл решений».

### Склад плёнки

`BACKEND_INVENTORY_ENABLED` (backend, по умолчанию `false`) включает склад плёнки:
`/api/v1/inventory/*` (склады, остатки, журнал документов, ручной приход/списание/
инвентаризация, импорт файла остатков, проведение и отмена черновиков) и
`GET /api/v1/orders/{orderId}/film-stock`, `GET /api/v1/inventory/stock` (вкладки по
материалам: плёнка ERP + остатки 1С из зеркала, только чтение; без модуля 1С —
только плёнка). При выключенном флаге маршруты
отвечают `404`. Frontend-флаг `RUNTIME_CONFIG_INVENTORY` показывает раздел
«Склады → Остатки на складах» и метки остатка в заказе.

Права: чтение — `inventory.view`, изменения — `inventory.manage`. Документы,
привязанные к заказу, видны и изменяемы только при `orders.view` и доступе к этому
заказу. Команды записи требуют заголовок `Idempotency-Key`. Остатки ведутся по
основной плёнке справочника; списание в минус требует подтверждения
(`allowNegative`). Порядок включения: миграция `203_film_stock.sql` (после 202),
затем `BACKEND_INVENTORY_ENABLED=true`, пересоздание backend и
`RUNTIME_CONFIG_INVENTORY`.

Справочник складов (`/api/v1/inventory/warehouses`) пишет только backend; в Hasura
таблица `warehouses` — только чтение. Каждый склад привязан к складу 1С
(`ref_key_1c`, `Ref_Key` справочника «Структурные единицы», тип «Склад»); при
доступном зеркале 1С ключ проверяется по нему, `POST …/warehouses/sync-onec`
создаёт склады ERP для всех складов 1С (зеркало обязательно).

Миграция `205_warehouses_onec_key_required.sql` (CHECK `ref_key_1c IS NOT NULL`
NOT VALID) применяется **после** выкладки backend со справочником складов с ключом
1С: такой backend работает и без 205, а прежний создаёт склады без ключа и после
205 получит отказ. Порядок: backend + frontend → миграция 205 → привязать склады
без ключа в «Справочнике складов» (на проде без зеркала 1С — ввод `Ref_Key`
вручную). Откат backend ниже этой версии: сначала
`ALTER TABLE public.warehouses DROP CONSTRAINT IF EXISTS chk_warehouses_ref_key_1c_required;`
(данные не меняются; повторное применение 205 вернёт ограничение).

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

Преобразование CRM-заявки Bitrix в производственный заказ регистрирует уже
заданные плановые даты в той же транзакции, что и заказ. Требуются
`BACKEND_ENABLE_DEADLINES=true` и `BACKEND_DEADLINES_READ_ONLY=false`.
Флаг `BACKEND_ENABLE_DEADLINE_ORDER_SYNC` управляет обычным сохранением заказов,
но не является условием этой явной команды преобразования.

Даты без планового значения не придумываются. Ошибка регистрации срока
откатывает преобразование, включая проект, статусы деталей и аудит. Повтор с тем
же ключом возвращает прежний результат без повторного создания сроков.
События истории/аудита/очереди сохраняются; запуск общей очереди уведомлений для
завершения преобразования не нужен. Автоматический контроль просрочки,
действия и доставка уведомлений включаются отдельно и этим изменением не запускаются.
Исторические события `orders.production_initialized` без маркера
`deadlineInitialization=transactional_v1` сохраняют прежний отложенный обработчик;
новые помеченные события не регистрируют сроки повторно при обработке очереди.

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
- `POST /api/v1/cnc-telegram/worker-logs/batch` требует `cut.manage`, точное
  совпадение пользователя с `CNC_TELEGRAM_WORKER_USERNAME` и разрешённый chat id;
- `GET /api/v1/cnc-telegram/worker-logs/capabilities` fail-closed проверяет полный
  результат миграций `107_cnc_telegram_worker_audit.sql`,
  `108_cnc_telegram_worker_audit_reason_codes.sql` и
  `109_cnc_telegram_worker_audit_classification_codes.sql` до чтения Telegram;
- `GET /api/v1/cnc-telegram/worker-logs` требует `audit.view` и возвращает
  сканирования, сообщения, неизменяемые наблюдения, попытки обработки и ответы.

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
CNC_POLL_INTERVAL_SECONDS=60
CNC_AUDIT_SPOOL_PATH=/data/cnc-telegram-audit.sqlite3
```

`ERP_BEARER_TOKEN` может заменить `ERP_WORKER_LOGIN/PASSWORD`. Обычный worker
обрабатывает только валидный SVG и не запускает OCR. GLM-OCR остаётся отдельным
fallback profile и в обычном `cnc-telegram` не запускается и не вызывается.
Временное переключение выполняется командой
`repo_erp/ops/cnc-telegram-worker.sh up-glm`; возврат к SVG-only режиму — обычным
`repo_erp/ops/cnc-telegram-worker.sh up`. Для постоянного fallback нужно вместе
задать `COMPOSE_PROFILES=cnc-telegram,cnc-telegram-glm`,
`CNC_ENABLE_GLM_OCR=true`,
`CNC_OCR_COMMAND="python -m cnc_telegram_worker.glm_ocr_client --image {image}"`,
`CNC_OCR_COMMAND_TIMEOUT_SECONDS=720` и `CNC_OCR_ENGINE=glm-ocr-0.9b-q8`.
Outer command timeout должен быть больше `GLM_OCR_CLIENT_TIMEOUT_SECONDS` (по
умолчанию 660); engine входит в source fingerprint.

### Интеграция 1С

Backend: `BACKEND_ENABLE_ONEC_AGENT` (по умолчанию `false`), `ONEC_AGENT_PORT`
(3001, отдельный listener только для API агента), `ONEC_INGRESS_SECRET` /
`ONEC_INGRESS_SECRET_PREVIOUS`, `ONEC_CLIENT_CERT_HEADER`,
`ONEC_AGENT_SESSION_TTL_MS`, `ONEC_AGENT_HEARTBEAT_INTERVAL_MS` (агент считается
молчащим после трёх интервалов), `BACKEND_ONEC_MONITOR_OWNER`
(`none` | `in_process`: алерты, сроки сертификатов, очистка) и
`BACKEND_ONEC_MONITOR_INTERVAL_MS`. Frontend: `RUNTIME_CONFIG_BACKEND_ONEC`
(Vercel runtime config → `features.backendOnec`) или `VITE_USE_BACKEND_ONEC`.

Права: `onec.view` (просмотр раздела; подразумевается правами `onec.manage` и
`onec.commands.send`), `onec.manage` (источники, агенты, сертификаты,
конфигурация), `onec.commands.send` (служебные команды агенту). Миграция 193
выдаёт их ролям admin и superadmin.

Конфигурация агента версионируется: черновик сохраняется с `If-Match: <revision>`,
публикуется только подтверждённая ревизия; опубликованные версии неизменяемы.
Хеш конфигурации считается по алгоритму агента `agent-payload-sha256-base64-v1`.

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
- Во вкладке «Журналы → Bitrix24» доступны события интеграции обоих направлений
  и отдельное текущее состояние очередей. Общие журналы передают
  `excludeBitrix24=true`; вкладка интеграции — `scope=bitrix24`.
  Разделение выполняется на сервере до подсчёта, пагинации и списка фильтров.
  Обычные события ERP на связанных с Bitrix объектах не исключаются.
- Поиск заказа в техническом журнале и Bitrix работает по номеру/названию и
  точному ID. Отсутствие Bitrix mapping не мешает найти исходящее задание.
- `GET /api/v1/audit/bitrix24/status`, `/queue`, `/event-options` требуют
  `audit.view`, ничего не отправляют и не изменяют. `owner=external` не
  подтверждает наличие внешнего процесса, а `in_process` — его исправность.
  Прошлые незаписанные попытки не восстанавливаются; новые обратные ошибки
  фиксируются атомарно с очередью. Сверка платежей и их перенос — разные события.
- На вкладке `Аудит → Telegram-бот` отдельно видны все сообщения, которые worker
  получил из истории и поиска ответов: sender/session id, файл/текст, решение,
  причина, этапы, packet/cut ids и точный ответ с исходным Telegram message id.

Для актуального read-model должны быть применены все audit migrations, включая
`backend/db/migrations/012_audit_log_payment_deadline_dimensions.sql`.
