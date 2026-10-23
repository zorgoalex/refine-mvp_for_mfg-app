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
  Приглашение на привязку создаётся только для учётной записи, права которой не шире прав администратора, и
  перестаёт действовать, если к моменту использования создатель потерял право или цель получила более широкие права.
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

Команды над пользователями (`/api/v1/users`) выполняются под общей блокировкой состояния прав
(`permissions_state`), после неё права администратора проверяются заново по данным БД:

- учётная запись (после изменения) не может иметь прав или областей, которых нет у администратора
  (`USER_ESCALATION_DENIED`); исключение — `system.superadmin`;
- смена роли или активности (в том числе `PATCH` с `isActive: false`) повышает версию прав — текущие токены
  обновляются при следующем запросе; выключение отзывает сессии;
- нельзя оставить систему без активного пользователя с `system.superadmin`, `roles.manage` и
  `permissions.manage` (`PERMISSIONS_LOCKOUT_DENIED`);
- ответ содержит `rowVersion`; необязательный `expectedVersion` в теле (`PATCH`, `activate`, `deactivate`)
  отклоняет устаревшую форму (409 `USER_VERSION_CONFLICT`);
- необязательный заголовок `Idempotency-Key`: повтор того же запроса возвращает сохранённый ответ без новых
  изменений, аудита и событий — до проверок прав (ответ уже был выдан этой командой); тот же ключ с другим
  запросом или от другого пользователя — 409 `IDEMPOTENCY_KEY_REUSED`. Пароль в запросах создания и смены пароля
  учитывается через HMAC с серверным `REFRESH_TOKEN_PEPPER`; без него ключ для этих команд не действует. Ответ
  смены пароля содержит новый `rowVersion`;
- смена роли, активности и создание пользователя пишут событие `authorization.changed` в outbox (доставка
  пока не подключена); аудит содержит `permissionsVersionBefore/After` и `accessChanges`.

### Payments, production actions и client phones

`VITE_USE_BACKEND_PAYMENTS`, `VITE_USE_BACKEND_PRODUCTION_ACTIONS` и
`VITE_USE_BACKEND_CLIENT_PHONES` включают backend commands. Client phones
требует production-actions mode.

### Groups

`VITE_USE_BACKEND_GROUPS=true` требует backend orders read. Backend:
`BACKEND_ENABLE_GROUPS=true`; для записи также
`BACKEND_GROUPS_READ_ONLY=false`. Связи заказа и группы меняются отдельной
командой, не order-save payload.
Пакетная привязка записей к группе требует права `groups.batch_link`: миграция 249 выдаёт его ролям
admin и top_manager (прежний список ролей), миграция 252 — также superadmin.

### Hasura: права пользователя, а не только роль

Каждое разрешение Hasura, кроме чтения `app_settings` (настройки интерфейса и навигации), требует итоговое право
пользователя: предикат `_exists` по представлениям `user_effective_permissions` / `user_effective_scopes`
(`X-Hasura-User-Id`). Роль Hasura остаётся верхней границей набора таблиц, а снятое у роли право закрывает и прямой
GraphQL. Правила — `ops/hasura/access-predicates.json`, применение — `ops/hasura/access-predicates.sh`
(шаг A аддитивный: представления, связи, роль `erp_admin`; шаг B — предикаты остальных ролей и отзыв неиспользуемых
таблиц; `status`, `--dry-run`, `revert --step B`). `apply` требует `--expect` — утверждённый снимок релиза
(`ops/hasura/metadata.json`): если живые метаданные к нему не приводят, ничего не применяется.

Флаг `permissions_state.hasura_access_predicates` (миграция 253) — «Hasura следует правам»: его включает шаг B,
выключает откат. Пока он выключен (до шага B и после отката), матрица прав отклоняет любое снятие права и сужение
области (`422 PERMISSION_NARROWING_BLOCKED`): Hasura продолжала бы отдавать снятое. Откат сначала выключает флаг под
той же блокировкой `permissions_state`, что и матрица, затем сверяет матрицу со снимком шага B и отказывает, если
права ролей сузились после него.

