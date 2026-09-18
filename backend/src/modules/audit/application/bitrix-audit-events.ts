/** Integration ownership only. Never infer it from actors, mappings or free text. */
export const BITRIX_AUDIT_SOURCES = [
  'crm-sync',
  'bitrix24',
  'backend-bitrix24',
  'bitrix24-widget',
  'bitrix24-widget-install',
];
export const BITRIX_AUDIT_PREFIXES = [
  'crm_sync.',
  'bitrix24_reverse.',
  'bitrix24.',
];
export const BITRIX_RECONCILE_EVENTS = [
  'bitrix24_reverse.request_payments_reconcile',
  'bitrix24_reverse.order_payments_reconcile',
];
export type BitrixDirection =
  | 'forward'
  | 'reverse'
  | 'widget'
  | 'settings'
  | 'other';
export type BitrixOutcome =
  | 'success'
  | 'error'
  | 'conflict'
  | 'started'
  | 'skipped'
  | 'unknown';
export type BitrixCategory =
  | 'client'
  | 'order'
  | 'payment'
  | 'settings'
  | 'processing'
  | 'other';
export interface BitrixEventDefinition {
  event: string;
  label: string;
  direction: BitrixDirection;
  category: BitrixCategory;
  outcome: BitrixOutcome;
}
const definition = (
  event: string,
  label: string,
  direction: BitrixDirection,
  category: BitrixCategory,
  outcome: BitrixOutcome
): BitrixEventDefinition => ({ event, label, direction, category, outcome });
export const BITRIX_EVENT_CATALOG: BitrixEventDefinition[] = [
  definition(
    'crm_sync.upsert',
    'Синхронизирована запись ERP → Bitrix',
    'forward',
    'other',
    'success'
  ),
  definition(
    'crm_sync.delete',
    'Удалена запись ERP → Bitrix',
    'forward',
    'other',
    'success'
  ),
  definition(
    'crm_sync.failed',
    'Ошибка отправки ERP → Bitrix',
    'forward',
    'processing',
    'error'
  ),
  definition(
    'crm_sync.remote_deleted_skipped',
    'Пропущена удалённая запись Bitrix',
    'forward',
    'other',
    'skipped'
  ),
  definition(
    'bitrix24_reverse.client_upsert',
    'Клиент получен из Bitrix',
    'reverse',
    'client',
    'success'
  ),
  definition(
    'bitrix24_reverse.client_archive',
    'Клиент Bitrix архивирован',
    'reverse',
    'client',
    'success'
  ),
  definition(
    'bitrix24_reverse.deal_state_upsert',
    'Обновлено состояние сделки',
    'reverse',
    'order',
    'success'
  ),
  definition(
    'bitrix24_reverse.incoming_request_upsert',
    'Обновлена CRM-заявка',
    'reverse',
    'order',
    'success'
  ),
  definition(
    'orders.crm_request_created',
    'Создана CRM-заявка',
    'reverse',
    'order',
    'success'
  ),
  definition(
    'orders.crm_request_updated',
    'Изменена CRM-заявка',
    'reverse',
    'order',
    'success'
  ),
  definition(
    'orders.crm_request_archived',
    'Архивирована CRM-заявка',
    'reverse',
    'order',
    'success'
  ),
  definition(
    'orders.crm_request_restored',
    'Восстановлена CRM-заявка',
    'reverse',
    'order',
    'success'
  ),
  definition(
    'orders.crm_request_sync_conflict',
    'Конфликт CRM-заявки',
    'reverse',
    'order',
    'conflict'
  ),
  definition(
    'orders.converted_to_production',
    'Заявка преобразована в заказ',
    'reverse',
    'order',
    'success'
  ),
  definition(
    'project.created',
    'Создан проект из CRM-заявки',
    'reverse',
    'order',
    'success'
  ),
  definition(
    'bitrix24_reverse.request_payments_reconcile',
    'Сверка платежей заявки',
    'reverse',
    'payment',
    'success'
  ),
  definition(
    'bitrix24_reverse.order_payments_reconcile',
    'Сверка платежей заказа',
    'reverse',
    'payment',
    'success'
  ),
  definition(
    'bitrix24_reverse.payments_materialize',
    'Платежи заявки перенесены в ERP',
    'reverse',
    'payment',
    'success'
  ),
  definition(
    'bitrix24_reverse.mapped_order_payments_materialize',
    'Платежи заказа перенесены в ERP',
    'reverse',
    'payment',
    'success'
  ),
  definition(
    'bitrix24_reverse.event_failed',
    'Ошибка обратной обработки; запланирован повтор',
    'reverse',
    'processing',
    'error'
  ),
  definition(
    'bitrix24_reverse.event_dead',
    'Обратная обработка остановлена после ошибок',
    'reverse',
    'processing',
    'error'
  ),
  definition(
    'bitrix24_reverse.retry_failed',
    'Запущен повтор ошибочных заданий',
    'settings',
    'processing',
    'started'
  ),
  definition(
    'bitrix24_reverse.installation_saved',
    'Сохранена установка приложения',
    'settings',
    'settings',
    'success'
  ),
  definition(
    'bitrix24.widget.installation_promoted',
    'Активирован виджет',
    'settings',
    'settings',
    'success'
  ),
  definition(
    'bitrix24.user_mapping_upserted',
    'Сохранено сопоставление пользователя',
    'settings',
    'settings',
    'success'
  ),
  definition(
    'bitrix24_reverse.payment_type_mapping_upsert',
    'Сохранено сопоставление оплаты',
    'settings',
    'settings',
    'success'
  ),
  definition(
    'bitrix24.payment_system_catalog_refreshed',
    'Обновлены платёжные системы',
    'settings',
    'settings',
    'success'
  ),
  definition(
    'bitrix24.widget_payment.command_started',
    'Начата оплата через виджет',
    'widget',
    'payment',
    'started'
  ),
  definition(
    'bitrix24.widget_payment.remote_created',
    'Платёж создан в Bitrix',
    'widget',
    'payment',
    'success'
  ),
  definition(
    'bitrix24.widget_payment.materialized',
    'Платёж виджета перенесён в ERP',
    'widget',
    'payment',
    'success'
  ),
  definition(
    'bitrix24.widget_payment.failed',
    'Ошибка платежа виджета',
    'widget',
    'payment',
    'error'
  ),
  definition(
    'bitrix24.widget_payment.awaiting_order',
    'Платёж ожидает готовности заказа',
    'widget',
    'payment',
    'started'
  ),
  definition(
    'bitrix24.widget_payment.awaiting_overpayment_confirmation',
    'Платёж ожидает подтверждения переплаты',
    'widget',
    'payment',
    'started'
  ),
  definition(
    'bitrix24.widget_payment.ambiguity_resolved',
    'Разрешена неоднозначность платежа',
    'widget',
    'payment',
    'success'
  ),
];

