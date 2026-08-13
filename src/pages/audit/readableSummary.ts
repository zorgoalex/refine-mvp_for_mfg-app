import type { AuditLogEventDto, AuditRelatedEntity } from '../../api/types/auditApi.types';

export interface AuditReadableChange {
  label: string;
  before: string;
  after: string;
}

export interface AuditReadableSummary {
  title: string;
  actor: string;
  object: string;
  changes: AuditReadableChange[];
  notes: string[];
  related: string[];
}

type JsonObject = Record<string, unknown>;

interface StatusEventConfig {
  title: string;
  changeLabel: string;
  statusPrefix: 'orderStatus' | 'productionStatus';
  genericBeforeLabel?: string;
}

const STATUS_EVENT_CONFIG: Record<string, StatusEventConfig> = {
  'orders.status_change': {
    title: 'Изменён статус заказа',
    changeLabel: 'Статус заказа',
    statusPrefix: 'orderStatus',
  },
  'orders.production_status_change': {
    title: 'Изменён производственный статус заказа',
    changeLabel: 'Производственный статус заказа',
    statusPrefix: 'productionStatus',
  },
  'orders.detail_production_status_change': {
    title: 'Изменён производственный статус детали',
    changeLabel: 'Производственный статус детали',
    statusPrefix: 'productionStatus',
    genericBeforeLabel: 'прежний статус',
  },
  'orders.detail_production_status_batch_change': {
    title: 'Изменён производственный статус деталей заказа',
    changeLabel: 'Статус выбранных деталей',
    statusPrefix: 'productionStatus',
    genericBeforeLabel: 'разные статусы',
  },
};

const EVENT_TITLES: Record<string, string> = {
  'orders.create': 'Создан заказ',
  'orders.update': 'Обновлён заказ',
  'orders.delete': 'Удалён заказ',
  'orders.restore': 'Восстановлен заказ',
  'orders.detail_transfer': 'Перенесены детали заказа',
  'orders.status_change': STATUS_EVENT_CONFIG['orders.status_change'].title,
  'orders.production_status_change': STATUS_EVENT_CONFIG['orders.production_status_change'].title,
  'orders.detail_production_status_change': STATUS_EVENT_CONFIG['orders.detail_production_status_change'].title,
  'orders.detail_production_status_batch_change':
    STATUS_EVENT_CONFIG['orders.detail_production_status_batch_change'].title,
  'orders.production_status_mode_restore': 'Включён авторасчёт производственного статуса',
  'orders.production_status_mode_manual': 'Включён ручной производственный статус',
  'payments.create': 'Добавлен платёж',
  'payments.update': 'Изменён платёж',
  'payments.delete': 'Удалён платёж',
  'client_phones.create': 'Добавлен телефон клиента',
  'client_phones.update': 'Изменён телефон клиента',
  'client_phones.delete': 'Удалён телефон клиента',
  'deadlines.create': 'Создан дедлайн',
  'deadlines.update': 'Изменён дедлайн',
  'deadlines.delete': 'Удалён дедлайн',
  'groups.notification_created': 'Создано уведомление по группе',
  'org.direction_head_added': 'Назначен руководитель направления',
  'org.direction_head_removed': 'Снят руководитель направления',
  'production.action_denied': 'Отказано в производственном действии',
  'cnc.manual_svg_upload.file_uploaded': 'Загружен файл раскроя',
  'cnc.manual_svg_upload.telegram_send_completed': 'Файлы раскроя отправлены в Telegram',
  'cnc.manual_svg_upload.telegram_send_failed': 'Ошибка отправки файлов раскроя в Telegram',
};

const ENTITY_LABELS: Record<string, string> = {
  order: 'Заказ',
  order_detail: 'Деталь',
  detail: 'Деталь',
  client: 'Клиент',
  client_phone: 'Телефон клиента',
  payment: 'Платёж',
  deadline: 'Дедлайн',
  production_event: 'Производственное событие',
  user: 'Пользователь',
  employee: 'Сотрудник',
  direction: 'Направление',
  group: 'Группа',
  cnc_manual_svg_upload_file: 'Файл раскроя',
  cnc_manual_svg_telegram_send_request: 'Отправка файлов раскроя',
};