- Строки заказов (`orders_view`, детали, связи присадки, производственные события) — право `orders.view` и область:
  `all`/`assigned` — все, `own` — автор или ответственный менеджер (как backend). Присадка видна, если её собственный
  заказ и все активно связанные заказы доступны. Записывать присадку и её связи через Hasura нельзя (см. ниже).
- Присадка пишется только командами backend: `POST /api/v1/doweling-orders` (создание; с `orderId` — сразу со связью
  с заказом в одной транзакции), `PATCH /api/v1/doweling-orders/:id` (карточка: поля, активность и полный список
  заказов, с `expectedVersion`), а связи заказа — сохранение заказа. Правило одно для всех путей, включая импорт
  заказа из файла: `doweling.create`/`doweling.update` и право менять (`orders.update` с областью) каждый заказ, к
  которому присадка относится или будет относиться; заказ, который пользователь не видит, отвечает 404. Версия
  присадки растёт при любом изменении её полей или связей любым путём (миграция 256), поэтому устаревшая карточка
  получает `409 DOWELING_VERSION_CONFLICT`, а устаревшая форма заказа не возвращает снятую связь
  (`409 ORDER_DOWELING_LINK_STALE`). Права записи Hasura на `doweling_orders` и `order_doweling_links` снимает
  `ops/hasura/doweling-backend-owned-writes.sh` (после выкладки backend и фронтенда; `--revert` восстанавливает их
  из `doweling-writes-before-revoke.json` и запускается до отката фронтенда).
- Справочники: чтение — «…: просмотр», правка и удаление — «…: управление»; добавить кромку, фрезеровку или плёнку из
  формы заказа можно также с правом `references.quick_create` (миграция 253 выдала его ролям, которые делали это
  раньше: superadmin, admin, top_manager, manager, operator).
- Администратор ERP получает в токене роль Hasura `erp_admin` (встроенная роль Hasura `admin` игнорирует правила):
  те же предикаты, без `refresh_tokens`, `users.password_hash` и записи заказов/платежей; старые экраны платежей,
  цехов и потребностей заказа читаются только ею и только с нужными правами.
- Финансовые колонки строк заказов, деталей и присадки пока видны всем, кто читает строку. Поэтому матрица прав не
  даёт снять `orders.view_financials` у роли (`422 PERMISSION_NARROWING_BLOCKED`), пока эти колонки не закрыты.

Режим упаковщика (роль `packer`: смена статуса заказа только на разрешённые упаковщику статусы без права
`orders.update`, урезанные данные формы заказа) остаётся ограничением базовой роли, а не правом: он не выдаётся и
не снимается через матрицу прав.

### Заявки Bitrix24: область видимости

Какие заявки Bitrix24 видны пользователю, решают права (миграция 249): `bitrix24.requests.view_all` — все
заявки (superadmin, admin, top_manager), `bitrix24.requests.view_assigned` — только назначенные пользователю
(manager, operator). При обоих правах действует «все»; без них — 403. Сами действия по-прежнему требуют
`bitrix24.requests.view`/`update`/`convert`.

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
`BACKEND_ONEC_MONITOR_INTERVAL_MS`. `BACKEND_ONEC_ALERT_NOTIFICATIONS` (по умолчанию `false`) — доставка оповещений 1С в колокольчик (см. выше). `BACKEND_ONEC_STOCK_SNAPSHOTS` (по умолчанию `false`): можно запрашивать срезы
остатков 1С на дату (нужен агент ≥ 1.3.11 и процесс-владелец монитора); при `false` очередь только доводит начатое и
выключает служебный набор конфигурации — см. `backend/docs/onec-stock-snapshots.md`. `BACKEND_ONEC_NIGHTLY_FULL_SYNC_HOUR_UTC` (час UTC 0–23,
по умолчанию `-1` — выключено): раз в сутки в этот час процесс-владелец монитора ставит каждому активному агенту
`start_full_sync` по всем наборам (одна команда на агента за ночь; пропуск, если полная выгрузка уже доставлена агенту
в эту ночь или открыта и успеет до срока). Окно запуска и срок команды — 4 ч от часа (21:00 UTC → не позже 01:00 UTC),
команду, не полученную агентом до срока, ERP не выдаёт. Если до срока агент не получил ни одной полной выгрузки по всем
наборам (ночной или ручной), после окна — алерт «Ночная полная выгрузка не прошла» (событие модуля
`onec.etl.nightly_full_sync_missed`, закрывает оператор). Проверяются только ночи, когда расписание действовало в этот час:
включение, смена часа и выключение (`-1`) записываются в аудит (`onec.nightly_full_sync.activated`) как начало нового периода;
обычный перезапуск с тем же часом период не меняет. Нужна при оконной
ежечасной выгрузке (`windowField`/`incrementalWindowDays` в конфигурации агента): только полная выгрузка отмечает строки,
исчезнувшие в 1С. Frontend: `RUNTIME_CONFIG_BACKEND_ONEC`
(Vercel runtime config → `features.backendOnec`) или `VITE_USE_BACKEND_ONEC`.

