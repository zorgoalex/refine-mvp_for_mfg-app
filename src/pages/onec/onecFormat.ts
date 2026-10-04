/**
 * Pure formatting/label/diff helpers for the "Интеграция 1С" admin screens.
 * Kept free of React/antd/network so they run under Vitest (environment=node)
 * without a DOM.
 */
import type {
  OnecAgentConfiguration,
  OnecAgentMode,
  OnecCommandRequestedBy,
  OnecCommandStatus,
  OnecConnectionState,
  OnecEtlBatchStatus,
  OnecEtlCompleteness,
  OnecEtlEntity,
  OnecEtlLastStatus,
  OnecEtlReadScope,
  OnecEtlRunMode,
  OnecEtlRunStatus,
  OnecHeartbeatState,
  OnecPublishedAgentConfiguration,
  OnecSourceIdentityStatus,
  OnecStatusHistorySummary,
} from './onecApi.types';

export type OnecBadgeStatus = 'success' | 'processing' | 'warning' | 'error' | 'default';

export interface OnecBadge {
  status: OnecBadgeStatus;
  text: string;
}

export const ONEC_MODE_LABELS: Record<OnecAgentMode, string> = {
  Normal: 'Работа',
  PauseEtl: 'Пауза выгрузки',
  PauseCommands: 'Пауза команд',
  Drain: 'Завершение текущих',
  Maintenance: 'Обслуживание',
  Disabled: 'Отключён',
};

export function onecModeLabel(mode: OnecAgentMode | string): string {
  return (ONEC_MODE_LABELS as Record<string, string>)[mode] ?? mode;
}

export const ONEC_CONNECTION_LABELS: Record<OnecConnectionState, string> = {
  online: 'В сети',
  silent: 'Молчит',
  never_seen: 'Не подключался',
};

export function onecConnectionBadge(connection: OnecConnectionState): OnecBadge {
  switch (connection) {
    case 'online':
      return { status: 'success', text: ONEC_CONNECTION_LABELS.online };
    case 'silent':
      return { status: 'warning', text: ONEC_CONNECTION_LABELS.silent };
    case 'never_seen':
    default:
      return { status: 'default', text: ONEC_CONNECTION_LABELS.never_seen };
  }
}

export const ONEC_STATE_LABELS: Record<OnecHeartbeatState, string> = {
  healthy: 'Норма',
  degraded: 'Деградация',
  offline_onec: '1С недоступна',
  storage_critical: 'Критично мало места',
  maintenance: 'Обслуживание',
  incompatible_version: 'Несовместимая версия',
};

export function onecStateBadge(state: OnecHeartbeatState | null): OnecBadge {
  if (!state) return { status: 'default', text: 'Нет данных' };
  switch (state) {
    case 'healthy':
      return { status: 'success', text: ONEC_STATE_LABELS.healthy };
    case 'degraded':
      return { status: 'warning', text: ONEC_STATE_LABELS.degraded };
    case 'offline_onec':
    case 'storage_critical':
    case 'incompatible_version':
      return { status: 'error', text: ONEC_STATE_LABELS[state] };
    case 'maintenance':
      return { status: 'processing', text: ONEC_STATE_LABELS.maintenance };
    default:
      return { status: 'default', text: state };
  }
}

export const ONEC_IDENTITY_STATUS_LABELS: Record<OnecSourceIdentityStatus, string> = {
  unverified: 'Не подтверждена',
  bound: 'Привязана',
  identity_changed: 'База сменилась',
};

/** Non-null only for the identity_changed warning banner (spec: stop ETL until resolved). */
export function onecIdentityWarning(identityStatus: OnecSourceIdentityStatus): string | null {
  if (identityStatus !== 'identity_changed') return null;
  return 'База 1С сменилась — выгрузка остановлена до решения';
}

export const ONEC_ALERT_KIND_LABELS: Record<string, string> = {
  agent_silent: 'Агент молчит',
  agent_state: 'Состояние агента',
  certificate_expiring: 'Истекает сертификат',
  config_rejected: 'Агент отклонил конфигурацию',
  source_identity_changed: 'Сменилась база 1С',
  command_dead_letter: 'Команда не выполнена',
  command_expired_undelivered: 'Команда не доставлена в срок',
  etl_entity_failed: 'Ошибка выгрузки сущности',
  etl_run_abandoned: 'Выгрузка брошена',
  etl_full_sync_required: 'Нужна полная выгрузка',
  etl_snapshot_not_updated: 'Снимок не обновлён',
  warehouse_autosync_failed: 'Склады 1С не синхронизированы',
  onec_documents_load_failed: 'Документы 1С не загружены',
  onec_document_conflict: 'Документ 1С изменился — конфликт с распределениями',
  onec_nightly_full_sync_missed: 'Ночная полная выгрузка не прошла',
};

/** Alerts about one past command/run: nothing re-derives them, the operator closes them once handled. */
export const ONEC_OPERATOR_RESOLVABLE_ALERT_KINDS: readonly string[] = [
  'command_dead_letter',
  'command_expired_undelivered',
  'etl_run_abandoned',
  'etl_full_sync_required',
  'onec_nightly_full_sync_missed',
];

