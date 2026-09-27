/**
 * Pure formatting/label/diff helpers for the "Интеграция 1С" admin screens.
 * Kept free of React/antd/network so they run under Vitest (environment=node)
 * without a DOM.
 */
import type {
  OnecAgentConfiguration,
  OnecAgentMode,
  OnecConnectionState,
  OnecEtlEntity,
  OnecHeartbeatState,
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
};

export function onecAlertKindLabel(kind: string): string {
  return ONEC_ALERT_KIND_LABELS[kind] ?? kind;
}

export const ONEC_INCIDENT_KIND_LABELS: Record<string, string> = {
  ingress_auth_failed: 'Ошибка аутентификации на входе',
  unknown_certificate: 'Неизвестный сертификат',
  agent_cert_mismatch: 'Несоответствие сертификата агента',
  source_identity_changed: 'Сменилась база 1С',
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
};

export function onecCommandTypeLabel(type: string): string {
  return ONEC_COMMAND_TYPE_LABELS[type] ?? type;
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
