# Канал уведомлений WhatsApp

Короткие текстовые сообщения WhatsApp, которые модули backend ставят сами (первый потребитель — оповещения 1С).
Код: `src/modules/whatsapp/notifications/`, миграция `261_whatsapp_notification_deliveries.sql`.

## Порт

`WhatsAppModule` экспортирует `WhatsAppNotificationPort`. Модуль-потребитель импортирует `WhatsAppModule`
(модуль WhatsApp сам никогда не импортирует модули потребителей).

```ts
port.enqueue(tx, {
  idempotencyKey, recipient: { userId } | { chatId }, title?, text, level: 'info' | 'warning' | 'error',
  sourceType, sourceId?, correlationId?, notBefore?, expiresAt?, requiredPermission?,
}) // → { deliveryId, created, state, reason }
port.cancel(tx, { deliveryId } | { idempotencyKey }) // → { deliveryId, state, cancelled } | null
port.statuses(client, deliveryIds) // → [{ deliveryId, state, reason, sentAt, updatedAt }]
```

- `enqueue` и `cancel` выполняются в транзакции потребителя. До вызова не держать на запись `permissions_state`,
  `users`, `roles`, `employees`, `employee_work_contacts`.
- Получатель-пользователь — его основной рабочий WhatsApp-номер (контакты сотрудника, `users.employee_id`);
  группа — идентификатор из `GET /api/v1/whatsapp/groups`.
- Сообщение — `*title*` и текст, всего не больше 4096 символов. Срок жизни по умолчанию 2 часа от `notBefore`,
  не больше 7 дней.
- Повтор ключа возвращает ту же доставку всегда (строки не удаляются). Другое сообщение под тем же ключом —
  `409 WHATSAPP_NOTIFICATION_KEY_REUSED`.

## Состояния

`queued` → `sending` → `sent` | `failed` | `unknown`; также `cancelled` и `skipped`.

- `skipped` (сразу при постановке): `WHATSAPP_DISABLED` (WhatsApp или relay выключены — так на stage),
  `USER_INACTIVE`, `PERMISSION_MISSING`, `NO_WORK_PHONE`.
- `cancelled`: `cancelled_by_source`, `expired`, `delivery_gap` (поставлено до последнего запуска backend),
  `permission_revoked`, `recipient_changed`, `recipient_removed`.
- `failed`: `EMPLOYEE_NOT_ON_WHATSAPP`, `CHAT_NOT_FOUND`, `WAHA_REJECTED`.
- `unknown` не повторяется (отправка не больше одного раза).

## Доставка

Worker раз в 15 секунд отправляет одно сообщение (сначала `error`, потом `warning`, потом `info`). Ограничения:
одно сообщение уведомлений в 10 секунд и не больше 20 в час одному получателю; эти лимиты независимы от отправок
заказа и рассылок. Перед отправкой снова проверяются пользователь, право и номер. «Остановить все рассылки»
задерживает и уведомления.

Каждый запуск backend начинает новое поколение доставки. Всё, что осталось в очереди от прежнего поколения,
отменяется (`delivery_gap`), и после перезапуска или отката старые сообщения не уходят. Потребитель решает сам,
ставить ли сообщение заново.

Через 30 дней после завершения текст и адрес стираются; строка с ключом и состоянием остаётся. Аудит
(`whatsapp.notification.*`) пишется без текста и номеров.

## Выкладка и откат

Миграция 261 (только новые таблицы) → backend. Откат — прежний образ backend; миграцию не откатывать.