export function onecAlertResolvable(kind: string, state: string): boolean {
  return state !== 'resolved' && ONEC_OPERATOR_RESOLVABLE_ALERT_KINDS.includes(kind);
}

export function onecAlertKindLabel(kind: string): string {
  return ONEC_ALERT_KIND_LABELS[kind] ?? kind;
}

export const ONEC_INCIDENT_KIND_LABELS: Record<string, string> = {
  ingress_auth_failed: 'Ошибка аутентификации на входе',
  unknown_certificate: 'Неизвестный сертификат',
  agent_cert_mismatch: 'Несоответствие сертификата агента',
  source_identity_changed: 'Сменилась база 1С',
  command_hash_mismatch: 'Хеш команды не совпал',
  result_conflict: 'Другой результат команды',
  result_for_unknown_command: 'Результат неизвестной команды',
  result_for_cancelled_command: 'Отменённая команда всё же выполнена',
  late_delivery_of_expired_command: 'Просроченная команда всё же доставлена',
  etl_batch_invalid: 'Некорректный пакет выгрузки',
  late_mode_for_completed_run: 'Режим команды пришёл после завершения выгрузки',
  stale_snapshot_ignored: 'Пропущен устаревший снимок',
};

export function onecIncidentKindLabel(kind: string): string {
  return ONEC_INCIDENT_KIND_LABELS[kind] ?? kind;
}

export const ONEC_ALERT_SEVERITY_LABELS: Record<string, string> = {
  info: 'Инфо',
  warning: 'Предупреждение',
  critical: 'Критично',
};

export const ONEC_ALERT_STATE_LABELS: Record<string, string> = {
  open: 'Открыт',
  acknowledged: 'Подтверждён',
  resolved: 'Решён',
};

export const ONEC_COMMAND_TYPE_LABELS: Record<string, string> = {
  integration_probe: 'Проверка интеграции',
  create_customer_order: 'Создать заказ покупателя',
  update_customer_order: 'Обновить заказ покупателя',
  post_customer_order: 'Провести заказ покупателя',
  cancel_customer_order: 'Отменить заказ покупателя',
  create_material_movement: 'Создать перемещение материалов',
  create_material_receipt: 'Создать поступление материалов',
  create_material_writeoff: 'Создать списание материалов',
  create_payment_document: 'Создать платёжный документ',
  start_full_sync: 'Запустить полную выгрузку',
  reload_entity: 'Перезагрузить сущность',
  pause_etl: 'Приостановить выгрузку',
  resume_etl: 'Возобновить выгрузку',
  run_connectivity_test: 'Проверить связь',
  collect_diagnostics: 'Собрать диагностику',
  rotate_certificate_hint: 'Запросить смену сертификата',
};

export function onecCommandTypeLabel(type: string): string {
  return ONEC_COMMAND_TYPE_LABELS[type] ?? type;
}

/** One-line explanations shown next to the command type in the "Отправить команду" dialog. */
export const ONEC_COMMAND_TYPE_DESCRIPTIONS: Record<string, string> = {
  integration_probe:
    'Проверяет весь путь ERP → агент → расширение 1С без создания документов.',
  start_full_sync: 'Ставит агенту задачу выгрузить заново указанные сущности (или все включённые).',
  reload_entity: 'Ставит агенту задачу перезагрузить одну сущность выгрузки с нуля.',
  pause_etl: 'Приостанавливает периодическую выгрузку данных агентом.',
  resume_etl: 'Возобновляет ранее приостановленную выгрузку данных.',
  run_connectivity_test: 'Просит агента проверить соединение с 1С и сообщить результат.',
  collect_diagnostics: 'Просит агента собрать диагностическую информацию о своей работе.',
  rotate_certificate_hint: 'Сообщает агенту, что пора запросить смену клиентского сертификата.',
};

export function onecCommandTypeDescription(type: string): string {
  return ONEC_COMMAND_TYPE_DESCRIPTIONS[type] ?? '';
}

export const ONEC_COMMAND_STATUS_LABELS: Record<OnecCommandStatus, string> = {
  queued: 'В очереди',
  leased: 'Выдана агенту',
  received: 'Выполняется',
  succeeded: 'Успешно',
  business_error: 'Ошибка выполнения',
  dead_letter: 'Не выполнена',
  expired: 'Истёк срок',
  cancelled: 'Отменена',
  expired_undelivered: 'Истёк срок (не доставлена)',
};

