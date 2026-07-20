# Функциональные разделы ERP

## Доски статусов заказов

Пункт «Доски статусов» открывает `/order-status-board`. Доступны две
независимые вкладки:

- «Статусы заказов»;
- «Производство».

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