const FIELD_LABELS: Record<string, string> = {
  orderStatusId: 'Статус заказа',
  orderStatusName: 'Статус заказа',
  productionStatusId: 'Производственный статус заказа',
  productionStatusName: 'Производственный статус',
  orderProductionStatusId: 'Производственный статус заказа',
  productionStatusFromDetailsEnabled: 'Режим производственного статуса',
  paymentStatusId: 'Статус оплаты',
  paymentStatusName: 'Статус оплаты',
  managerId: 'Менеджер',
  responsibleEmployeeId: 'Ответственный сотрудник',
  designEngineerId: 'Инженер-конструктор',
  clientId: 'Клиент',
  orderId: 'Заказ',
  detailId: 'Деталь',
  amount: 'Сумма',
  paidAmount: 'Оплачено',
  finalAmount: 'Итоговая сумма',
  plannedCompletionDate: 'Плановая дата завершения',
  completedDate: 'Дата завершения',
  deadlineAt: 'Срок',
  title: 'Название',
  name: 'Название',
  note: 'Комментарий',
  comment: 'Комментарий',
};

const TECHNICAL_FIELD_NAMES = new Set([
  'version',
  'orderVersion',
  'requestId',
  'idempotencyKey',
  'auditId',
  'source',
  'action',
  'statusField',
  'statusDistributionBasis',
  'detailStatusDistribution',
  'beforeStatusDistribution',
  'afterStatusDistribution',
  'ruleConfigSnapshot',
  'snapshotHash',
  'deadlineEventId',
  'actionRuleId',
  'ruleVersionId',
  'accessVia',
  'assignmentSource',
  'userAgent',
  'ip',
  'metadata',
]);

const TECHNICAL_FIELD_PARTS = ['token', 'password', 'secret', 'hash', 'signature'];

export function buildAuditReadableSummary(record: AuditLogEventDto): AuditReadableSummary {
  const before = objectOrEmpty(record.before);
  const after = objectOrEmpty(record.after);
  const diff = objectOrEmpty(record.diff);
  const metadata = objectOrEmpty(record.metadata);

  const changes: AuditReadableChange[] = [];
  const notes: string[] = [];

  addDetailTransferSummary(record, metadata, changes, notes);
  addStatusChange(record, before, after, diff, metadata, changes);
  addProductionModeChange(record, diff, before, after, changes);
  addManualSvgFileUploadSummary(record, metadata, changes, notes);
  addGenericChanges(diff, changes);
  addDetailNotes(record, diff, metadata, notes);
  addSourceNote(record, metadata, notes);

  if (changes.length === 0) {
    changes.push({
      label: 'Изменение',
      before: readableFallbackValue(record.before),
      after: readableFallbackValue(record.after),
    });
  }

  return {
    title: EVENT_TITLES[record.event] ?? humanizeEvent(record.event),
    actor: auditActor(record, metadata),
    object: auditObject(record, metadata),
    changes: dedupeChanges(changes).slice(0, 6),
    notes: dedupeStrings(notes).slice(0, 5),
    related: auditRelated(record),
  };
}

export function auditActor(record: AuditLogEventDto, metadata?: JsonObject): string {
  if (record.username) {
    return record.role ? `${record.username} (${record.role})` : record.username;
  }
  if (record.userId != null) return `Пользователь #${record.userId}`;

  const meta = metadata ?? objectOrEmpty(record.metadata);
  const systemActor = objectOrEmpty(meta.systemActor);
  const systemLabel = stringValue(systemActor.actorLabel) ?? stringValue(meta.actorLabel);
  if (systemLabel) return systemLabel;

  if (record.source?.includes('automation')) return 'Автоматизация';
  if (record.source?.includes('deadline')) return 'Система дедлайнов';
  return 'Система';
}

