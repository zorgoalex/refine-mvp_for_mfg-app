# Функциональные разделы ERP

## Подбор деталей для Базис-раскроя

На `/bazis-cut` пользователь с `cut.manage` может открыть форму «Подобрать
детали». Сначала обязателен период дат заказов; без него остальные фильтры и
поиск не работают. Период включительный и ограничен 366 календарными днями.

После выбора периода backend возвращает scoped динамические списки для номера
заказа, клиента, материала, фрезеровки, Базис-проекта/Базис-заказа,
конструктора и присадки. Таблица показывает 25 позиций на страницу, сохраняет
выбор между страницами и считает количество и площадь для всего результата и
выбранных строк. Выбранные строки можно убрать из результата и вернуть до
создания набора.

Read API:

- `GET /api/v1/bazis-cut-sets/picker/facets?dateFrom=&dateTo=`;
- `POST /api/v1/bazis-cut-sets/picker/search`;
- `GET /api/v1/bazis-cut-sets/order-memberships?orderId=` для совместимости
  карточки заказа с legacy Hasura read mode.

Команда `POST /api/v1/bazis-cut-sets/from-picker` принимает
`Idempotency-Key`, нормализованные критерии, их SHA-256 и максимум 500 пар
`detailId + selectionToken`. Backend повторно применяет order scope, блокирует
заказы и детали в стабильном порядке, пересчитывает stale-токены и создаёт
снимки только одной транзакцией. Событие `bazis_cut_set.created`, audit dimensions
и идемпотентный outbox записываются до завершения idempotency. Деталь может
состоять в нескольких наборах; все связи отображаются как `БР-<номер>`.

## Доски статусов заказов

Пункт «Доски статусов» открывает `/order-status-board`. Базово доступны две
независимые вкладки:

- «Статусы заказов»;
- «Производство».

При включённом CNC Telegram появляется третья визуальная вкладка «Работы
сегодня». Она не расширяет контракт обычной status-board API и читает отдельный
read-model CNC.

Отдельной payment-board нет. Payment status отображается в карточке только при
`orders.view_financials`.

Read projection: `GET /api/v1/orders/status-board`. Начальная загрузка получает
ограниченную страницу каждой колонки; догрузка использует opaque keyset cursor,
привязанный к board type, column и filters. Backend применяет RBAC/scope и
маскирует финансовые поля.

Перенос использует существующие идемпотентные команды смены общего или
производственного статуса с optimistic version. UI не делает optimistic move:
после команды доска перечитывается. Карточки перемещаются перетаскиванием
мышью/touch или через контекстное меню по правому клику на любой области
карточки. Ручной перенос не показывает отдельное предупреждение или окно
подтверждения.

Производственный статус заказа всегда выводится из активных деталей: берётся
статус самой отстающей детали по `production_statuses.sort_order`. Ручная смена
производственного статуса заказа принудительно ставит этот статус всем активным
деталям заказа, но не отключает дальнейший пересчёт от деталей. Если позже одна
деталь откатывается на более ранний статус, статус заказа тоже возвращается к
этому раннему статусу.

Включение:

```env
VITE_ORDER_STATUS_BOARD=true
# либо runtime
RUNTIME_CONFIG_ORDER_STATUS_BOARD=true
```

Эффективный флаг требует backend orders read. Запись дополнительно требует
`useBackendProductionActions`; иначе доска read-only.

## CNC Telegram: работы сегодня

Поток «Работы сегодня» показывает листы раскроя, полученные из рабочего
Telegram-чата за выбранный рабочий день: лист, станок, программу, материал, фрезы,
комментарии, найденные заказы/детали, предупреждения разбора и признак
выполнения по реакции «палец вверх».

Data flow:

1. `cnc-telegram-worker` на Telethon читает новые сообщения, history за неделю,
   файлы G-code, подписи/комментарии и
   реакции в чате.
2. Worker разбирает валидный SVG и объединяет его с G-code parser. G-code
   используется только для размеров деталей и фрез. OCR screenshot cross-check
   выполняется только в явно включённом GLM fallback.
3. Backend получает только структурированный JSON через
   `POST /api/v1/cnc-telegram/ingest`.
4. UI читает выбранный день через `GET /api/v1/cnc-telegram/today?date=YYYY-MM-DD`.

Backend intentionally raw-free: скриншоты, G-code файлы и полный raw text не
передаются в ERP API и не сохраняются в БД. Временное хранилище бота/воркера
должно hard-delete файлы старше 24 часов; при необходимости любой файл можно
повторно получить из Telegram-чата.

Для проверки и разборов UI даёт перейти по датам за последнюю неделю. Worker
должен поддерживать backfill по Telegram history за тот же диапазон и отправлять
структурированные packets с тем же `externalPacketKey`/`source.version`, чтобы
повторный проход был идемпотентным.