export function onecCommandStatusLabel(status: string): string {
  return (ONEC_COMMAND_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/** Tag colors for the command journal (spec: queued/leased blue, received processing,
 * succeeded green, business_error orange, dead_letter red, expired* grey, cancelled default). */
export const ONEC_COMMAND_STATUS_COLORS: Record<OnecCommandStatus, string | undefined> = {
  queued: 'blue',
  leased: 'blue',
  received: 'processing',
  succeeded: 'green',
  business_error: 'orange',
  dead_letter: 'red',
  expired: 'default',
  expired_undelivered: 'default',
  cancelled: undefined,
};

export function onecCommandStatusColor(status: string): string | undefined {
  return (ONEC_COMMAND_STATUS_COLORS as Record<string, string | undefined>)[status];
}

/** Only a command the agent has not yet finished processing may be cancelled (spec §4.7). */
export function onecCommandCancellable(status: string): boolean {
  return status === 'queued' || status === 'leased';
}

/** Human-readable source of a command: the admin UI names the operator, others show the module code. */
export function onecCommandSourceLabel(input: {
  sourceModule: string;
  requestedBy: OnecCommandRequestedBy | null;
}): string {
  if (input.sourceModule === 'onec_admin') {
    return input.requestedBy ? `Администратор: ${input.requestedBy.displayName}` : 'Администратор';
  }
  return input.sourceModule;
}

/** Default `integration_probe` marker offered in the "Отправить команду" dialog. */
export function onecDefaultProbeMarker(now: Date = new Date()): string {
  return `ERP probe ${now.toLocaleString('ru-RU')}`;
}

/**
 * Builds exactly the payload the backend `OPERATOR_COMMAND_SCHEMAS` expect for
 * each operator-sendable command type; admin commands with no fields get `{}`.
 */
export function onecCommandPayloadFromForm(
  type: string,
  values: { entities?: string[]; entity?: string; marker?: string },
): Record<string, unknown> {
  switch (type) {
    case 'start_full_sync':
      return { entities: (values.entities ?? []).map((v) => v.trim()).filter((v) => v.length > 0) };
    case 'reload_entity':
      return { entity: (values.entity ?? '').trim() };
    case 'integration_probe':
      return { marker: (values.marker ?? '').trim() };
    case 'pause_etl':
    case 'resume_etl':
    case 'run_connectivity_test':
    case 'collect_diagnostics':
    case 'rotate_certificate_hint':
    default:
      return {};
  }
}

export type OnecCertExpirySeverity = 'critical' | 'warning' | 'ok' | 'none';

/** Certificate expiry banding: <=0 or <=7 days = critical, <=30 = warning (spec threshold), else ok. */
export function onecCertExpirySeverity(
  notAfter: string | null | undefined,
  now: number = Date.now(),
): OnecCertExpirySeverity {
  if (!notAfter) return 'none';
  const expiresAt = new Date(notAfter).getTime();
  if (Number.isNaN(expiresAt)) return 'none';
  const daysLeft = (expiresAt - now) / 86_400_000;
  if (daysLeft <= 7) return 'critical';
  if (daysLeft <= 30) return 'warning';
  return 'ok';
}

export function onecCertExpiryColor(severity: OnecCertExpirySeverity): string | undefined {
  switch (severity) {
    case 'critical':
      return 'red';
    case 'warning':
      return 'orange';
    case 'ok':
      return 'green';
    default:
      return undefined;
  }
}

/** Coarse relative-time label; exact enough for an operator dashboard. */
export function onecRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'никогда';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'никогда';
  const diffMs = now - then;
  if (diffMs < 0) return 'только что';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'только что';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ч назад`;
  const days = Math.floor(hr / 24);
  return `${days} дн назад`;
}

/** Omit the header entirely when there is no draft yet (spec: "omit ONLY when draft is null"). */
/**
 * Configuration writes are allowed only when the loaded state belongs to the
 * currently selected agent and nothing is loading: otherwise a form of agent A
 * could be saved into the draft of agent B.
 */
export function onecConfigWritable(input: {
  selectedAgentId: string | null;
  loadedAgentId: string | null;
  loading: boolean;
}): boolean {
  return Boolean(input.selectedAgentId) && !input.loading && input.selectedAgentId === input.loadedAgentId;
}

/** A response is applied only if it answers the latest request for the still-selected agent. */
export function onecIsCurrentResponse(input: {
  requestSeq: number;
  latestSeq: number;
  requestAgentId: string;
  selectedAgentId: string | null;
}): boolean {
  return input.requestSeq === input.latestSeq && input.requestAgentId === input.selectedAgentId;
}

/** Human-readable line for one state-history sample (backend historySummary()). */
export function onecFormatHistorySummary(summary: OnecStatusHistorySummary | null | undefined): string {
  if (!summary) return '—';
  const parts: string[] = [];
  if (summary.version) parts.push(`версия ${summary.version}`);
  if (summary.odataAvailable != null) parts.push(`OData: ${summary.odataAvailable ? 'доступен' : 'недоступен'}`);
  if (summary.commandApiAvailable != null) parts.push(`команды 1С: ${summary.commandApiAvailable ? 'доступны' : 'недоступны'}`);
  const q = summary.queues;
  if (q) {
    parts.push(
      `очереди: команды ${q.commandsPending ?? 0}, результаты ${q.resultsPending ?? 0}, пакеты ${q.etlBatchesPending ?? 0}, dead-letter ${q.deadLetters ?? 0}`,
    );
  }
  if (summary.diskFreeBytes != null) parts.push(`диск свободно ${(summary.diskFreeBytes / 1024 ** 3).toFixed(1)} ГБ`);
  return parts.length > 0 ? parts.join('; ') : '—';
}

export function onecIfMatchHeader(revision: number | null | undefined): Record<string, string> | undefined {
  if (revision === null || revision === undefined) return undefined;
  return { 'If-Match': String(revision) };
}

/**
 * Deep, key-order-independent JSON serialization. Backend responses round-trip
 * objects through zod parsing, which re-orders keys to schema-declaration
 * order; a plain JSON.stringify comparison against a locally-built object
 * (built in a different key order) would then report a spurious difference.
 */
export function onecStableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableStringify);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortForStableStringify(record[key]);
        return acc;
      }, {});
  }
  return value;
}

/** List of human-readable changed-field lines between the draft and the currently published config. */
export function onecDiffConfigurations(
  draft: OnecAgentConfiguration | null,
  published: OnecAgentConfiguration | null,
): string[] {
  if (!draft) return [];
  if (!published) return ['Первая публикация конфигурации'];

  const changes: string[] = [];
  if (draft.mode !== published.mode) {
    changes.push(`Режим: ${onecModeLabel(published.mode)} → ${onecModeLabel(draft.mode)}`);
  }
  if (draft.etlIntervalMinutes !== published.etlIntervalMinutes) {
    changes.push(`Интервал выгрузки: ${published.etlIntervalMinutes} мин → ${draft.etlIntervalMinutes} мин`);
  }

  const addedCommands = draft.commandTypes.filter((type) => !published.commandTypes.includes(type));
  const removedCommands = published.commandTypes.filter((type) => !draft.commandTypes.includes(type));
  if (addedCommands.length) {
    changes.push(`Добавлены команды: ${addedCommands.map(onecCommandTypeLabel).join(', ')}`);
  }
  if (removedCommands.length) {
    changes.push(`Удалены команды: ${removedCommands.map(onecCommandTypeLabel).join(', ')}`);
  }

  const draftCodes = draft.etlEntities.map((entity) => entity.entityCode);
  const publishedCodes = published.etlEntities.map((entity) => entity.entityCode);
  const addedEntities = draftCodes.filter((code) => !publishedCodes.includes(code));
  const removedEntities = publishedCodes.filter((code) => !draftCodes.includes(code));
  if (addedEntities.length) changes.push(`Добавлены сущности выгрузки: ${addedEntities.join(', ')}`);
  if (removedEntities.length) changes.push(`Удалены сущности выгрузки: ${removedEntities.join(', ')}`);

  for (const code of draftCodes.filter((c) => publishedCodes.includes(c))) {
    const draftEntity = draft.etlEntities.find((entity) => entity.entityCode === code);
    const publishedEntity = published.etlEntities.find((entity) => entity.entityCode === code);
    if (onecStableStringify(draftEntity) !== onecStableStringify(publishedEntity)) {
      changes.push(`Изменена сущность выгрузки: ${code}`);
    }
  }

  return changes;
}

/** Form-friendly representation of an ETL entity: arrays as comma/space-separated text. */
export interface OnecEtlEntityFormValues {
  entityCode: string;
  oDataPath: string;
  keyFieldsText: string;
  updatedAtField: string;
  updatedAtEdmType: '' | 'Edm.DateTimeOffset' | 'Edm.DateTime';
  deletedField: string;
  selectText: string;
  syncMode: string;
  pageSize: number;
  overlapMinutes: number;
  schemaVersion: number | null;
  oDataVersion: '' | 3 | 4;
  enabled: boolean;
  deleteBatchAfterAck: boolean;
  filter: string;
}

function splitList(text: string): string[] {
  return text
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export const ONEC_ETL_ENTITY_FORM_DEFAULTS: OnecEtlEntityFormValues = {
  entityCode: '',
  oDataPath: '',
  keyFieldsText: '',
  updatedAtField: '',
  updatedAtEdmType: '',
  deletedField: '',
  selectText: '',
  syncMode: 'full',
  pageSize: 500,
  overlapMinutes: 0,
  schemaVersion: null,
  oDataVersion: '',
  enabled: true,
  deleteBatchAfterAck: false,
  filter: '',
};

/** Convert an API entity into edit-form values (arrays joined for a text input). */
export function onecEtlEntityToFormValues(entity: OnecEtlEntity): OnecEtlEntityFormValues {
  const keyFields = entity.keyFields ?? (entity.keyField ? [entity.keyField] : []);
  return {
    entityCode: entity.entityCode,
    oDataPath: entity.oDataPath,
    keyFieldsText: keyFields.join(', '),
    updatedAtField: entity.updatedAtField ?? '',
    updatedAtEdmType: entity.updatedAtEdmType ?? '',
    deletedField: entity.deletedField ?? '',
    selectText: entity.select.join(', '),
    syncMode: entity.syncMode,
    pageSize: entity.pageSize,
    overlapMinutes: entity.overlapMinutes,
    schemaVersion: entity.schemaVersion ?? null,
    oDataVersion: entity.oDataVersion ?? '',
    enabled: entity.enabled ?? true,
    deleteBatchAfterAck: entity.deleteBatchAfterAck ?? false,
    filter: entity.filter ?? '',
  };
}

/**
 * Convert form values back into the API entity shape. Optional fields that
 * are empty are OMITTED (never sent as ""), matching the strict backend
 * schema (odataName requires a non-empty string when present).
 */
export function onecEtlEntityFromFormValues(values: OnecEtlEntityFormValues): OnecEtlEntity {
  const keyFields = splitList(values.keyFieldsText);
  const select = splitList(values.selectText);

  const entity: OnecEtlEntity = {
    entityCode: values.entityCode.trim(),
    oDataPath: values.oDataPath.trim(),
    keyFields,
    select,
    syncMode: values.syncMode.trim(),
    pageSize: values.pageSize,
    overlapMinutes: values.overlapMinutes,
  };

  const updatedAtField = values.updatedAtField.trim();
  if (updatedAtField) entity.updatedAtField = updatedAtField;

  if (values.updatedAtEdmType) entity.updatedAtEdmType = values.updatedAtEdmType;

  const deletedField = values.deletedField.trim();
  if (deletedField) entity.deletedField = deletedField;

  if (values.schemaVersion !== null && values.schemaVersion !== undefined) {
    entity.schemaVersion = values.schemaVersion;
  }

  if (values.oDataVersion) entity.oDataVersion = values.oDataVersion;

  entity.enabled = values.enabled;

  if (values.deleteBatchAfterAck) entity.deleteBatchAfterAck = true;
  if (values.filter.trim()) entity.filter = values.filter.trim();

  return entity;
}

/** entityCode uniqueness check used by the entity table/editor before submit. */
export function onecEtlEntityCodeIsDuplicate(
  entities: OnecEtlEntity[],
  entityCode: string,
  excludeIndex?: number,
): boolean {
  return entities.some((entity, index) => index !== excludeIndex && entity.entityCode === entityCode);
}

/**
 * The backend stamps `sourceGeneration` onto a configuration only at publish
 * time (`OnecAdminService.publish`); the draft schema is strict and rejects
 * unknown keys. Every place that copies a published configuration into a
 * draft (or a "no draft yet" fallback) must strip it first.
 */
export function onecStripSourceGeneration(configuration: OnecPublishedAgentConfiguration): OnecAgentConfiguration {
  const { sourceGeneration: _sourceGeneration, ...rest } = configuration;
  return rest;
}

/** Ready-made ETL entities for the 1C catalogs/registers agreed with the agent team (agent to-erp/0003, E3b). */
export const ONEC_ETL_ENTITY_PRESETS: Record<
  'items' | 'counterparties' | 'units' | 'item_categories' | 'warehouses' | 'stock_balances' | 'counterparty_phones' | 'counterparty_contacts',
  OnecEtlEntity
> = {
  items: {
    entityCode: 'items',
    oDataPath: 'Catalog_Номенклатура',
    keyField: 'Ref_Key',
    updatedAtField: null,
    deletedField: 'DeletionMark',
    select: [
      'Ref_Key',
      'DataVersion',
      'Code',
      'Description',
      'Parent_Key',
      'IsFolder',
      'DeletionMark',
      'Артикул',
      'НаименованиеПолное',
      'ЕдиницаИзмерения_Key',
      'КатегорияНоменклатуры_Key',
      'ТипНоменклатуры',
      'Поставщик_Key',
      'Склад_Key',
    ],
    syncMode: 'incremental',
    pageSize: 1000,
    overlapMinutes: 0,
    enabled: true,
  },
  counterparties: {
    entityCode: 'counterparties',
    oDataPath: 'Catalog_Контрагенты',
    keyField: 'Ref_Key',
    updatedAtField: null,
    deletedField: 'DeletionMark',
    select: [
      'Ref_Key',
      'DataVersion',
      'Code',
      'Description',
      'Parent_Key',
      'IsFolder',
      'DeletionMark',
      'НаименованиеПолное',
      'Покупатель',
      'Поставщик',
      'ВидКонтрагента',
      'ИдентификационныйНомер',
      'ИдентификационныйНомерВведенКорректно',
    ],
    syncMode: 'incremental',
    pageSize: 1000,
    overlapMinutes: 0,
    enabled: true,
  },
  units: {
    entityCode: 'units',
    oDataPath: 'Catalog_КлассификаторЕдиницИзмерения',
    keyField: 'Ref_Key',
    updatedAtField: null,
    deletedField: 'DeletionMark',
    select: ['Ref_Key', 'DataVersion', 'DeletionMark', 'Code', 'Description', 'НаименованиеПолное', 'МеждународноеСокращение'],
    syncMode: 'incremental',
    pageSize: 1000,
    overlapMinutes: 0,
    enabled: true,
  },
  item_categories: {
    entityCode: 'item_categories',
    oDataPath: 'Catalog_КатегорииНоменклатуры',
    keyField: 'Ref_Key',
    updatedAtField: null,
    deletedField: 'DeletionMark',
    select: ['Ref_Key', 'DataVersion', 'DeletionMark', 'Code', 'Description', 'Parent_Key', 'IsFolder', 'ТипНоменклатурыПоУмолчанию', 'ЕдиницаИзмерения_Key'],
    syncMode: 'incremental',
    pageSize: 1000,
    overlapMinutes: 0,
    enabled: true,
  },
  warehouses: {
    entityCode: 'warehouses',
    oDataPath: 'Catalog_СтруктурныеЕдиницы',
    keyField: 'Ref_Key',
    updatedAtField: null,
    deletedField: 'DeletionMark',
    select: ['Ref_Key', 'DataVersion', 'DeletionMark', 'Code', 'Description', 'Parent_Key', 'ТипСтруктурнойЕдиницы'],
    syncMode: 'incremental',
    pageSize: 1000,
    overlapMinutes: 0,
    enabled: true,
  },
  stock_balances: {
    entityCode: 'stock_balances',
    oDataPath: "AccumulationRegister_ЗапасыНаСкладах/Balance(Dimensions='Организация,Номенклатура,Характеристика,Партия,СтруктурнаяЕдиница,Ячейка')",
    keyField: 'Номенклатура_Key',
    keyFields: ['Организация_Key', 'Номенклатура_Key', 'Характеристика_Key', 'Партия_Key', 'СтруктурнаяЕдиница_Key', 'Ячейка_Key'],
    updatedAtField: null,
    deletedField: null,
    select: ['Организация_Key', 'Номенклатура_Key', 'Характеристика_Key', 'Партия_Key', 'СтруктурнаяЕдиница_Key', 'Ячейка_Key', 'КоличествоBalance'],
    syncMode: 'incremental',
    pageSize: 1000,
    overlapMinutes: 0,
    enabled: true,
  },
  // Personal data (agent to-erp/0040): phones only, the agent deletes its batch right after the ACK.
  counterparty_phones: {
    entityCode: 'counterparty_phones',
    oDataPath: 'Catalog_Контрагенты_КонтактнаяИнформация',
    keyField: 'Ref_Key',
    keyFields: ['Ref_Key', 'LineNumber'],
    updatedAtField: null,
    deletedField: null,
    select: ['Ref_Key', 'LineNumber', 'Тип', 'Вид_Key', 'Представление'],
    filter: "Тип eq 'Телефон'",
    deleteBatchAfterAck: true,
    syncMode: 'incremental',
    pageSize: 1000,
    overlapMinutes: 0,
    enabled: true,
  },
  // Personal data (agent to-erp/0142): every contact line of a counterparty — phones, e-mail, addresses; no filter.
  counterparty_contacts: {
    entityCode: 'counterparty_contacts',
    oDataPath: 'Catalog_Контрагенты_КонтактнаяИнформация',
    keyField: 'Ref_Key',
    keyFields: ['Ref_Key', 'LineNumber'],
    updatedAtField: null,
    deletedField: null,
    select: [
      'Ref_Key', 'LineNumber', 'Тип', 'Вид_Key', 'Представление', 'Страна', 'Регион', 'Город',
      'АдресЭП', 'ДоменноеИмяСервера', 'НомерТелефона', 'НомерТелефонаБезКодов',
    ],
    deleteBatchAfterAck: true,
    syncMode: 'incremental',
    pageSize: 1000,
    overlapMinutes: 0,
    enabled: true,
  },
};

export const ONEC_ETL_ENTITY_PRESET_LABELS: Record<keyof typeof ONEC_ETL_ENTITY_PRESETS, string> = {
  items: 'Номенклатура (items)',
  counterparties: 'Контрагенты (counterparties)',
  units: 'Единицы измерения (units)',
  item_categories: 'Категории номенклатуры (item_categories)',
  warehouses: 'Склады (warehouses)',
  stock_balances: 'Остатки (stock_balances)',
  counterparty_phones: 'Телефоны контрагентов (counterparty_phones, персональные данные)',
  counterparty_contacts: 'Контакты контрагентов (counterparty_contacts, персональные данные)',
};

// ---------------------------------------------------------------- ETL tab labels

export const ONEC_ETL_ENTITY_LABELS: Record<string, string> = {
  items: 'Номенклатура',
  counterparties: 'Контрагенты',
  units: 'Единицы измерения',
  item_categories: 'Категории номенклатуры',
  warehouses: 'Склады',
  stock_balances: 'Остатки',
  counterparty_phones: 'Телефоны контрагентов',
  counterparty_contacts: 'Контакты контрагентов',
  price_kinds: 'Виды цен',
  price_types: 'Виды цен',
  item_prices: 'Цены',
  doc_purchase_receipts: 'Приходные накладные',
  doc_sales_shipments: 'Расходные накладные',
  doc_inventory_writeoffs: 'Списания',
  doc_inventory_transfers: 'Перемещения',
  doc_cash_outflows: 'Расходные кассовые ордера',
  doc_bank_outflows: 'Расходы со счёта',
  doc_customer_orders: 'Заказы покупателей',
  doc_cash_receipts: 'Поступления в кассу',
  doc_bank_receipts: 'Поступления на счёт',
  doc_supplier_orders: 'Заказы поставщикам',
  doc_invoices: 'Счета на оплату',
  doc_work_acts: 'Акты выполненных работ',
  order_states: 'Состояния заказов',
  order_kinds: 'Виды заказов',
  work_order_states: 'Состояния заказ-нарядов',
  work_order_kinds: 'Виды заказ-нарядов',
  packaging_units: 'Единицы упаковки',
  item_characteristics: 'Характеристики номенклатуры',
  item_batches: 'Партии номенклатуры',
  currencies: 'Валюты',
  contracts: 'Договоры',
  cash_desks: 'Кассы',
  bank_accounts: 'Банковские счета',
  cashflow_items: 'Статьи движения денег',
  delivery_services: 'Службы доставки',
  users: 'Пользователи 1С',
  employees: 'Сотрудники',
  reg_customer_orders: 'Регистр заказов покупателей',
  reg_customer_settlements: 'Регистр расчётов с покупателями',
  reg_invoice_payments: 'Регистр оплаты счетов и заказов',
  reg_stock_balance_turnovers: 'Остатки и обороты запасов',
};

export function onecEtlEntityLabel(code: string): string {
  return ONEC_ETL_ENTITY_LABELS[code] ?? code;
}

export const ONEC_ETL_RUN_MODE_LABELS: Record<string, string> = {
  bootstrap_full: 'Полная выгрузка',
  entity_reload: 'Перезагрузка сущности',
  incremental: 'Изменения',
};

export function onecEtlRunModeLabel(mode: OnecEtlRunMode | string | null): string {
  if (!mode) return '—';
  return ONEC_ETL_RUN_MODE_LABELS[mode] ?? mode;
}

export const ONEC_ETL_RUN_STATUS_LABELS: Record<OnecEtlRunStatus, string> = {
  receiving: 'Получение',
  completed: 'Завершена',
  abandoned: 'Брошена',
};

export function onecEtlRunStatusLabel(status: string): string {
  return (ONEC_ETL_RUN_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export const ONEC_ETL_RUN_STATUS_COLORS: Record<OnecEtlRunStatus, string | undefined> = {
  receiving: 'processing',
  completed: 'green',
  abandoned: 'red',
};

export function onecEtlRunStatusColor(status: string): string | undefined {
  return (ONEC_ETL_RUN_STATUS_COLORS as Record<string, string | undefined>)[status];
}

export const ONEC_ETL_BATCH_STATUS_LABELS: Record<OnecEtlBatchStatus, string> = {
  receiving: 'Получение',
  stored: 'Сохранён',
  parsing: 'Разбор',
  parsed: 'Разобран',
  invalid: 'Ошибка разбора',
  discarded: 'Отброшен',
  finalized: 'Перенесён',
};

export function onecEtlBatchStatusLabel(status: string): string {
  return (ONEC_ETL_BATCH_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export const ONEC_ETL_BATCH_STATUS_COLORS: Record<OnecEtlBatchStatus, string | undefined> = {
  receiving: 'blue',
  stored: 'blue',
  parsing: 'processing',
  parsed: 'green',
  invalid: 'red',
  discarded: 'default',
  finalized: 'green',
};

export function onecEtlBatchStatusColor(status: string): string | undefined {
  return (ONEC_ETL_BATCH_STATUS_COLORS as Record<string, string | undefined>)[status];
}

export const ONEC_ETL_COMPLETENESS_LABELS: Record<'verified' | 'unverified' | 'not_checked', string> = {
  verified: 'Подтверждена',
  unverified: 'Не подтверждена',
  not_checked: 'Не проверялась',
};

export function onecEtlCompletenessLabel(value: OnecEtlCompleteness | string | null | undefined): string {
  if (!value) return '—';
  return (ONEC_ETL_COMPLETENESS_LABELS as Record<string, string>)[value] ?? value;
}

export function onecEtlReadScopeLabel(scope: OnecEtlReadScope | string | null | undefined): string {
  if (scope === 'full') return 'Полное';
  if (scope === 'delta') return 'Изменения';
  return '—';
}

export function onecEtlEntityStatusLabel(status: OnecEtlLastStatus | string | null): string {
  if (status === 'done') return 'Успешно';
  if (status === 'failed') return 'Ошибка';
  return 'Нет данных';
}

export function onecEtlEntityStatusColor(status: OnecEtlLastStatus | string | null): string | undefined {
  if (status === 'done') return 'green';
  if (status === 'failed') return 'red';
  return undefined;
}

// ---------------------------------------------------------------- Snapshot entities, revocation, mirror (E3b)

/** Entities whose whole copy is replaced by a newer verified snapshot rather than merged incrementally. */
export const ONEC_ETL_SNAPSHOT_ENTITIES: readonly string[] = ['stock_balances', 'counterparty_phones', 'counterparty_contacts'];

export function onecEtlIsSnapshotEntity(entity: string): boolean {
  return ONEC_ETL_SNAPSHOT_ENTITIES.includes(entity);
}

/** Personal-data entities the operator may revoke (data purge + write ban) from the ETL tab. */
export const ONEC_ETL_REVOCABLE_ENTITIES: readonly string[] = ['counterparty_phones', 'counterparty_contacts'];

export function onecEtlEntityRevocable(entity: string): boolean {
  return ONEC_ETL_REVOCABLE_ENTITIES.includes(entity);
}

export const ONEC_SNAPSHOT_REJECTED_REASON_LABELS: Record<string, string> = {
  FAILED: 'сущность не выгрузилась',
  NO_BATCH: 'нет пакета',
  NOT_FULL: 'чтение не полное',
  NOT_VERIFIED: 'полнота не подтверждена',
  NO_SNAPSHOT_TIME: 'нет времени снимка',
  STALE: 'пришёл более старый снимок',
};

export function onecSnapshotRejectedReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return ONEC_SNAPSHOT_REJECTED_REASON_LABELS[reason] ?? reason;
}

export const ONEC_MIRROR_STATE_LABELS: Record<'all' | 'active' | 'deleted' | 'missing', string> = {
  all: 'Все',
  active: 'Действующие',
  deleted: 'Помечены на удаление в 1С',
  missing: 'Пропали в 1С',
};

/** Options for the state filter Select, in the order they should appear (spec: "Все / Действующие / Помечены на удаление в 1С / Пропали в 1С"). */
export const ONEC_MIRROR_STATE_OPTIONS: Array<{ value: 'all' | 'active' | 'deleted' | 'missing'; label: string }> = [
  { value: 'all', label: ONEC_MIRROR_STATE_LABELS.all },
  { value: 'active', label: ONEC_MIRROR_STATE_LABELS.active },
  { value: 'deleted', label: ONEC_MIRROR_STATE_LABELS.deleted },
  { value: 'missing', label: ONEC_MIRROR_STATE_LABELS.missing },
];

export function onecMirrorStateLabel(state: string): string {
  return (ONEC_MIRROR_STATE_LABELS as Record<string, string>)[state] ?? state;
}

// ---------------------------------------------------------------- «Сопоставление» (matching tab, E3c)

export const ONEC_MATCH_STATUS_LABELS: Record<'matched' | 'ambiguous' | 'unmatched', string> = {
  matched: 'Сопоставлено',
  ambiguous: 'Неоднозначно',
  unmatched: 'Без пары',
};

export function onecMatchStatusLabel(status: string): string {
  return (ONEC_MATCH_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export const ONEC_MATCH_STATUS_COLORS: Record<'matched' | 'ambiguous' | 'unmatched', string> = {
  matched: 'green',
  ambiguous: 'orange',
  unmatched: 'default',
};

export function onecMatchStatusColor(status: string): string {
  return (ONEC_MATCH_STATUS_COLORS as Record<string, string>)[status] ?? 'default';
}

/** Options for the status-filter Select, in the order they should appear. */
export const ONEC_MATCH_STATUS_OPTIONS: Array<{ value: 'all' | 'matched' | 'ambiguous' | 'unmatched'; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'matched', label: ONEC_MATCH_STATUS_LABELS.matched },
  { value: 'ambiguous', label: ONEC_MATCH_STATUS_LABELS.ambiguous },
  { value: 'unmatched', label: ONEC_MATCH_STATUS_LABELS.unmatched },
];

/** Options for the role-filter Select, in the order they should appear. */
export const ONEC_MATCH_ROLE_OPTIONS: Array<{ value: 'all' | 'buyer' | 'supplier'; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'buyer', label: 'Покупатели' },
  { value: 'supplier', label: 'Поставщики' },
];

export const ONEC_MATCH_KIND_LABELS: Record<'client' | 'supplier', string> = {
  client: 'Клиент',
  supplier: 'Поставщик',
};

export function onecMatchKindLabel(kind: string): string {
  return (ONEC_MATCH_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export const ONEC_MATCH_BY_LABELS: Record<'ref_key' | 'name' | 'phone', string> = {
  ref_key: 'по ключу 1С',
  name: 'по наименованию',
  phone: 'по телефону',
};

export function onecMatchByLabel(by: string): string {
  return (ONEC_MATCH_BY_LABELS as Record<string, string>)[by] ?? by;
}

/** One ERP match line: "Клиент: Иванов ИП (по наименованию, по телефону)". */
export function onecMatchLine(match: { kind: string; name: string; by: string[] }): string {
  const ways = match.by.map(onecMatchByLabel).join(', ');
  return `${onecMatchKindLabel(match.kind)}: ${match.name}${ways ? ` (${ways})` : ''}`;
}

/** Summary breakdown line: "по наименованию N, по телефону N, по ключу 1С N". */
export function onecMatchSummaryBreakdownLabel(summary: { byName: number; byPhone: number; byRefKey: number }): string {
  return `по наименованию ${summary.byName}, по телефону ${summary.byPhone}, по ключу 1С ${summary.byRefKey}`;
}

/** null = incorrect/unrecognized only when the backend explicitly says so (`binValid === false`). */
export function onecBinValidityLabel(binValid: boolean | null): string | null {
  return binValid === false ? 'некорректный' : null;
}

/** Category name shown in the item-distribution table; 1C categoryless items get an explicit label. */
export function onecItemCategoryNameLabel(categoryName: string | null): string {
  return categoryName ?? 'Без категории';
}

/** "Запас 1990 · Услуга 1" — item counts per 1C item type within one category, largest first. */
export function onecItemTypeBreakdownLabel(byType: Array<{ type: string; total: number }>): string {
  return byType
    .slice()
    .sort((a, b) => b.total - a.total)
    .map((entry) => `${entry.type} ${entry.total}`)
    .join(' · ');
}