export function auditObject(record: AuditLogEventDto, metadata?: JsonObject): string {
  const meta = metadata ?? objectOrEmpty(record.metadata);
  if (record.event === 'orders.detail_transfer') {
    return detailTransferRouteLabel(record, meta);
  }

  if (isDetailEntityType(record.entityType)) {
    return detailEntityLabel(
      numericEntityId(record.entityId),
      record.entityDetailNumber ?? numberValue(meta.detailNumber)
    );
  }

  if (record.entityType === 'client') {
    return clientEntityLabel(numericEntityId(record.entityId), record.entityName);
  }

  const orderId =
    record.relatedOrderId ??
    (record.entityType === 'order' ? numericEntityId(record.entityId) : undefined) ??
    numberValue(meta.orderId);
  if (orderId != null) {
    const orderName =
      (record.relatedOrderId === orderId ? record.relatedOrderName : null) ??
      (record.entityType === 'order' ? record.entityName : null) ??
      stringValue(meta.orderName);
    return orderEntityLabel(orderId, orderName);
  }

  if (record.entityType) {
    return auditEntityLabel(record.entityType, record.entityId, record.entityName, record.entityDetailNumber);
  }

  const clientId = record.relatedClientId ?? numberValue(meta.clientId);
  if (clientId != null) return clientEntityLabel(clientId, record.relatedClientName ?? stringValue(meta.clientName));

  return 'Объект не указан';
}

function addDetailTransferSummary(
  record: AuditLogEventDto,
  metadata: JsonObject,
  changes: AuditReadableChange[],
  notes: string[]
): void {
  if (record.event !== 'orders.detail_transfer') return;

  const source = detailTransferOrderLabel(
    numberValue(metadata.sourceOrderId) ?? numericEntityId(record.entityId),
    stringValue(metadata.sourceOrderName) ??
      (record.entityType === 'order' ? record.entityName ?? undefined : undefined)
  );
  const target = detailTransferOrderLabel(
    numberValue(metadata.targetOrderId) ?? record.relatedOrderId ?? undefined,
    stringValue(metadata.targetOrderName) ?? record.relatedOrderName ?? undefined
  );
  const details = formatTransferDetailList(metadata);

  changes.push({
    label: 'Детали',
    before: source,
    after: target,
  });
  if (details) notes.push(`Какие детали: ${details}`);
  notes.push(`Из заказа: ${source}`);
  notes.push(`В заказ: ${target}`);
}

function addStatusChange(
  record: AuditLogEventDto,
  before: JsonObject,
  after: JsonObject,
  diff: JsonObject,
  metadata: JsonObject,
  changes: AuditReadableChange[]
): void {
  const config = STATUS_EVENT_CONFIG[record.event];
  if (!config) return;

  const beforeStatus = statusLabel(record, 'before', config, before, after, diff, metadata);
  const afterStatus = statusLabel(record, 'after', config, before, after, diff, metadata);

  changes.push({
    label: config.changeLabel,
    before: beforeStatus,
    after: afterStatus,
  });
}

function addProductionModeChange(
  record: AuditLogEventDto,
  diff: JsonObject,
  before: JsonObject,
  after: JsonObject,
  changes: AuditReadableChange[]
): void {
  if (
    record.event !== 'orders.production_status_mode_restore' &&
    record.event !== 'orders.production_status_mode_manual' &&
    !isDiffPair(diff.productionStatusFromDetailsEnabled)
  ) {
    return;
  }

  const pair = isDiffPair(diff.productionStatusFromDetailsEnabled)
    ? diff.productionStatusFromDetailsEnabled
    : {
        before: before.productionStatusFromDetailsEnabled,
        after: after.productionStatusFromDetailsEnabled,
      };

  if (pair.before === undefined && pair.after === undefined) return;

  changes.push({
    label: FIELD_LABELS.productionStatusFromDetailsEnabled,
    before: formatFieldValue('productionStatusFromDetailsEnabled', pair.before),
    after: formatFieldValue('productionStatusFromDetailsEnabled', pair.after),
  });
}