Ожидаемое ежедневное молчание агента (миграция 247): в карточке агента («Редактировать») задаётся интервал по UTC
`ЧЧ:ММ-ЧЧ:ММ` (может переходить через полночь, не длиннее 120 минут) — время, когда агент планово выключен, например
остановка перед ночной перезагрузкой компьютера 1С. Монитор не поднимает оповещение «агент молчит», если последний
сигнал агента пришёл не раньше начала интервала (с запасом в порог молчания) и текущее время внутри интервала. Молчание,
начавшееся задолго до интервала, и молчание, которое продолжается после его конца, оповещаются как обычно. Пустое
значение снимает настройку; изменение пишется в аудит (`onec.agent.updated`).

Роль «Оператор интеграции 1С» (`onec_operator`, `role_id` 32, миграция 245) — учётная запись, которой доступен
только этот раздел: права `onec.view`, `onec.manage`, `onec.commands.send` и собственный профиль; заказов, платежей,
справочников, пользователей и аудита у роли нет, в Hasura для неё нет разрешений. Что видит оператор: копию данных 1С
(в ней есть телефоны и контакты контрагентов) и экраны сопоставления, где показаны названия и идентификаторы
клиентов, поставщиков и номенклатуры ERP. Роль назначается **только при создании пользователя** (это могут
администратор и суперадминистратор); сменить роль существующего пользователя на неё или с неё нельзя — отказывают
и backend, и триггер БД `trg_users_onec_operator_role_guard` (он действует и для прямых записей в `users`). Чтобы
снять доступ — отключите учётную запись. Откат роли перед возвратом на сборку backend без неё — ручной скрипт
`backend/db/migrations/245_onec_operator_role_rollback.sql` (выключает роль, переводит такие учётки в «Наблюдателя»
неактивными, пишет аудит).

Сверка поступлений 1С с платежами заказов (нужна миграция 240): `BACKEND_ONEC_PAYMENT_MATCHING_VIEW`
(по умолчанию `false`) включает вкладку «Платежи → Поступления 1С» и её API чтения
(`GET /api/v1/payments/onec-receipts[/{lineId}]`), а также вычитание возвратов покупателю из «Оплачено» заказа 1С через
возвращаемое поступление (при выключенном флаге действует прежняя формула). Работает только при включённой интеграции
1С. `BACKEND_ONEC_ORDER_NUMBER_SERIES` — серия номеров заказов покупателей 1С, которые являются заказами приложения
(номер 1С `<серия>-<номер заказа>`, например `Ф25`; только буквы и цифры; пусто — правило выключено, заказ приложения
определяется только ручной связью). Права: `payments.onec.view` (вместе с `payments.view` и `orders.view_financials` — суммы заказов и платежей; область видимости — как у
платежей: свои или все заказы), `payments.onec.manage` — для команд сверки (следующий этап).

Права: `onec.view` (просмотр раздела; подразумевается правами `onec.manage` и
`onec.commands.send`), `onec.manage` (источники, агенты, сертификаты,
конфигурация), `onec.commands.send` (служебные команды агенту). Миграция 193
выдаёт их ролям admin и superadmin.

