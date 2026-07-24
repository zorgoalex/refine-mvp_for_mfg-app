# Функциональные разделы ERP

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
после команды доска перечитывается. Для производственного автостатуса ручной
перенос требует подтверждения и отключает расчёт по деталям.

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
2. OCR worker на CPU анализирует скриншот и объединяет результат с G-code
   parser. G-code используется только для размеров деталей и фрез.
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
profile `cnc-telegram`. В этот же profile входят `glm-ocr-model-init`
(скачивает GGUF и mmproj в Docker volume), `glm-ocr-llama` (official
`ghcr.io/ggml-org/llama.cpp:server` с local model files) и `glm-ocr-runner`
(internal structured `/ocr`).
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

Если prod использует старый live `docker-compose.yml`, `ops/deploy-stack.sh`
добавит tracked overlay `ops/templates/docker-compose.cnc-telegram-worker.yml`
при включённом `COMPOSE_PROFILES=cnc-telegram`.

Default worker OCR command уже вызывает internal runner:

```env
CNC_OCR_COMMAND=python -m cnc_telegram_worker.glm_ocr_client --image {image}
GLM_OCR_RUNNER_URL=http://glm-ocr-runner:8001/ocr
GLM_OCR_MODEL_FILE=GLM-OCR-Q8_0.gguf
GLM_OCR_MMPROJ_FILE=mmproj-GLM-OCR-Q8_0.gguf
```

Primary OCR для CPU-VPS: GLM-OCR 0.9B Q8 через `llama.cpp`. Он тяжелее
классических OCR, но лучше переносит реальные скриншоты раскроя и подходит для
фоновой очереди. PaddleOCR можно держать быстрым fallback, Tesseract — только
последним резервом. Решение OCR остаётся вне ERP backend: backend доверяет
только нормализованному packet contract и помечает сомнительные строки
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
`https://mebelkz.bitrix24.kz/` в переиспользуемой вкладке браузера. При наличии
Bitrix24 cookie портал открывается сразу, иначе показывает собственный login.

```env
VITE_BITRIX24_URL=https://mebelkz.bitrix24.kz/
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
BITRIX24_WEBHOOK_URL=https://mebelkz.bitrix24.kz/rest/...
BITRIX24_PAY_SYSTEM_ID=<numeric-id>
BITRIX24_CURRENCY_ID=KZT
BITRIX24_ASSIGNED_BY_ID=<optional-user-id>
BITRIX24_REQUEST_TIMEOUT_MS=<less-than-lease>
```

Webhook создаёт администратор с правами CRM и
интернет-магазина/оплат. `BITRIX24_REQUEST_TIMEOUT_MS` обязан быть меньше
`BACKEND_BITRIX24_SYNC_LEASE_MS`.

Первичный backfill:

```bash
cd backend
npm run crm-sync:backfill -- --dry-run
npm run crm-sync:backfill
```

Повторный запуск идемпотентен. Каждое событие ERP заново проецирует актуальные
данные клиента, заказа, итоговой товарной строки и оплаты. Ручные изменения
этих полей в Bitrix24 заменяются. Стадию сделки ERP не передаёт и не меняет.

Удалённый заказ сначала удаляет связанные оплаты, затем Deal. Contact/Company
удаляется, только когда у клиента не осталось ERP-заказов. CRM API помещает
Contact/Company/Deal в корзину Bitrix24; администратор должен отключить корзину
для этих типов либо регулярно очищать её вручную.

Read-only canary:

```bash
BITRIX24_WEBHOOK_URL='https://mebelkz.bitrix24.kz/rest/…/…' \
BITRIX24_PAY_SYSTEM_ID='<id>' \
npm run test:e2e:bitrix24-sync-stage-canary
```

Canary не создаёт записей. Полный webhook URL — secret и не должен попадать во
frontend, git или логи.

Безопасный rollout:

1. включить `BACKEND_ENABLE_BITRIX24_SYNC=true`;
2. оставить `BACKEND_BITRIX24_SYNC_RELAY_OWNER=external`;
3. пройти canary;
4. выполнить `--dry-run`;
5. выполнить live backfill;
6. переключить ровно один backend на
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
нет. В режиме производственного статуса от деталей order-level действие
пропускается и пишет причину в audit.

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
