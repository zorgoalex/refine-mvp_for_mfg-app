import type {
  CreateStatusAutomationRuleRequest,
  StatusAutomationActionType,
  StatusAutomationConditionsDto,
  StatusAutomationEventType,
  StatusAutomationEventTypeDto,
  StatusAutomationOrderSource,
  StatusAutomationRuleDto,
  StatusAutomationStatusMappingEntryDto,
  UpdateStatusAutomationRuleRequest,
} from '../../../api/types/statusAutomationApi.types';

export interface StatusAutomationEventSelectGroup {
  label: string;
  options: Array<{ value: StatusAutomationEventType; label: string }>;
}

const EVENT_GROUPS = [
  { key: 'order', label: 'Заказ' },
  { key: 'dates', label: 'Даты' },
  { key: 'statuses', label: 'Статусы' },
  { key: 'production', label: 'Производство' },
  { key: 'payments', label: 'Оплаты' },
  { key: 'other', label: 'Другие' },
] as const;

const LEGACY_EVENT_GROUPS: Partial<Record<StatusAutomationEventType, Exclude<(typeof EVENT_GROUPS)[number]['key'], 'other'>>> = {
  'order.created': 'order',
  'order.updated': 'order',
  'order.planned_completion_date_changed': 'dates',
  'order.status_changed': 'statuses',
  'order.production_status_changed': 'statuses',
  'mdf.order_machine_files_present': 'production',
  'payment.created': 'payments',
  'order.payment_status_changed': 'payments',
};

export function buildEventTypeSelectOptions(
  eventTypes: readonly StatusAutomationEventTypeDto[],
): StatusAutomationEventSelectGroup[] {
  return EVENT_GROUPS.map((group) => ({
    label: group.label,
    options: eventTypes
      .filter((eventType) => (eventType.group ?? LEGACY_EVENT_GROUPS[eventType.eventType] ?? 'other') === group.key)
      .map((eventType) => ({ value: eventType.eventType, label: eventType.title })),
  })).filter((group) => group.options.length > 0);
}

export interface StatusAutomationCatalogs {
  orderStatusNames: Map<number, string>;
  paymentStatusNames: Map<number, string>;
  productionStatusNames: Map<number, string>;
}

export interface StatusAutomationStatusCatalog {
  orderStatusIds: ReadonlySet<number>;
  activeOrderStatusIds: ReadonlySet<number>;
  paymentStatusIds: ReadonlySet<number>;
  productionStatusIds: ReadonlySet<number>;
  activeProductionStatusIds: ReadonlySet<number>;
}

export interface StatusAutomationRulesExportFile {
  schema: 'erp.statusAutomationRules.v1';
  exportedAt: string;
  rules: CreateStatusAutomationRuleRequest[];
}

export interface StatusAutomationImportIssue {
  index: number;
  name: string;
  reasons: string[];
}

export interface StatusAutomationImportReadyRule {
  index: number;
  name: string;
  rule: CreateStatusAutomationRuleRequest;
}

export interface StatusAutomationImportPlan {
  rulesToCreate: StatusAutomationImportReadyRule[];
  skippedDuplicates: StatusAutomationImportIssue[];
  failedRules: StatusAutomationImportIssue[];
}

export interface StatusAutomationFormValues {
  name: string;
  eventType: StatusAutomationEventType;
  actionType: StatusAutomationActionType;
  targetStatusId: number | null;
  statusMappingEntries?: StatusAutomationStatusMappingEntryDto[];
  currentOrderStatusIn?: number[];
  currentOrderStatusNotIn?: number[];
  currentPaymentStatusIn?: number[];
  currentPaymentStatusNotIn?: number[];
  currentProductionStatusIn?: number[];
  currentProductionStatusNotIn?: number[];
  paidShareGte?: number;
  orderSourceIn?: StatusAutomationOrderSource[];
  firstPaymentOnly?: boolean;
  priority: number;
  isEnabled: boolean;
}

const ORDER_SOURCE_LABELS: Record<StatusAutomationOrderSource, string> = {
  manual: 'Вручную',
  bazis: 'Базис',
  import: 'Импорт',
};

const CONDITION_KEYS = [
  'currentOrderStatusIn',
  'currentOrderStatusNotIn',
  'currentPaymentStatusIn',
  'currentPaymentStatusNotIn',
  'currentProductionStatusIn',
  'currentProductionStatusNotIn',
  'paidShareGte',
  'orderSourceIn',
  'firstPaymentOnly',
] as const;