Конфигурация агента версионируется: черновик сохраняется с `If-Match: <revision>`,
публикуется только подтверждённая ревизия; опубликованные версии неизменяемы.
Хеш конфигурации считается по алгоритму агента `agent-payload-sha256-base64-v1`.

Энергонезависимый том `onec-etl-spool` (`ONEC_ETL_SPOOL_DIR`, владелец разбора пакетов — `BACKEND_ONEC_ETL_WORKER_OWNER`,
`none` | `in_process`) хранит принятые пакеты выгрузки до разбора; `ONEC_ETL_SPOOL_MIN_FREE_BYTES` — порог свободного
места, ниже которого приём пакета отклоняется с повторяемой ошибкой.

Обязательный балун `mandatory` (миграция `263_mandatory_balloons_delivery_checks.sql`) — у оповещений интеграции 1С
(`source_type = 'onec_alert'`); правила его не выбирают. Не исчезает; клик по телу открывает экран «Интеграция 1С», но
балун не закрывает — только крестик; критичный — с красной полосой. Выдаётся без ограничения возраста и независимо от
прочтения строки, пока не показан, и только вкладке, заявившей поддержку заголовком
`X-Balloon-Capabilities: mandatory` (тело claim прежнее; старая вкладка таких балунов не получает, старый backend
заголовок игнорирует). До показа строку нельзя удалить: `DELETE /api/v1/notifications/:id` → `409
NOTIFICATION_BALLOON_PENDING`, в колокольчике такие строки при удалении пропускаются (`balloonPending` в ответе).
Оповещения 1С видны в колокольчике только с буквальным правом `onec.view` на момент чтения. Строки внешней доставки
(`notification_channel_deliveries`) могут нести `required_permission` и `expires_at`: воркер Telegram перед
отправкой, в одной транзакции (`permissions_state` → `users` → строка), пропускает просроченные (`EXPIRED`) и строки
получателя, который отключён (`USER_INACTIVE`) или лишился права (`PERMISSION_MISSING`), не вызывая Telegram.

Доставка оповещений 1С (миграция `264_onec_alert_notifications.sql`, флаг `BACKEND_ONEC_ALERT_NOTIFICATIONS`, по
умолчанию `false`): диспетчер в тике монитора 1С (нужен `BACKEND_ONEC_MONITOR_OWNER=in_process`), независимо от
движка правил. Виды оповещений разложены по 8 группам (агент не на связи, состояние агента, выгрузка, команды,
конфигурация и база 1С, сертификат, срезы остатков, прочие); у группы — важность (`auto` — по оповещению), получатели
(роли и пользователи), повтор критичных, сообщение о восстановлении. Стадии: «открыто» (открытия одной группы и
источника собираются в одно уведомление в окне 0–120 с), «стало критичным», «напоминание» (только критичные, пока
оповещение не принято, не более 12 раз), «восстановлено», «сводка» — при включении флага уже открытые оповещения
приходят одной сводкой на группу, а не по одному. Каждая стадия — строка колокольчика каждому получателю с балуном
`mandatory` (ключ `onec_alert:{dispatch_id}:{user_id}`); отправка, её участники, получатели, статус эпизодов и аудит
`onec.alert_notification.dispatched` пишутся одной транзакцией. Получатели: выбранные (только активные с буквальным
`onec.view`) → все с `onec.manage` и `onec.view` → суперадмины с `onec.view`; если некому — стадия ждёт, а на экране
1С открыто критичное оповещение «Оповещения 1С некому доставить». Настройка — «Конфигурация → Оповещения 1С»
(`GET /api/v1/onec/alert-notification-policies` — `onec.view`; `PATCH …/:group` с `If-Match` и
`POST …/:group/test` — `onec.manage`; `GET /api/v1/onec/alert-notifications/recent`). Колокольчик и балун
отключить нельзя; Telegram — позже. Если диспетчер, будучи включённым, не работал дольше
30 минут (backend стоял, откат образа), первый тик снова считает это включением: накопленное приходит сводкой. Перед
откатом образа — флаг `false` (дождаться `active = false` в `onec_alert_notification_state`, если backend работает) и
перевести ещё не показанные обязательные балуны в `persistent`: `UPDATE notifications SET balloon_mode = 'persistent'
WHERE balloon_mode = 'mandatory' AND balloon_shown_at IS NULL` — до запуска прежнего образа и ещё раз сразу после
(пока работал новый backend, строку мог добавить, например, «Проверить»; прежний таких строк не пишет). Backend до
оповещений 1С режима `mandatory` не знает: он выдаёт такие строки без режима, интерфейс их пропускает, не подтверждая,
и они занимают выдачу остальных балунов до истечения 24 часов.