Prod worker находится в `cnc-telegram-worker/` и запускается Docker Compose
profile `cnc-telegram`. Обычный режим разбирает валидный SVG без OCR. GLM model
init, llama server и runner вынесены в отдельный opt-in profile
`cnc-telegram-glm` и в обычном режиме не запускаются и не вызываются.
В `.env` prod нужно включить:

```env
BACKEND_ENABLE_CNC_TELEGRAM=true
COMPOSE_PROFILES=cnc-telegram
TELEGRAM_API_ID=<api-id>
TELEGRAM_API_HASH=<api-hash>
TELEGRAM_CHAT=<chat-id-or-username>
TELEGRAM_ALLOWED_CHAT_ID=<expected-chat-id>
ERP_WORKER_LOGIN=<erp-user-with-cut.manage>
ERP_WORKER_PASSWORD=<password>
```

Первый запуск Telethon session:

```bash
repo_erp/ops/cnc-telegram-worker.sh login
```

Историческая проверка:

```bash
repo_erp/ops/cnc-telegram-worker.sh backfill 7
```

При `COMPOSE_PROFILES=cnc-telegram` `ops/deploy-stack.sh` всегда добавляет
tracked overlay `ops/templates/docker-compose.cnc-telegram-worker.yml`. Его
profile overrides сохраняют GLM opt-in даже со старым live Compose.

Legacy/default OCR command остаётся в env для совместимости, но при
`CNC_ENABLE_GLM_OCR=false` worker его не выполняет:

```env
CNC_OCR_COMMAND="python -m cnc_telegram_worker.rapid_ocr_client --image {image}"
CNC_RAPID_OCR_URL=http://ocr-service:8000/ocr
```

GLM-OCR 0.9B Q8 через `llama.cpp` сохранён как аварийный fallback:

```bash
repo_erp/ops/cnc-telegram-worker.sh up-glm
```

`up-glm` для этого запуска включает gate, профиль, GLM command и GLM engine.
Outer command timeout при этом автоматически ставится на 60 секунд больше
`GLM_OCR_CLIENT_TIMEOUT_SECONDS`, чтобы штатный CPU inference не был оборван.
Обычный `up` возвращает SVG-only режим и останавливает GLM containers, не
удаляя скачанный model volume. Решение OCR остаётся вне ERP backend: backend
доверяет только нормализованному packet contract и помечает сомнительные строки
`needs_review`.

Backend semantics:

- `externalPacketKey` уникален для сообщения/листа;
- `source.version` монотонно защищает от старых Telegram replay;
- тот же source version с другим payload hash возвращает конфликт;
- `Idempotency-Key` приходит только из HTTP header и не входит в structured
  packet body;
- today-read без явного `date` берёт `CURRENT_DATE` из PostgreSQL, чтобы
  совпадать с business timezone backend-контура;
- packet хранит отдельные `parseStatus` и `completionStatus`;
- matched detail rows требуют согласованную пару `matchOrderId` +
  `matchDetailId`;
- ingest пишет audit/outbox в одной транзакции с upsert;
- denied ingest логируется отдельно.

Автостатус распила настраивается во вкладке «Конфигурация → Автостатусы».
Включение переключателя вызывает идемпотентную backend-команду
`POST /api/v1/cnc-telegram/auto-cut-status` с правом
`status_automation.manage`. В одной транзакции команда:

- сохраняет `status_automation.cnc_mark_cut_details`;
- обрабатывает все существующие packets со статусом `completed` или реакцией
  «палец вверх», независимо от выбранного в доске периода;
- ставит деталям статус «Распилен» только после достижения их суммарного
  количества во всех завершённых карточках;
- для комментария «весь заказ» обрабатывает все детали указанного заказа;
- не понижает детали с более поздним производственным статусом;
- пишет audit и outbox и возвращает счётчики изменённых деталей и заказов.

Настройка и завершение новых карточек используют общий advisory lock, поэтому
карточка, завершённая одновременно с включением, не пропускается. Повтор команды
с новым `Idempotency-Key` безопасен: уже обработанные детали не переписываются.
После выкладки на prod бэкфилл запускается обычным включением этого
переключателя; отдельный SQL или ручная правка БД не нужны.

Включение:

```env
BACKEND_ENABLE_CNC_TELEGRAM=true
COMPOSE_PROFILES=cnc-telegram
VITE_ORDER_STATUS_BOARD=true
VITE_USE_BACKEND_ORDERS_READ=true
VITE_USE_BACKEND_CNC_TELEGRAM=true
# либо runtime cncTelegram=true
```

## Переход в Битрикс24

Пункт «Битрикс24» открывает портал
`https://bitrix24.example.com/` в переиспользуемой вкладке браузера. При наличии
Bitrix24 cookie портал открывается сразу, иначе показывает собственный login.