const ACTION_TYPES: StatusAutomationActionType[] = [
  'change_order_status',
  'change_production_status',
  'change_details_production_status',
  'map_order_status_to_details_production_status',
  'map_production_status_to_order_status',
];

export function isStatusMappingAction(actionType: StatusAutomationActionType): boolean {
  return actionType === 'map_order_status_to_details_production_status' ||
    actionType === 'map_production_status_to_order_status';
}

export function describeAction(
  rule: StatusAutomationRuleDto,
  catalogs: StatusAutomationCatalogs,
): string {
  if (isStatusMappingAction(rule.actionType)) {
    const sourceNames = rule.actionType === 'map_order_status_to_details_production_status'
      ? catalogs.orderStatusNames
      : catalogs.productionStatusNames;
    const targetNames = rule.actionType === 'map_order_status_to_details_production_status'
      ? catalogs.productionStatusNames
      : catalogs.orderStatusNames;
    return (rule.actionConfig?.statusMapping?.entries ?? [])
      .map((entry) => `${formatStatusIds(entry.sourceStatusIds, sourceNames)} → ${targetNames.get(entry.targetStatusId) ?? `#${entry.targetStatusId}`}`)
      .join('; ');
  }
  const targetNames = rule.actionType === 'change_order_status'
    ? catalogs.orderStatusNames
    : catalogs.productionStatusNames;
  return `${targetNames.get(rule.targetStatusId ?? 0) ?? `#${rule.targetStatusId ?? '?'}`}`;
}

const ORDER_SOURCES: StatusAutomationOrderSource[] = ['manual', 'bazis', 'import'];

export function describeConditions(
  conditions: StatusAutomationConditionsDto | undefined,
  catalogs: StatusAutomationCatalogs,
): string {
  const parts: string[] = [];
  const current = conditions ?? {};

  if (current.currentOrderStatusIn?.length) {
    parts.push(`Статус заказа: ${formatStatusIds(current.currentOrderStatusIn, catalogs.orderStatusNames)}`);
  }
  if (current.currentOrderStatusNotIn?.length) {
    parts.push(
      `Исключить статус заказа: ${formatStatusIds(
        current.currentOrderStatusNotIn,
        catalogs.orderStatusNames,
      )}`,
    );
  }
  if (current.currentPaymentStatusIn?.length) {
    parts.push(`Статус оплаты: ${formatStatusIds(current.currentPaymentStatusIn, catalogs.paymentStatusNames)}`);
  }
  if (current.currentPaymentStatusNotIn?.length) {
    parts.push(
      `Исключить статус оплаты: ${formatStatusIds(
        current.currentPaymentStatusNotIn,
        catalogs.paymentStatusNames,
      )}`,
    );
  }
  if (current.currentProductionStatusIn?.length) {
    parts.push(
      `Статус производства: ${formatStatusIds(
        current.currentProductionStatusIn,
        catalogs.productionStatusNames,
      )}`,
    );
  }
  if (current.currentProductionStatusNotIn?.length) {
    parts.push(
      `Исключить статус производства: ${formatStatusIds(
        current.currentProductionStatusNotIn,
        catalogs.productionStatusNames,
      )}`,
    );
  }
  if (current.paidShareGte !== undefined) {
    parts.push(`Оплачено ≥ ${current.paidShareGte}%`);
  }
  if (current.orderSourceIn?.length) {
    parts.push(
      `Источник: ${current.orderSourceIn
        .map((source) => ORDER_SOURCE_LABELS[source] ?? source)
        .join(', ')}`,
    );
  }
  if (current.firstPaymentOnly === true) {
    parts.push('Только первый платёж');
  }

  return parts.length > 0 ? parts.join('; ') : '—';
}

function formatStatusIds(ids: number[], names: Map<number, string>): string {
  return ids.map((id) => names.get(id) ?? `#${id}`).join(', ');
}

export function allowedConditionKeysForEvent(
  descriptor: StatusAutomationEventTypeDto | null,
): string[] {
  return descriptor ? [...descriptor.allowedConditions] : [];
}

function buildConditions(form: StatusAutomationFormValues): StatusAutomationConditionsDto {
  const conditions: StatusAutomationConditionsDto = {};

  if (form.currentOrderStatusIn?.length) {
    conditions.currentOrderStatusIn = [...form.currentOrderStatusIn];
  }
  if (form.currentOrderStatusNotIn?.length) {
    conditions.currentOrderStatusNotIn = [...form.currentOrderStatusNotIn];
  }
  if (form.currentPaymentStatusIn?.length) {
    conditions.currentPaymentStatusIn = [...form.currentPaymentStatusIn];
  }
  if (form.currentPaymentStatusNotIn?.length) {
    conditions.currentPaymentStatusNotIn = [...form.currentPaymentStatusNotIn];
  }
  if (form.currentProductionStatusIn?.length) {
    conditions.currentProductionStatusIn = [...form.currentProductionStatusIn];
  }
  if (form.currentProductionStatusNotIn?.length) {
    conditions.currentProductionStatusNotIn = [...form.currentProductionStatusNotIn];
  }
  if (form.paidShareGte !== undefined) {
    conditions.paidShareGte = form.paidShareGte;
  }
  if (form.orderSourceIn?.length) {
    conditions.orderSourceIn = [...form.orderSourceIn];
  }
  if (form.firstPaymentOnly !== undefined) {
    conditions.firstPaymentOnly = form.firstPaymentOnly;
  }

  return conditions;
}

export function buildCreatePayload(
  form: StatusAutomationFormValues,
): CreateStatusAutomationRuleRequest {
  const actionConfig = buildActionConfig(form);
  return {
    name: form.name,
    eventType: form.eventType,
    actionType: form.actionType,
    targetStatusId: isStatusMappingAction(form.actionType) ? null : form.targetStatusId,
    conditions: buildConditions(form),
    ...(actionConfig ? { actionConfig } : {}),
    priority: form.priority,
    isEnabled: form.isEnabled,
  };
}

export function buildUpdatePayload(
  rule: StatusAutomationRuleDto,
  form: StatusAutomationFormValues,
): UpdateStatusAutomationRuleRequest {
  const actionConfig = buildActionConfig(form);
  return {
    name: form.name,
    eventType: form.eventType,
    actionType: form.actionType,
    targetStatusId: isStatusMappingAction(form.actionType) ? null : form.targetStatusId,
    conditions: buildConditions(form),
    ...(actionConfig ? { actionConfig } : {}),
    priority: form.priority,
    isEnabled: form.isEnabled,
    version: rule.version,
  };
}

function buildActionConfig(form: StatusAutomationFormValues) {
  return isStatusMappingAction(form.actionType)
    ? { statusMapping: { entries: (form.statusMappingEntries ?? []).map((entry) => ({ ...entry, sourceStatusIds: [...entry.sourceStatusIds] })) } }
    : undefined;
}

export function buildStatusAutomationRulesExportFile(
  rules: readonly StatusAutomationRuleDto[],
  exportedAt = new Date().toISOString(),
): StatusAutomationRulesExportFile {
  return {
    schema: 'erp.statusAutomationRules.v1',
    exportedAt,
    rules: rules.map((rule) => ({
      name: rule.name,
      eventType: rule.eventType,
      actionType: rule.actionType,
      targetStatusId: rule.targetStatusId,
      conditions: normalizeConditionsForExport(rule.conditions),
      ...(rule.actionConfig?.statusMapping ? { actionConfig: rule.actionConfig } : {}),
      priority: rule.priority,
      isEnabled: rule.isEnabled,
    })),
  };
}

export function readStatusAutomationRulesImportSource(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.rules)) {
    return value.rules;
  }
  throw new Error('JSON должен содержать массив правил или объект с полем rules');
}