WhatsApp для оповещений 1С (миграция `265_onec_alert_whatsapp.sql`) идёт через канал уведомлений WhatsApp
(`docs/whatsapp-notifications.md` в backend). Каналы группы: `whatsapp` — лично каждому получателю на рабочий номер
сотрудника (канал перепроверяет `onec.view` при постановке и отправке), `whatsapp_chat` — в выбранный чат; выбрать
или сменить чат может только пользователь, у которого есть и `onec.manage`, и `whatsapp.manage`. Ключ доставки —
`onec-alert:{dispatch_id}:whatsapp:{user:<id>|chat:<id>}:attempt{n}`; каждый вызов канала изолирован точкой
сохранения, так что сбой WhatsApp не отменяет колокольчик и балун. Задержка (0–120 мин) касается только WhatsApp о
новом оповещении: если за это время все его оповещения закрылись, в WhatsApp ничего не уходит
(`RESOLVED_BEFORE_DELAY`); оповещение, которое открылось и закрылось между двумя проходами, приходит только в
колокольчик и окно (`RESOLVED_BEFORE_SEND`). Сообщение о восстановлении идёт в WhatsApp только тем адресатам (лично
или в чат), кому ушла тревога по тем же оповещениям (состояние канала `sent` или `unknown`); остальным строка
записывается как `ALARM_NOT_SENT`. Каждый адресат получает в нём только те оповещения, тревога о которых
дошла до него. Пока доставка тревоги этому адресату ещё в пути или ждёт задержки, сообщение о восстановлении ждёт её
итога — его диспетчер спрашивает у канала раз в минуту, до 26 часов от восстановления; после этого уходит только то, что
точно дошло. Срок доставки самого сообщения о восстановлении — 6 часов от начала разрешённого окна (после тихих часов). Тихие часы (время Алматы) переносят отправку на их конец; критичные идут сразу, если это
включено, сообщение о восстановлении всегда ждёт утра. Срок жизни — 2 ч, для «восстановлено» — 6 ч, от начала
отправки. Когда все оповещения тревожной отправки закрылись, её неначатые доставки отменяются; при снятии канала или
смене чата в настройке — тоже. Доставку, которую канал отменил из-за перезапуска backend (`delivery_gap`) или по
сроку (`expired`), диспетчер ставит заново той же строкой получателя, пока отправка актуальна, — не больше 3 попыток.
Состояния видны в «Последних оповещениях»; «Проверить» шлёт WhatsApp и себе, и в чат. На stage WhatsApp выключен —
строки записываются как `skipped/WHATSAPP_DISABLED`.

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
- Записи сверки платежей Bitrix24 (`bitrix24_reverse.order_payments_reconcile`,
  `bitrix24_reverse.request_payments_reconcile`) хранятся полностью 7 дней. Старше
  остаются только записи с изменением: `metadata.changed = true` либо состояние
  `after`, отличное от предыдущей записи того же объекта; первая запись объекта
  остаётся всегда. Вместе с ними удаляются обработанные события плановой сверки
  из очереди, на которые не ссылается ни одна оставшаяся запись аудита. Очистку
  выполняет worker обратной синхронизации каждые 30 минут небольшими пакетами; каждый запуск, удаливший
  строки, пишет событие `bitrix24_reverse.reconcile_retention_pruned` с границей и
  счётчиками. Правило задано функцией `prune_bitrix24_reconcile_noise`
  (`backend/db/migrations/226_bitrix24_reconcile_retention.sql`); миграция
  разово очищает накопленное пакетами и возобновляется после прерывания. Место на
  диске освобождает только `VACUUM FULL audit_log, bitrix24_inbound_event`.
