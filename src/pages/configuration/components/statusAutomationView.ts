import type {
  CreateStatusAutomationRuleRequest,
  StatusAutomationActionType,
  StatusAutomationConditionsDto,
  StatusAutomationEventType,
  StatusAutomationEventTypeDto,
  StatusAutomationOrderSource,
  StatusAutomationRuleDto,
  UpdateStatusAutomationRuleRequest,
} from '../../../api/types/statusAutomationApi.types';

export interface StatusAutomationCatalogs {
  orderStatusNames: Map<number, string>;
  paymentStatusNames: Map<number, string>;
  productionStatusNames: Map<number, string>;
}

export interface StatusAutomationFormValues {
  name: string;
  eventType: StatusAutomationEventType;
  actionType: StatusAutomationActionType;
  targetStatusId: number;
  currentOrderStatusIn?: number[];
  currentPaymentStatusIn?: number[];
  currentProductionStatusIn?: number[];
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

export function describeConditions(
  conditions: StatusAutomationConditionsDto | undefined,
  catalogs: StatusAutomationCatalogs,
): string {
  const parts: string[] = [];
  const current = conditions ?? {};

  if (current.currentOrderStatusIn?.length) {
    parts.push(`Статус заказа: ${formatStatusIds(current.currentOrderStatusIn, catalogs.orderStatusNames)}`);
  }
  if (current.currentPaymentStatusIn?.length) {
    parts.push(`Статус оплаты: ${formatStatusIds(current.currentPaymentStatusIn, catalogs.paymentStatusNames)}`);
  }
  if (current.currentProductionStatusIn?.length) {
    parts.push(
      `Статус производства: ${formatStatusIds(
        current.currentProductionStatusIn,
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
  if (form.currentPaymentStatusIn?.length) {
    conditions.currentPaymentStatusIn = [...form.currentPaymentStatusIn];
  }
  if (form.currentProductionStatusIn?.length) {
    conditions.currentProductionStatusIn = [...form.currentProductionStatusIn];
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
  return {
    name: form.name,
    eventType: form.eventType,
    actionType: form.actionType,
    targetStatusId: form.targetStatusId,
    conditions: buildConditions(form),
    priority: form.priority,
    isEnabled: form.isEnabled,
  };
}

export function buildUpdatePayload(
  rule: StatusAutomationRuleDto,
  form: StatusAutomationFormValues,
): UpdateStatusAutomationRuleRequest {
  return {
    name: form.name,
    eventType: form.eventType,
    actionType: form.actionType,
    targetStatusId: form.targetStatusId,
    conditions: buildConditions(form),
    priority: form.priority,
    isEnabled: form.isEnabled,
    version: rule.version,
  };
}