export function planStatusAutomationRulesImport(
  rawRules: readonly unknown[],
  context: {
    existingRules: readonly StatusAutomationRuleDto[];
    eventTypes: readonly StatusAutomationEventTypeDto[];
    statusCatalog: StatusAutomationStatusCatalog;
  },
): StatusAutomationImportPlan {
  const existingSignatures = new Set(
    context.existingRules.map((rule) => statusAutomationRuleSignature(rule)),
  );
  const incomingSignatures = new Set<string>();
  const rulesToCreate: StatusAutomationImportReadyRule[] = [];
  const skippedDuplicates: StatusAutomationImportIssue[] = [];
  const failedRules: StatusAutomationImportIssue[] = [];
  const eventTypeByName = new Map(context.eventTypes.map((eventType) => [eventType.eventType, eventType]));

  rawRules.forEach((rawRule, rawIndex) => {
    const index = rawIndex + 1;
    const parsed = parseImportedStatusAutomationRule(rawRule);
    const name = parsed.rule?.name ?? `Правило ${index}`;
    if (parsed.errors.length > 0 || !parsed.rule) {
      failedRules.push({ index, name, reasons: parsed.errors });
      return;
    }

    const validationErrors = validateImportedStatusAutomationRule(
      parsed.rule,
      eventTypeByName,
      context.statusCatalog,
    );
    if (validationErrors.length > 0) {
      failedRules.push({ index, name, reasons: validationErrors });
      return;
    }

    const signature = statusAutomationRuleSignature(parsed.rule);
    if (existingSignatures.has(signature)) {
      skippedDuplicates.push({ index, name, reasons: ['Такое правило уже есть в текущем приложении'] });
      return;
    }
    if (incomingSignatures.has(signature)) {
      skippedDuplicates.push({ index, name, reasons: ['Такое правило уже есть в этом JSON-файле'] });
      return;
    }

    incomingSignatures.add(signature);
    rulesToCreate.push({ index, name, rule: parsed.rule });
  });

  return { rulesToCreate, skippedDuplicates, failedRules };
}