- На вкладке `Аудит → Telegram-бот` отдельно видны все сообщения, которые worker
  получил из истории и поиска ответов: sender/session id, файл/текст, решение,
  причина, этапы, packet/cut ids и точный ответ с исходным Telegram message id.

Для актуального read-model должны быть применены все audit migrations, включая
`backend/db/migrations/012_audit_log_payment_deadline_dimensions.sql`.

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

1. применить миграции `202_film_catalog_import.sql`, `212_films_note.sql` и
   `234_reference_nomenclature_note.sql` (аддитивны, совместимы с прежними frontend/backend) и
   перезагрузить схему Hasura (`reload_metadata`), чтобы новые колонки стали доступны для чтения;
2. выкатить backend этой версии — ДО frontend: frontend сопоставляет плёнки импортируемых
   заказов по индексу названий `GET /api/v1/films/name-index`, а без него (прежний backend)
   каждая плёнка импорта требует ручного выбора;
3. выкатить frontend (читает новые колонки, форма `/films` больше не отправляет `ref_key_1c`);
4. применить Hasura metadata для `films` (явный список колонок записи + preset
   `edited_by`; точечно, без замены всей metadata — `ops/hasura/films-write-permissions.sh plan|apply`) — только после шага 3, иначе прежний frontend не сможет сохранить плёнку;
5. выставить `BACKEND_FILM_CATALOG_IMPORT_ENABLED=true`, пересоздать backend и
   включить `RUNTIME_CONFIG_FILM_CATALOG_IMPORT`.

Откат:

- до шага 4 и пока в `film_name_history` нет записей (плёнки не переименовывались и не
  объединялись) — обычный: сначала вернуть frontend, затем backend; миграции остаются;
- после шага 4 (права Hasura) либо после первого переименования/объединения плёнки frontend и
  backend ниже этой версии НЕ откатываются: прежний frontend подбирает плёнку импортируемого заказа
  только по справочнику (после переименований — молча не ту) и отправляет в Hasura колонку
  `ref_key_1c`, которую metadata уже не принимает. Аварийный путь — исправлять вперёд:
  ошибочно применённый пакет сначала откатить командой «Откатить» в мастере импорта (она, как и
  весь `/api/v1/catalog-imports*`, работает только при включённом
  `BACKEND_FILM_CATALOG_IMPORT_ENABLED`), и лишь затем выключить импорт
  (`BACKEND_FILM_CATALOG_IMPORT_ENABLED=false`, `RUNTIME_CONFIG_FILM_CATALOG_IMPORT=false`). Если
  флаги уже выключены, а пакет нужно откатить: включить оба флага, откатить пакет, выключить снова.
- backend ниже этой версии при выложенном frontend этой версии не откатывать ни на каком шаге:
  без индекса названий каждая плёнка импорта требует ручного выбора.

Права insert/update `films` в Hasura включают колонку `note` (frontend запрашивает её у Hasura).
Минимальная версия backend для черновиков из файла решений — эта; перед откатом
backend ниже неё отменить черновики с источником «Файл решений».

## Закупки, экран снабжения и документы 1С

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

`BACKEND_PROCUREMENT_WORKSPACE_ENABLED` (backend, по умолчанию `false`) вместе с
`BACKEND_RESOURCE_PROCUREMENT_ENABLED` включает на экране «Потребности заказов в
ресурсах» вторую вкладку «Экран снабжения» — рабочий список «заказ × материал»:
`GET /api/v1/procurement/worklist` (покрытие приходами 1С и ручной отметкой,
дефицит, срок «нужно к», срочность, основной поставщик; все фильтры на сервере) и
сохранённые представления `GET|PUT /api/v1/procurement/worklist/saved-views`.
Вкладка «Потребность заказов» от флага не зависит. Интерфейс показывает вкладку
по `capabilities.supplyWorkspace` и праву `procurement.view`; групповая отметка
«Закуплено» — право `procurement.manage`.

1. `BACKEND_RESOURCE_PROCUREMENT_ENABLED=false`, пересоздать backend (команды
   закупа отвечают 503, экран работает без отметок);