function addManualSvgFileUploadSummary(
  record: AuditLogEventDto,
  metadata: JsonObject,
  changes: AuditReadableChange[],
  notes: string[],
): void {
  if (record.event !== 'cnc.manual_svg_upload.file_uploaded') return;
  const fileName = stringValue(metadata.fileName) ?? stringValue(metadata.originalFileName) ?? 'файл';
  const kind = stringValue(metadata.fileKind);
  const sizeBytes = numberValue(metadata.sizeBytes);
  const generated = metadata.generated === true;
  changes.push({
    label: 'Файл',
    before: '—',
    after: `${manualSvgFileKindLabel(kind)} ${fileName}`,
  });
  if (sizeBytes != null) notes.push(`Размер: ${formatBytes(sizeBytes)}`);
  if (generated) notes.push('Скрин создан из SVG');
  const cutJobNumber = stringValue(metadata.cutJobDisplayNumber);
  if (cutJobNumber) notes.push(`Раскрой: ${formatDisplayNumber(cutJobNumber)}`);
}

function addGenericChanges(diff: JsonObject, changes: AuditReadableChange[]): void {
  const existingLabels = new Set(changes.map((change) => change.label));

  for (const [field, value] of Object.entries(diff)) {
    if (!isDiffPair(value)) continue;
    if (isTechnicalField(field)) continue;

    const label = fieldLabel(field);
    if (existingLabels.has(label)) continue;

    changes.push({
      label,
      before: formatFieldValue(field, value.before),
      after: formatFieldValue(field, value.after),
    });
    existingLabels.add(label);
  }
}

function addDetailNotes(record: AuditLogEventDto, diff: JsonObject, metadata: JsonObject, notes: string[]): void {
  const detailIds = numericArray(diff.detailIds) ?? numericArray(metadata.detailIds);
  const changedDetailIds = numericArray(diff.changedDetailIds) ?? numericArray(metadata.changedDetailIds);
  const selectedDetailCount = numberValue(diff.selectedDetailCount) ?? numberValue(metadata.selectedDetailCount);
  const affectedDetailCount = numberValue(diff.affectedDetailCount) ?? numberValue(metadata.affectedDetailCount);
  const detailLabelsById = detailLabels(record, metadata);

  if (selectedDetailCount != null) notes.push(`Выбрано деталей: ${selectedDetailCount}`);
  if (affectedDetailCount != null) notes.push(`Изменено деталей: ${affectedDetailCount}`);
  if (detailIds && detailIds.length > 0) notes.push(`Детали: ${formatDetailIdList(detailIds, detailLabelsById)}`);
  if (!detailIds && changedDetailIds && changedDetailIds.length > 0) {
    notes.push(`Изменённые детали: ${formatDetailIdList(changedDetailIds, detailLabelsById)}`);
  }
}

function addSourceNote(record: AuditLogEventDto, metadata: JsonObject, notes: string[]): void {
  const origin = stringValue(metadata.origin);
  if (origin === 'automation' || record.source?.includes('automation')) {
    notes.push('Источник: автоматизация');
    return;
  }

  const systemActor = objectOrEmpty(metadata.systemActor);
  if (record.userId == null && (record.source?.includes('deadline') || systemActor.actorLabel)) {
    notes.push('Источник: системное правило');
  }
}