export function statusAutomationRuleSignature(
  rule: Pick<
    CreateStatusAutomationRuleRequest,
    'eventType' | 'actionType' | 'targetStatusId' | 'conditions' | 'actionConfig' | 'priority' | 'isEnabled'
  >,
): string {
  return JSON.stringify({
    eventType: rule.eventType,
    actionType: rule.actionType,
    targetStatusId: rule.targetStatusId,
    conditions: normalizeConditionsForExport(rule.conditions ?? {}),
    actionConfig: rule.actionConfig ?? {},
    priority: rule.priority ?? 100,
    isEnabled: rule.isEnabled ?? false,
  });
}

function parseImportedStatusAutomationRule(
  rawRule: unknown,
): { rule: CreateStatusAutomationRuleRequest | null; errors: string[] } {
  if (!isRecord(rawRule)) {
    return { rule: null, errors: ['Правило должно быть JSON-объектом'] };
  }

  const errors: string[] = [];
  const name = typeof rawRule.name === 'string' ? rawRule.name.trim() : '';
  if (!name) errors.push('Не указано название правила');
  if (name.length > 200) errors.push('Название правила длиннее 200 символов');

  const eventType = typeof rawRule.eventType === 'string' ? rawRule.eventType.trim() : '';
  if (!eventType) errors.push('Не указано событие');

  const actionType = rawRule.actionType;
  if (!isStatusAutomationActionType(actionType)) {
    errors.push('Не указано допустимое действие правила');
  }

  const mappingAction = isStatusAutomationActionType(actionType) && isStatusMappingAction(actionType);
  const targetStatusId = mappingAction ? null : toPositiveInteger(rawRule.targetStatusId);
  if (!mappingAction && targetStatusId === null) {
    errors.push('Не указан целевой статус');
  }
  const actionConfigResult = parseImportedActionConfig(rawRule.actionConfig, mappingAction);
  errors.push(...actionConfigResult.errors);

  const priority = rawRule.priority === undefined ? 100 : toInteger(rawRule.priority);
  if (priority === null) {
    errors.push('Приоритет должен быть целым числом');
  }

  const isEnabled =
    rawRule.isEnabled === undefined
      ? false
      : typeof rawRule.isEnabled === 'boolean'
        ? rawRule.isEnabled
        : null;
  if (isEnabled === null) {
    errors.push('Поле isEnabled должно быть boolean');
  }

  const conditionsResult = parseImportedConditions(rawRule.conditions);
  errors.push(...conditionsResult.errors);

  if (
    errors.length > 0 ||
    !eventType ||
    !isStatusAutomationActionType(actionType) ||
    (!mappingAction && targetStatusId === null) ||
    priority === null ||
    isEnabled === null ||
    !conditionsResult.conditions
  ) {
    return { rule: null, errors };
  }

  return {
    rule: {
      name,
      eventType: eventType as StatusAutomationEventType,
      actionType,
      targetStatusId,
      conditions: conditionsResult.conditions,
      ...(actionConfigResult.actionConfig ? { actionConfig: actionConfigResult.actionConfig } : {}),
      priority,
      isEnabled,
    },
    errors: [],
  };
}