2. выложить backend с `204_procurement_workspace.sql` и применить миграцию: она
   создаёт настройки, реестр поставщиков, колонку сохранённых представлений и
   помечает отметки, поставленные приходом 1С, как `origin='onec'`;
3. сверочный запрос: нет отмеченных записей с `origin='manual'`, у которых
   последнее «ставящее» событие аудита — распределение прихода;
4. `BACKEND_RESOURCE_PROCUREMENT_ENABLED=true`, затем
   `BACKEND_PROCUREMENT_WORKSPACE_ENABLED=true`, пересоздать backend.

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

`BACKEND_SUPPLIER_TEXT_TEMPLATES_ENABLED` (backend, по умолчанию `false`; работает поверх
`BACKEND_SUPPLIER_REQUESTS_ENABLED`) — шаблоны текста заявки поставщику. В карточке заявки кнопка «Текст для
поставщика» открывает окно: выбор шаблона (текст перестраивается сразу), ручная правка текста и копирование; редактор
«Мои шаблоны…» — там же, на экране снабжения. Шаблоны двух видов:

- общие (миграция `229_supplier_text_templates.sql`, включая «Стандартный» — прежний текст) — только чтение, их можно
  «Скопировать себе»; маршрут `GET /procurement/supplier-text-templates` отдаёт только их, команды записи на этом
  маршруте отключены (`409 SUPPLIER_TEXT_TEMPLATE_SHARED_READ_ONLY`);
- личные (миграция `239_personal_supplier_text_templates.sql`) — у каждого пользователя свои (до 20), видит и меняет
  только владелец; маршрут `/procurement/my-supplier-text-templates`, достаточно права `procurement.view`. Шаблон
  «по умолчанию» каждый выбирает для себя (свой или общий); команда выбора передаёт `expectedDefaultRevision` из
  списка.

Порядок выкладки: миграция 239 → backend → frontend. Прежняя версия backend личные шаблоны не видит (отдельные
таблицы и маршрут), поэтому откат backend безопасен: новый frontend при этом показывает общие шаблоны только для
чтения. Флаг выключен — API шаблонов отвечает `503 SUPPLIER_TEXT_TEMPLATES_DISABLED`, карточка заявки сообщает
`capabilities.supplierTextTemplates=false`, и в окне показывается прежний стандартный текст; данные шаблонов остаются.

`BACKEND_PROCUREMENT_NOTIFICATIONS_ENABLED` (backend, по умолчанию `false`) — уведомления закупа, только в
приложении (in_app). Миграция `225_procurement_notification_rules.sql` засевает **выключенное** правило
«Материал пришёл по заказу» (`order.resource_procurement_changed`: распределение прихода 1С на заказ →
ответственному по заказу); включается на экране правил. Флаг проверяется движком в момент обработки события:
выключен — событие обрабатывается без уведомлений и после включения не переигрывается; событие старше 24 часов
(например, реле стояло) тоже пропускается. Для событий закупа правило обязано перечислить
`procurementChangeTypes`, канал `telegram` не принимается (`422`). Такие уведомления (`source_type`
`procurement_order_event` / `procurement_digest`) видны в списке, счётчике, «прочитать», «прочитать всё» и
удалении только при праве `procurement.view` и пока заказ в текущем scope `orders.view` читателя; скрытые строки
не удаляются и возвращаются при восстановлении доступа.

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
(`allowNegative`).

Порядок выкладки и включения — единый для всего склада: миграции `203_film_stock.sql`,
`205_warehouses_onec_key_required.sql`, `206_inventory_onec_autosync_state.sql` и
`217_inventory_onec_consumption.sql` (все четыре, после 202; backend склада читает колонки
каждой из них, в том числе `warehouses.onec_consumption_since` из 217 при выключенном расходе)
→ backend этой версии → права Hasura `warehouses` (`ops/hasura/warehouses-read-only.sh`) →
`BACKEND_INVENTORY_ENABLED=true`, пересоздание backend и `RUNTIME_CONFIG_INVENTORY`.
Включать склад на схеме без любой из четырёх миграций нельзя.