export function isBitrixAuditEvent(
  event: string | null,
  source: string | null
): boolean {
  return (
    BITRIX_AUDIT_SOURCES.includes(source ?? '') ||
    BITRIX_AUDIT_PREFIXES.some((prefix) => (event ?? '').startsWith(prefix))
  );
}

// Constants only, not user input. starts_with treats underscores literally; NULL is false.
export const BITRIX_AUDIT_PREDICATE = `(COALESCE(audit_log.source IN (${BITRIX_AUDIT_SOURCES.map(
  (s) => `'${s}'`
).join(',')}), false) OR ${BITRIX_AUDIT_PREFIXES.map(
  (p) => `starts_with(COALESCE(audit_log.event, ''), '${p}')`
).join(' OR ')})`;

export function bitrixEventDefinition(
  event: string,
  entityType?: string | null
): BitrixEventDefinition {
  const found = BITRIX_EVENT_CATALOG.find((item) => item.event === event);
  const result =
    found ??
    definition(
      event,
      event,
      event.startsWith('crm_sync.')
        ? 'forward'
        : event.startsWith('bitrix24_reverse.')
        ? 'reverse'
        : 'other',
      'other',
      'unknown'
    );
  return event.startsWith('crm_sync.') &&
    ['client', 'order', 'payment'].includes(entityType ?? '')
    ? { ...result, category: entityType as 'client' | 'order' | 'payment' }
    : result;
}

/** Same catalog drives SQL filtering and API presentation; unknowns remain visible. */
export function bitrixClassificationSql(
  field: 'direction' | 'category' | 'outcome'
): string {
  const cases = BITRIX_EVENT_CATALOG.map(
    (item) => `WHEN audit_log.event='${item.event}' THEN '${item[field]}'`
  ).join(' ');
  const fallback =
    field === 'direction'
      ? `CASE WHEN starts_with(audit_log.event,'crm_sync.') THEN 'forward' WHEN starts_with(audit_log.event,'bitrix24_reverse.') THEN 'reverse' ELSE 'other' END`
      : `'${field === 'outcome' ? 'unknown' : 'other'}'`;
  const entityCategory =
    field === 'category'
      ? `WHEN starts_with(audit_log.event,'crm_sync.') AND audit_log.entity_type IN ('client','order','payment') THEN audit_log.entity_type `
      : '';
  return `(CASE ${entityCategory}${cases} ELSE ${fallback} END)`;
}