function parseImportedActionConfig(
  rawConfig: unknown,
  mappingAction: boolean,
): { actionConfig: CreateStatusAutomationRuleRequest['actionConfig']; errors: string[] } {
  if (!mappingAction) return { actionConfig: undefined, errors: [] };
  if (!isRecord(rawConfig) || !isRecord(rawConfig.statusMapping) || !Array.isArray(rawConfig.statusMapping.entries)) {
    return { actionConfig: undefined, errors: ['Не указан маппинг статусов'] };
  }

  const errors: string[] = [];
  const seen = new Set<number>();
  const entries = rawConfig.statusMapping.entries.flatMap((rawEntry, index) => {
    if (!isRecord(rawEntry)) {
      errors.push(`Строка маппинга ${index + 1} должна быть объектом`);
      return [];
    }
    const sources = parsePositiveIntegerArray(rawEntry.sourceStatusIds, `Строка маппинга ${index + 1}`);
    errors.push(...sources.errors);
    const target = toPositiveInteger(rawEntry.targetStatusId);
    if (sources.value.length === 0) errors.push(`Строка маппинга ${index + 1}: нет исходных статусов`);
    if (target === null) errors.push(`Строка маппинга ${index + 1}: нет целевого статуса`);
    for (const source of sources.value) {
      if (seen.has(source)) errors.push(`Исходный статус #${source} указан несколько раз`);
      seen.add(source);
    }
    return target === null ? [] : [{ sourceStatusIds: sources.value, targetStatusId: target }];
  });
  if (entries.length === 0) errors.push('Маппинг должен содержать хотя бы одну строку');
  return {
    actionConfig: errors.length === 0 ? { statusMapping: { entries } } : undefined,
    errors,
  };
}