function statusLabel(
  record: AuditLogEventDto,
  side: 'before' | 'after',
  config: StatusEventConfig,
  before: JsonObject,
  after: JsonObject,
  diff: JsonObject,
  metadata: JsonObject
): string {
  const container = side === 'before' ? before : after;
  const pair = diff[`${config.statusPrefix}Id`];
  const pairValue = isDiffPair(pair) ? pair[side] : undefined;
  const capitalizedPrefix = capitalize(config.statusPrefix);
  const previousId = side === 'before' ? metadata[`previous${capitalizedPrefix}Id`] : undefined;
  const previousName = side === 'before' ? stringValue(metadata[`previous${capitalizedPrefix}Name`]) : undefined;
  const previousCode = side === 'before' ? stringValue(metadata[`previous${capitalizedPrefix}Code`]) : undefined;
  const targetName = side === 'after' ? stringValue(metadata[`${config.statusPrefix}Name`]) : undefined;
  const targetCode = side === 'after' ? stringValue(metadata[`${config.statusPrefix}Code`]) : undefined;
  const rawId =
    pairValue ??
    container[`${config.statusPrefix}Id`] ??
    previousId ??
    (side === 'after' ? record.statusId : undefined);
  const name =
    stringValue(container[`${config.statusPrefix}Name`]) ??
    previousName ??
    targetName ??
    (side === 'after' ? record.statusName ?? undefined : undefined);
  const code =
    stringValue(container[`${config.statusPrefix}Code`]) ??
    previousCode ??
    targetCode ??
    (side === 'after' ? record.statusCode ?? undefined : undefined);

  if (name && code) return `${name} (${code})`;
  if (name) return name;
  if (code) return code;
  if (rawId !== undefined && rawId !== null) return `#${String(rawId)}`;
  if (side === 'before' && config.genericBeforeLabel) return config.genericBeforeLabel;
  return 'не указано';
}

function auditRelated(record: AuditLogEventDto): string[] {
  const related: string[] = [];
  pushOrderRelated(related, record.relatedOrderId, record.relatedOrderName);
  pushClientRelated(related, record.relatedClientId, record.relatedClientName);
  pushRelated(related, 'Платёж', record.relatedPaymentId);
  pushRelated(related, 'Дедлайн', record.relatedDeadlineId);
  pushRelated(related, 'Произв. событие', record.relatedProductionEventId);
  pushRelated(related, 'Пользователь', record.relatedUserId);

  for (const entity of record.relatedEntities ?? []) {
    related.push(relatedEntityLabel(entity));
  }

  return dedupeStrings(related);
}

function pushRelated(parts: string[], label: string, id: number | null | undefined): void {
  if (id != null) parts.push(`${label} #${id}`);
}

function pushOrderRelated(parts: string[], id: number | null | undefined, orderName?: string | null): void {
  if (id != null || orderName) parts.push(orderEntityLabel(id ?? undefined, orderName ?? undefined));
}

function pushClientRelated(parts: string[], id: number | null | undefined, clientName?: string | null): void {
  if (id != null || clientName) parts.push(clientEntityLabel(id ?? undefined, clientName ?? undefined));
}

function relatedEntityLabel(entity: AuditRelatedEntity): string {
  return auditEntityLabel(entity.entityType, String(entity.entityId), entity.entityName, entity.detailNumber);
}

function auditEntityLabel(
  entityType: string,
  entityId: string | null,
  entityName?: string | null,
  detailNumber?: number | null
): string {
  if (entityType === 'order') return orderEntityLabel(numberValue(entityId), entityName ?? undefined);
  if (entityType === 'client') return clientEntityLabel(numberValue(entityId), entityName ?? undefined);
  if (isDetailEntityType(entityType)) {
    return detailEntityLabel(numberValue(entityId), detailNumber ?? undefined);
  }

  const label = ENTITY_LABELS[entityType] ?? humanizeToken(entityType);
  const name = stringValue(entityName);
  if (entityId && name) return `${label} ${name} (#${entityId})`;
  if (entityId) return `${label} #${entityId}`;
  return label;
}

function orderEntityLabel(orderId: number | null | undefined, orderName?: string | null): string {
  const name = stringValue(orderName);
  if (name && orderId != null) return `Заказ ${name} (#${orderId})`;
  if (name) return `Заказ ${name}`;
  if (orderId != null) return `Заказ #${orderId}`;
  return 'Заказ';
}

function clientEntityLabel(clientId: number | null | undefined, clientName?: string | null): string {
  const name = stringValue(clientName);
  if (name && clientId != null) return `Клиент ${name} (#${clientId})`;
  if (name) return `Клиент ${name}`;
  if (clientId != null) return `Клиент #${clientId}`;
  return 'Клиент';
}