Справочник складов (`/api/v1/inventory/warehouses`) пишет только backend; в Hasura
таблица `warehouses` — только чтение. Каждый склад привязан к складу 1С
(`ref_key_1c`, `Ref_Key` справочника «Структурные единицы», тип «Склад»); при
доступном зеркале 1С ключ проверяется по нему, `POST …/warehouses/sync-onec`
создаёт склады ERP для всех складов 1С (зеркало обязательно).

Миграция `205_warehouses_onec_key_required.sql` — CHECK `ref_key_1c IS NOT NULL` NOT VALID:
существующие строки не проверяются, новая или изменяемая запись склада обязана иметь ключ 1С.
Склад «Склад плёнки», созданный миграцией 203 без ключа, привязывается к складу 1С в
«Справочнике складов» (без зеркала 1С — ввод `Ref_Key` вручную). Backend без справочника складов
в `warehouses` не пишет, поэтому 205 применяется вместе с остальными миграциями до backend. Если
понадобится backend, создающий склады без ключа: сначала
`ALTER TABLE public.warehouses DROP CONSTRAINT IF EXISTS chk_warehouses_ref_key_1c_required;`
(данные не меняются; повторное применение 205 вернёт ограничение).

Расход из документов 1С: `BACKEND_INVENTORY_ONEC_CONSUMPTION` (backend, по умолчанию
`false`) переносит расход плёнки из документов 1С (реализация, возврат поставщику,
списание, перемещение) в учёт склада. Нужны `BACKEND_INVENTORY_ENABLED`, загрузка
документов 1С и `BACKEND_INVENTORY_ONEC_AUTOSYNC_ACTOR_USER_ID` — от имени этого
служебного пользователя пишутся документы `onec`. Без него backend с включённым
флагом не стартует. Маршруты: `GET /api/v1/inventory/onec-consumption/issues`
(`inventory.view`), `POST /api/v1/inventory/onec-consumption/run` и
`POST /api/v1/inventory/warehouses/{warehouseId}/onec-consumption/compensate`
(`inventory.manage`; компенсация — с `Idempotency-Key`). `PATCH …/warehouses/{id}`
принимает `onecConsumptionSince`, инвентаризация (ручная и импорт) — `countedAt`.
Склад участвует, только если у него задан `onecConsumptionSince`.

Порядок включения:

1. Миграция `217_inventory_onec_consumption.sql`.
2. Backend и frontend.
3. На складе провести инвентаризацию с моментом подсчёта.
4. Задать «Расход из 1С с» (тот же момент).
5. Включить флаг и пересоздать backend.
6. Проверка: «Пересчитать сейчас»; сумма документов «Документ 1С» должна равняться сумме
   строк 1С, а повторный пересчёт — давать «записано изменений 0».

Приход из поступлений 1С: `BACKEND_INVENTORY_ONEC_RECEIPTS` (backend, по умолчанию
`false`) добавляет к той же проекции поступления от поставщика (`purchase_receipt`) —
с плюсом на склад строки документа 1С. Действует только вместе с
`BACKEND_INVENTORY_ONEC_CONSUMPTION`; вид `purchase_receipt` должен быть в
`BACKEND_ONEC_DOCUMENTS_KINDS`. Миграций нет. Выключение флага и пересоздание backend
возвращает уже применённый приход следующим проходом (документы-дельты остаются в
журнале); строки «Не учтено из 1С» по поступлениям при этом остаются до следующего
включения. Откат склада (`…/onec-consumption/compensate`) при включённом приходе или
применённом плюсе требует в теле `includesReceipts: true` — иначе `409
ONEC_COMPENSATION_CONFIRM_REQUIRED` без изменений (защита от не обновлённой вкладки со
старым текстом подтверждения).

С выключенным флагом проход не выполняется, а компенсация работает. Откат:
«Откатить учёт 1С» на каждом складе с датой начала (можно уже с выключенным флагом),
затем выключить флаг. Документы `onec` остаются в журнале.

Точечные скрипты прав Hasura: `ops/hasura/warehouses-read-only.sh plan|apply` снимает прежние права записи
`warehouses` (чтение остаётся); всю metadata не заменяет.