function parseImportedConditions(
  rawConditions: unknown,
): { conditions: StatusAutomationConditionsDto | null; errors: string[] } {
  if (rawConditions === undefined || rawConditions === null) {
    return { conditions: {}, errors: [] };
  }
  if (!isRecord(rawConditions)) {
    return { conditions: null, errors: ['Условия должны быть JSON-объектом'] };
  }

  const errors: string[] = [];
  const unknownKeys = Object.keys(rawConditions).filter(
    (key) => !(CONDITION_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    errors.push(`Неизвестные условия: ${unknownKeys.join(', ')}`);
  }

  const conditions: StatusAutomationConditionsDto = {};
  const statusArrays: Array<[keyof StatusAutomationConditionsDto, unknown]> = [
    ['currentOrderStatusIn', rawConditions.currentOrderStatusIn],
    ['currentOrderStatusNotIn', rawConditions.currentOrderStatusNotIn],
    ['currentPaymentStatusIn', rawConditions.currentPaymentStatusIn],
    ['currentPaymentStatusNotIn', rawConditions.currentPaymentStatusNotIn],
    ['currentProductionStatusIn', rawConditions.currentProductionStatusIn],
    ['currentProductionStatusNotIn', rawConditions.currentProductionStatusNotIn],
  ];

  for (const [key, value] of statusArrays) {
    const parsed = parsePositiveIntegerArray(value, key);
    errors.push(...parsed.errors);
    if (parsed.value.length > 0) {
      assignStatusArrayCondition(conditions, key, parsed.value);
    }
  }

  if (rawConditions.paidShareGte !== undefined) {
    const paidShareGte = toNumber(rawConditions.paidShareGte);
    if (paidShareGte === null || paidShareGte < 0 || paidShareGte > 100) {
      errors.push('Доля оплаты должна быть числом от 0 до 100');
    } else {
      conditions.paidShareGte = paidShareGte;
    }
  }

  if (rawConditions.orderSourceIn !== undefined) {
    if (!Array.isArray(rawConditions.orderSourceIn)) {
      errors.push('Источник заказа должен быть массивом');
    } else {
      const invalidSources = rawConditions.orderSourceIn.filter(
        (source) => !isStatusAutomationOrderSource(source),
      );
      if (invalidSources.length > 0) {
        errors.push(`Неизвестные источники заказа: ${invalidSources.join(', ')}`);
      }
      const sources = uniqueByOrder(
        rawConditions.orderSourceIn.filter(isStatusAutomationOrderSource),
        ORDER_SOURCES,
      );
      if (sources.length > 0) {
        conditions.orderSourceIn = sources;
      }
    }
  }

  if (rawConditions.firstPaymentOnly !== undefined) {
    if (typeof rawConditions.firstPaymentOnly !== 'boolean') {
      errors.push('Поле firstPaymentOnly должно быть boolean');
    } else {
      conditions.firstPaymentOnly = rawConditions.firstPaymentOnly;
    }
  }

  return { conditions: errors.length > 0 ? null : conditions, errors };
}

function validateImportedStatusAutomationRule(
  rule: CreateStatusAutomationRuleRequest,
  eventTypeByName: ReadonlyMap<string, StatusAutomationEventTypeDto>,
  statusCatalog: StatusAutomationStatusCatalog,
): string[] {
  const errors: string[] = [];
  const descriptor = eventTypeByName.get(rule.eventType);
  if (!descriptor) {
    errors.push(`Событие «${rule.eventType}» отсутствует в текущем приложении`);
  } else {
    if (!descriptor.allowedActions.includes(rule.actionType)) {
      errors.push(`Действие «${rule.actionType}» не подходит для события «${descriptor.title}»`);
    }
    const allowedConditions = new Set(descriptor.allowedConditions);
    const invalidConditions = Object.keys(rule.conditions ?? {}).filter(
      (condition) => !allowedConditions.has(condition),
    );
    if (invalidConditions.length > 0) {
      errors.push(`Условия не подходят для события «${descriptor.title}»: ${invalidConditions.join(', ')}`);
    }
  }

  if (rule.actionType === 'map_order_status_to_details_production_status') {
    for (const entry of rule.actionConfig?.statusMapping?.entries ?? []) {
      pushMissingStatusErrors(errors, entry.sourceStatusIds, statusCatalog.orderStatusIds, 'исходные статусы заказа');
      pushMissingStatusErrors(errors, [entry.targetStatusId], statusCatalog.productionStatusIds, 'целевые статусы производства');
    }
  } else if (rule.actionType === 'map_production_status_to_order_status') {
    for (const entry of rule.actionConfig?.statusMapping?.entries ?? []) {
      pushMissingStatusErrors(errors, entry.sourceStatusIds, statusCatalog.productionStatusIds, 'исходные статусы производства');
      pushMissingStatusErrors(errors, [entry.targetStatusId], statusCatalog.orderStatusIds, 'целевые статусы заказа');
    }
  } else if (rule.actionType === 'change_order_status' && rule.targetStatusId !== null) {
    if (!statusCatalog.orderStatusIds.has(rule.targetStatusId)) {
      errors.push(`Целевой статус заказа #${rule.targetStatusId} отсутствует`);
    } else if (!statusCatalog.activeOrderStatusIds.has(rule.targetStatusId)) {
      errors.push(`Целевой статус заказа #${rule.targetStatusId} неактивен`);
    }
  } else if (rule.targetStatusId !== null && !statusCatalog.productionStatusIds.has(rule.targetStatusId)) {
    errors.push(`Целевой производственный статус #${rule.targetStatusId} отсутствует`);
  } else if (rule.targetStatusId !== null && !statusCatalog.activeProductionStatusIds.has(rule.targetStatusId)) {
    errors.push(`Целевой производственный статус #${rule.targetStatusId} неактивен`);
  }

  const conditions = rule.conditions ?? {};
  pushMissingStatusErrors(errors, conditions.currentOrderStatusIn, statusCatalog.orderStatusIds, 'статусы заказа');
  pushMissingStatusErrors(errors, conditions.currentOrderStatusNotIn, statusCatalog.orderStatusIds, 'исключающие статусы заказа');
  pushMissingStatusErrors(errors, conditions.currentPaymentStatusIn, statusCatalog.paymentStatusIds, 'статусы оплаты');
  pushMissingStatusErrors(errors, conditions.currentPaymentStatusNotIn, statusCatalog.paymentStatusIds, 'исключающие статусы оплаты');
  pushMissingStatusErrors(errors, conditions.currentProductionStatusIn, statusCatalog.productionStatusIds, 'статусы производства');
  pushMissingStatusErrors(errors, conditions.currentProductionStatusNotIn, statusCatalog.productionStatusIds, 'исключающие статусы производства');

  return errors;
}

function normalizeConditionsForExport(
  conditions: StatusAutomationConditionsDto | undefined,
): StatusAutomationConditionsDto {
  const normalized: StatusAutomationConditionsDto = {};
  if (conditions?.currentOrderStatusIn?.length) {
    normalized.currentOrderStatusIn = uniqueNumbers(conditions.currentOrderStatusIn);
  }
  if (conditions?.currentOrderStatusNotIn?.length) {
    normalized.currentOrderStatusNotIn = uniqueNumbers(conditions.currentOrderStatusNotIn);
  }
  if (conditions?.currentPaymentStatusIn?.length) {
    normalized.currentPaymentStatusIn = uniqueNumbers(conditions.currentPaymentStatusIn);
  }
  if (conditions?.currentPaymentStatusNotIn?.length) {
    normalized.currentPaymentStatusNotIn = uniqueNumbers(conditions.currentPaymentStatusNotIn);
  }
  if (conditions?.currentProductionStatusIn?.length) {
    normalized.currentProductionStatusIn = uniqueNumbers(conditions.currentProductionStatusIn);
  }
  if (conditions?.currentProductionStatusNotIn?.length) {
    normalized.currentProductionStatusNotIn = uniqueNumbers(conditions.currentProductionStatusNotIn);
  }
  if (conditions?.paidShareGte !== undefined) {
    normalized.paidShareGte = conditions.paidShareGte;
  }
  if (conditions?.orderSourceIn?.length) {
    normalized.orderSourceIn = uniqueByOrder(conditions.orderSourceIn, ORDER_SOURCES);
  }
  if (conditions?.firstPaymentOnly !== undefined) {
    normalized.firstPaymentOnly = conditions.firstPaymentOnly;
  }
  return normalized;
}

function pushMissingStatusErrors(
  errors: string[],
  ids: readonly number[] | undefined,
  availableIds: ReadonlySet<number>,
  label: string,
): void {
  const missingIds = (ids ?? []).filter((id) => !availableIds.has(id));
  if (missingIds.length > 0) {
    errors.push(`Отсутствуют ${label}: ${missingIds.map((id) => `#${id}`).join(', ')}`);
  }
}

function assignStatusArrayCondition(
  conditions: StatusAutomationConditionsDto,
  key: keyof StatusAutomationConditionsDto,
  value: number[],
): void {
  switch (key) {
    case 'currentOrderStatusIn':
      conditions.currentOrderStatusIn = value;
      return;
    case 'currentOrderStatusNotIn':
      conditions.currentOrderStatusNotIn = value;
      return;
    case 'currentPaymentStatusIn':
      conditions.currentPaymentStatusIn = value;
      return;
    case 'currentPaymentStatusNotIn':
      conditions.currentPaymentStatusNotIn = value;
      return;
    case 'currentProductionStatusIn':
      conditions.currentProductionStatusIn = value;
      return;
    case 'currentProductionStatusNotIn':
      conditions.currentProductionStatusNotIn = value;
      return;
    default:
      return;
  }
}

function parsePositiveIntegerArray(
  value: unknown,
  field: string,
): { value: number[]; errors: string[] } {
  if (value === undefined) {
    return { value: [], errors: [] };
  }
  if (!Array.isArray(value)) {
    return { value: [], errors: [`${field} должен быть массивом`] };
  }
  const parsed = value.map(toPositiveInteger);
  const invalid = parsed.some((item) => item === null);
  return {
    value: uniqueNumbers(parsed.filter((item): item is number => item !== null)),
    errors: invalid ? [`${field} должен содержать только положительные целые id`] : [],
  };
}

function uniqueNumbers(values: readonly number[]): number[] {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function uniqueByOrder<T extends string>(values: readonly T[], order: readonly T[]): T[] {
  const set = new Set(values);
  return order.filter((item) => set.has(item));
}

function isStatusAutomationActionType(value: unknown): value is StatusAutomationActionType {
  return typeof value === 'string' && (ACTION_TYPES as readonly string[]).includes(value);
}

function isStatusAutomationOrderSource(value: unknown): value is StatusAutomationOrderSource {
  return typeof value === 'string' && (ORDER_SOURCES as readonly string[]).includes(value);
}

function toPositiveInteger(value: unknown): number | null {
  const parsed = toInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function toInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