function detailEntityLabel(detailId: number | null | undefined, detailNumber?: number | null): string {
  if (detailNumber != null && detailId != null) return `Деталь №${detailNumber} (#${detailId})`;
  if (detailNumber != null) return `Деталь №${detailNumber}`;
  if (detailId != null) return `Деталь #${detailId}`;
  return 'Деталь';
}

function isDetailEntityType(entityType: string | null | undefined): boolean {
  return entityType === 'order_detail' || entityType === 'detail';
}

function detailTransferRouteLabel(record: AuditLogEventDto, metadata: JsonObject): string {
  const source = detailTransferOrderLabel(
    numberValue(metadata.sourceOrderId) ?? numericEntityId(record.entityId),
    stringValue(metadata.sourceOrderName) ??
      (record.entityType === 'order' ? record.entityName ?? undefined : undefined)
  );
  const target = detailTransferOrderLabel(
    numberValue(metadata.targetOrderId) ?? record.relatedOrderId ?? undefined,
    stringValue(metadata.targetOrderName) ?? record.relatedOrderName ?? undefined
  );
  return `${source} → ${target}`;
}

function detailTransferOrderLabel(orderId: number | undefined, orderName: string | undefined): string {
  if (orderId != null) return orderEntityLabel(orderId, orderName);
  if (orderName) return `Заказ ${orderName}`;
  return 'заказ не указан';
}

function numericEntityId(entityId: string | null): number | undefined {
  return numberValue(entityId);
}

function formatTransferDetailList(metadata: JsonObject): string | null {
  const movedDetails = Array.isArray(metadata.movedDetails) ? metadata.movedDetails : [];
  if (movedDetails.length > 0) {
    const labels = movedDetails.map(formatTransferDetail).filter((label): label is string => Boolean(label));
    if (labels.length > 0) {
      const visible = labels.slice(0, 6);
      const suffix = labels.length > visible.length ? ` и ещё ${labels.length - visible.length}` : '';
      return `${visible.join(', ')}${suffix}`;
    }
  }

  const ids = numericArray(metadata.movedDetailIds) ?? numericArray(metadata.detailIds);
  return ids ? formatIdList(ids) : null;
}

function formatTransferDetail(value: unknown): string | null {
  const detail = objectOrEmpty(value);
  const detailId = numberValue(detail.detailId);
  const sourceNumber = numberValue(detail.sourceDetailNumber);
  const targetNumber = numberValue(detail.targetDetailNumber);
  const numberPart =
    sourceNumber != null && targetNumber != null && sourceNumber !== targetNumber
      ? `№${sourceNumber}→№${targetNumber}`
      : sourceNumber != null
      ? `№${sourceNumber}`
      : targetNumber != null
      ? `№${targetNumber}`
      : null;
  const idPart = detailId != null ? `(#${detailId})` : null;
  const sizePart = formatTransferDetailSize(detail);
  const main = numberPart
    ? ['Деталь', numberPart, idPart].filter(Boolean).join(' ')
    : detailId != null
    ? `Деталь #${detailId}`
    : null;
  if (!main && !sizePart) return null;
  return sizePart ? `${main || 'деталь'} (${sizePart})` : main;
}

function formatTransferDetailSize(detail: JsonObject): string | null {
  const height = numberValue(detail.height);
  const width = numberValue(detail.width);
  const quantity = numberValue(detail.quantity);
  if (height == null || width == null || quantity == null) return null;
  return `${height}x${width} x${quantity}`;
}

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? humanizeToken(field);
}

function formatFieldValue(field: string, value: unknown): string {
  if (field === 'productionStatusFromDetailsEnabled') {
    if (value === true) return 'Авто по деталям';
    if (value === false) return 'Ручной';
  }

  if (field.endsWith('Id') && (typeof value === 'number' || typeof value === 'string')) {
    return `#${String(value)}`;
  }

  return formatAuditValue(value);
}