```env
VITE_BITRIX24_URL=https://bitrix24.example.com/
VITE_BITRIX24_LABEL=Битрикс24
```

Пустой URL скрывает пункт. Устаревшие `VITE_CRM_URL`, `VITE_CRM_PATH` и
`VITE_CRM_LABEL` им не управляют.

REST webhook и OAuth дают API access, но не создают browser session. Вход без
отдельной Bitrix-сессии требует корпоративного SSO на стороне Битрикс24 и
общего identity provider. Client secret, webhook URL и OAuth tokens нельзя
помещать во frontend.

## Bitrix24 CRM sync

Backend поддерживает одностороннюю проекцию ERP→Bitrix24:

- клиент-физлицо → Contact;
- клиент-юрлицо → Company;
- заказ → Deal с итоговой суммой, ссылкой на ERP и одной итоговой товарной
  строкой;
- каждая оплата ERP → нативная оплата сделки.

Синхронизация fail-closed и по умолчанию выключена. Для включения нужны:

```env
BACKEND_ENABLE_BITRIX24_SYNC=true
BITRIX24_WEBHOOK_URL=https://bitrix24.example.com/rest/...
BITRIX24_PAY_SYSTEM_ID=<numeric-id>
BITRIX24_CURRENCY_ID=KZT
BITRIX24_ASSIGNED_BY_ID=<optional-user-id>
BITRIX24_REQUEST_TIMEOUT_MS=<less-than-lease>
BITRIX24_MAX_REQUESTS_PER_SECOND=2
BITRIX24_LIMIT_RETRY_MAX_ATTEMPTS=11
BITRIX24_QUERY_LIMIT_BASE_DELAY_MS=1000
BITRIX24_OPERATION_LIMIT_FALLBACK_MS=60000
```

Webhook создаёт администратор с правами CRM и
интернет-магазина/оплат. `BITRIX24_REQUEST_TIMEOUT_MS` обязан быть меньше
`BACKEND_BITRIX24_SYNC_LEASE_MS`. Значение `2` соответствует стандартному
облачному лимиту Bitrix24; `5` разрешено ставить только после подтверждения
Enterprise-тарифа.

Первичный backfill:

```bash
cd backend
npm run crm-sync:backfill -- --dry-run --scope clients
npm run crm-sync:backfill -- --scope clients
npm run crm-sync:backfill -- --dry-run --scope all
npm run crm-sync:backfill -- --scope all
```

`--scope` обязателен: команда никогда не выбирает `all` молча. Live-запуск
сохраняет курсор в PostgreSQL вместе с mapping/audit и после ошибки или
SIGINT/SIGTERM продолжает с последней подтверждённой записи. Завершённый scope
ничего не повторяет; для нового полного прохода нужен явный `--restart`.
`--dry-run` не читает и не изменяет checkpoint.

Повторный запуск безопасен. Каждое событие ERP заново проецирует актуальные
данные клиента, заказа, итоговой товарной строки и оплаты. Ручные изменения
этих полей в Bitrix24 заменяются. Стадию сделки ERP не передаёт и не меняет.

Удалённый заказ сначала удаляет связанные оплаты, затем Deal. Contact/Company
удаляется, только когда у клиента не осталось ERP-заказов. CRM API помещает
Contact/Company/Deal в корзину Bitrix24; администратор должен отключить корзину
для этих типов либо регулярно очищать её вручную.

Read-only canary:

```bash
BITRIX24_WEBHOOK_URL='https://bitrix24.example.com/rest/…/…' \
BITRIX24_PAY_SYSTEM_ID='<id>' \
npm run test:e2e:bitrix24-sync-stage-canary
```

Canary не создаёт записей. Полный webhook URL — secret и не должен попадать во
frontend, git или логи.

Безопасный rollout:

1. включить `BACKEND_ENABLE_BITRIX24_SYNC=true`;
2. оставить `BACKEND_BITRIX24_SYNC_RELAY_OWNER=external`;
3. пройти canary;
4. выполнить `--dry-run --scope clients`;
5. выполнить live `--scope clients`;
6. после проверки выполнить dry/live `--scope all`;
7. переключить ровно один backend на
   `BACKEND_BITRIX24_SYNC_RELAY_OWNER=in_process`.

## Корзина заказов

Удаление заказа мягкое. Кнопка «Удалить» переносит заказ в `/orders/trash`.
Корзина показывает номер, клиента, сумму, дату заказа, дату удаления и actor;
поддерживается поиск.

Если номер восстанавливаемого заказа уже занят, backend возвращает 409 с
предложенным свободным номером; UI предлагает «Восстановить как N». Карточка
удалённого заказа read-only.

Требуемое право: `orders.delete`.

Backend routes:

- `GET /api/v1/orders?deleted=true`;
- `GET /api/v1/orders/:id?includeDeleted=true`;
- `POST /api/v1/orders/:id/restore`;
- `DELETE /api/v1/orders/:id`.

Write commands используют `If-Match`, `Idempotency-Key`, audit и idempotent
outbox (`order.deleted`, `order.restored`).

Миграция:
`backend/db/migrations/065_order_soft_delete_metadata.sql`.

## Автостатусы

Вкладка «Автостатусы» на `/configuration` позволяет задать правило
«событие → условия → целевой статус».

Права:

- `status_automation.view`;
- `status_automation.manage`.

События:

- `order.created`;
- `payment.created`;
- `order.payment_status_changed`;
- `order.status_changed`;
- `order.production_status_changed`.

Условия: текущие статусы, `paidShareGte`, источник заказа
`manual|bazis|import`, `firstPaymentOnly`.

Действия:

- `change_order_status`;
- `change_production_status`;
- `change_details_production_status`.

При нескольких совпавших правилах на один target применяется правило с
минимальным `priority`. Правило исполняется внутри транзакции source-command.
Audit (`status_automation.rule_applied`, `rule_skipped`) и outbox пишутся
атомарно. `origin='automation'` не запускает новое правило, поэтому каскадов
нет. `change_production_status` материализует статус во всех активных деталях;
последующие изменения деталей снова пересчитывают статус заказа.

REST:

- `GET/POST /api/v1/status-automation/rules`;
- `PATCH/DELETE /api/v1/status-automation/rules/:ruleId`;
- `GET /api/v1/status-automation/event-types`.

CRUD доступен даже при выключенном engine.

Включение:

```env
BACKEND_STATUS_AUTOMATION=true
VITE_STATUS_AUTOMATION=true
# либо runtime statusAutomation=true
```

Миграция:
`backend/db/migrations/066_status_automation_rules.sql`.

## Шаблоны бирок

Редактор находится в разделе конфигурации и требует
`labels.manage_templates`. Канвас использует миллиметры: сетка и границы
элементов включены при открытии, размеры показываются во время изменения и в
контекстном меню.

Текстовые элементы поддерживают размер шрифта в pt, жирность, курсив и
versioned `if/else`. Условие проверяет поле ERP/Базис и для каждой ветки может
оставить текущее значение, подставить другое поле, вывести фиксированный текст
или скрыть элемент.

Shift+ЛКМ добавляет элементы к выделению. Контекстное меню позволяет
сгруппировать их, двигать/масштабировать/вращать как один объект,
разгруппировать и центрировать по горизонтальной или вертикальной оси канваса.
Группа и ручные размеры сохраняются вместе с шаблоном. При близкой высоте
текстов одной строки редактор предлагает выровнять её по соседнему полю.

Переключатель «Структура / Пример с данными» даёт дополнительный безопасный
визуал с детерминированными тестовыми значениями и не меняет payload шаблона.
Превью готовых бирок в карточках заказа обведены нейтральной серой рамкой.

Пользовательское поле может брать постоянное значение, одно поле ERP/Базис
или вычисляться формулой. Визуальный редактор формулы поддерживает поля,
фиксированный текст, конкатенацию, пропуск и вложенные цепочки `IF/ELSE`;
ветви могут ссылаться на другие пользовательские поля. Ручное значение детали
имеет высший приоритет и используется зависимыми формулами. Циклические ссылки,
неизвестные версии и превышение лимитов блокируются до генерации. Режим формул
появляется только после capability handshake
`GET /api/v1/label-templates/renderer-capabilities` с
`custom_expression_v1`.

## Раскрой

`/cut` показывает задания раскроя. Ready-job содержит SVG/PDF листы. Backend:
`/api/v1/cut-jobs`.

Движок выбирается автоматически:

- крупные группы — heuristic с максимальной доупаковкой;
- небольшие — genetic;
- threshold задаёт `BACKEND_CUT_HEURISTIC_AUTO_THRESHOLD`;
- `0` отключает автоматический heuristic;
- профиль может принудительно выбрать heuristic либо genetic.

Фактический engine сохраняется в summary группы.

### Ручной редактор

Пользователь с `cut.manage` может:

- открыть ready-job;
- перемещать детали между листами;
- поворачивать детали;
- сохранить manual variant;
- сравнить auto и manual;
- выбрать active variant для печати.

Сохранение manual layout отделено от исходных данных заказа и пишет audit +
outbox.

Render/PDF endpoints принимают `variant`:

| Значение | Результат |
|---|---|
| `auto` | автоматический вариант |
| `manual` | сохранённый ручной вариант |
| `active` | текущий активный вариант |

Frontend печатает с `variant=active`.

Legacy jobs без `editorParams` требуют однократного пересчёта. После него
редактор доступен без потери исходных деталей.