export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'не указано';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return formatStringValue(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'пусто';
    if (value.every((item) => typeof item === 'number' || typeof item === 'string')) {
      return formatIdList(value);
    }
    return `список: ${value.length}`;
  }

  const object = objectOrEmpty(value);
  const named =
    stringValue(object.name) ??
    stringValue(object.title) ??
    stringValue(object.orderStatusName) ??
    stringValue(object.productionStatusName) ??
    stringValue(object.paymentStatusName);
  return named ?? 'изменено';
}

function readableFallbackValue(value: unknown): string {
  if (value === null || value === undefined) return 'нет данных';
  return formatAuditValue(value);
}

function formatStringValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'пусто';

  const maybeDate = Date.parse(trimmed);
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) && Number.isFinite(maybeDate)) {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(trimmed));
  }

  return trimmed;
}

function manualSvgFileKindLabel(kind: string | undefined): string {
  if (kind === 'svg') return 'SVG';
  if (kind === 'gcode') return 'G-code';
  if (kind === 'screenshot') return 'скрин';
  return 'файл';
}

function formatDisplayNumber(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '—';
  if (normalized.startsWith('№')) return normalized;
  if (normalized.startsWith('#')) {
    const withoutHash = normalized.slice(1).trim();
    return withoutHash ? `№${withoutHash}` : normalized;
  }
  return `№${normalized}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 Б';
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / 1024 / 1024).toFixed(1)} МБ`;
}

function humanizeEvent(event: string): string {
  const readable = event.split('.').map(humanizeToken).filter(Boolean).join(': ');
  return readable ? `Выполнено действие — ${readable}` : 'Выполнено действие';
}

function humanizeToken(value: string): string {
  const withSpaces = value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2')
    .trim()
    .toLocaleLowerCase('ru-RU');
  return withSpaces.charAt(0).toLocaleUpperCase('ru-RU') + withSpaces.slice(1);
}

function isTechnicalField(field: string): boolean {
  if (TECHNICAL_FIELD_NAMES.has(field)) return true;
  const normalized = field.toLocaleLowerCase('ru-RU');
  return TECHNICAL_FIELD_PARTS.some((part) => normalized.includes(part));
}

function isDiffPair(value: unknown): value is { before: unknown; after: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'before' in value || 'after' in value;
}

function objectOrEmpty(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function numericArray(value: unknown): Array<number | string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((item): item is number | string => typeof item === 'number' || typeof item === 'string');
  return ids.length > 0 ? ids : undefined;
}

function detailLabels(record: AuditLogEventDto, metadata: JsonObject): Map<string, string> {
  const labels = new Map<string, string>();

  const recordDetailId = isDetailEntityType(record.entityType) ? numericEntityId(record.entityId) : undefined;
  if (recordDetailId != null) {
    labels.set(
      String(recordDetailId),
      detailEntityLabel(recordDetailId, record.entityDetailNumber ?? numberValue(metadata.detailNumber))
    );
  }

  const metadataDetailId = numberValue(metadata.detailId);
  if (metadataDetailId != null && !labels.has(String(metadataDetailId))) {
    labels.set(String(metadataDetailId), detailEntityLabel(metadataDetailId, numberValue(metadata.detailNumber)));
  }

  for (const entity of record.relatedEntities ?? []) {
    if (!isDetailEntityType(entity.entityType)) continue;
    labels.set(String(entity.entityId), detailEntityLabel(entity.entityId, entity.detailNumber));
  }

  return labels;
}

function formatDetailIdList(ids: Array<number | string>, labelsById: Map<string, string>): string {
  const visible = ids.slice(0, 8).map((id) => labelsById.get(String(id)) ?? `#${String(id)}`);
  const suffix = ids.length > visible.length ? ` и ещё ${ids.length - visible.length}` : '';
  return `${visible.join(', ')}${suffix}`;
}

function formatIdList(ids: Array<number | string>): string {
  const visible = ids.slice(0, 8).map((id) => `#${String(id)}`);
  const suffix = ids.length > visible.length ? ` и ещё ${ids.length - visible.length}` : '';
  return `${visible.join(', ')}${suffix}`;
}

function dedupeChanges(changes: AuditReadableChange[]): AuditReadableChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.label}|${change.before}|${change.after}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
