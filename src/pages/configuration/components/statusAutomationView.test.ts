import { describe, expect, it } from 'vitest';
import type {
  StatusAutomationEventTypeDto,
  StatusAutomationRuleDto,
} from '../../../api/types/statusAutomationApi.types';
import {
  allowedConditionKeysForEvent,
  buildCreatePayload,
  buildUpdatePayload,
  describeConditions,
  type StatusAutomationFormValues,
} from './statusAutomationView';

const catalogs = {
  orderStatusNames: new Map([
    [1, 'Новый'],
    [2, 'Оплачен'],
  ]),
  paymentStatusNames: new Map([[3, 'Частично оплачен']]),
  productionStatusNames: new Map([[4, 'В работе']]),
};

const baseForm: StatusAutomationFormValues = {
  name: 'Автоматическое правило',
  eventType: 'payment.created',
  actionType: 'change_order_status',
  targetStatusId: 2,
  currentOrderStatusIn: [],
  currentOrderStatusNotIn: [],
  currentPaymentStatusIn: [],
  currentPaymentStatusNotIn: [],
  currentProductionStatusIn: [],
  currentProductionStatusNotIn: [],
  paidShareGte: undefined,
  orderSourceIn: [],
  firstPaymentOnly: undefined,
  priority: 100,
  isEnabled: false,
};

const eventDescriptor = (overrides: Partial<StatusAutomationEventTypeDto> = {}): StatusAutomationEventTypeDto => ({
  eventType: 'payment.created',
  title: 'Платёж создан',
  allowedConditions: [
    'currentOrderStatusIn',
    'currentOrderStatusNotIn',
    'currentPaymentStatusIn',
    'currentPaymentStatusNotIn',
    'currentProductionStatusIn',
    'currentProductionStatusNotIn',
    'paidShareGte',
    'orderSourceIn',
    'firstPaymentOnly',
  ],
  allowedActions: ['change_order_status', 'change_production_status'],
  ...overrides,
});

const rule: StatusAutomationRuleDto = {
  id: 12,
  name: 'Существующее правило',
  eventType: 'order.created',
  actionType: 'change_production_status',
  targetStatusId: 4,
  conditions: {},
  priority: 50,
  isEnabled: true,
  version: 7,
};

describe('statusAutomationView', () => {
  it('describes every supported condition and renders unknown status ids as #id', () => {
    expect(
      describeConditions(
        {
          currentOrderStatusIn: [1, 999],
          currentOrderStatusNotIn: [2],
          currentPaymentStatusIn: [3],
          currentPaymentStatusNotIn: [777],
          currentProductionStatusIn: [4, 998],
          currentProductionStatusNotIn: [4],
          paidShareGte: 50,
          orderSourceIn: ['bazis'],
          firstPaymentOnly: true,
        },
        catalogs,
      ),
    ).toBe(
      'Статус заказа: Новый, #999; Исключить статус заказа: Оплачен; Статус оплаты: Частично оплачен; Исключить статус оплаты: #777; Статус производства: В работе, #998; Исключить статус производства: В работе; Оплачено ≥ 50%; Источник: Базис; Только первый платёж',
    );
  });

  it('returns an em dash for empty conditions and ignores empty arrays/false-only flags', () => {
    expect(
      describeConditions(
        {
          currentOrderStatusIn: [],
          currentOrderStatusNotIn: [],
          currentPaymentStatusIn: [],
          currentPaymentStatusNotIn: [],
          currentProductionStatusIn: [],
          currentProductionStatusNotIn: [],
          orderSourceIn: [],
          firstPaymentOnly: false,
        },
        catalogs,
      ),
    ).toBe('—');
    expect(describeConditions(undefined, catalogs)).toBe('—');
  });

  it('filters condition keys by the event descriptor', () => {
    expect(allowedConditionKeysForEvent(null)).toEqual([]);
    expect(allowedConditionKeysForEvent(eventDescriptor())).toEqual([
      'currentOrderStatusIn',
      'currentOrderStatusNotIn',
      'currentPaymentStatusIn',
      'currentPaymentStatusNotIn',
      'currentProductionStatusIn',
      'currentProductionStatusNotIn',
      'paidShareGte',
      'orderSourceIn',
      'firstPaymentOnly',
    ]);
    expect(
      allowedConditionKeysForEvent(
        eventDescriptor({
          eventType: 'order.created',
          allowedConditions: ['currentOrderStatusIn', 'paidShareGte'],
        }),
      ),
    ).toEqual(['currentOrderStatusIn', 'paidShareGte']);
  });

  it('builds a create payload without empty condition values', () => {
    expect(
      buildCreatePayload({
        ...baseForm,
        paidShareGte: 0,
        firstPaymentOnly: false,
        currentOrderStatusIn: [1],
        currentOrderStatusNotIn: [2],
        orderSourceIn: [],
      }),
    ).toEqual({
      name: 'Автоматическое правило',
      eventType: 'payment.created',
      actionType: 'change_order_status',
      targetStatusId: 2,
      conditions: {
        currentOrderStatusIn: [1],
        currentOrderStatusNotIn: [2],
        paidShareGte: 0,
        firstPaymentOnly: false,
      },
      priority: 100,
      isEnabled: false,
    });
  });

  it('builds an update payload and forwards the rule version', () => {
    expect(
      buildUpdatePayload(
        rule,
        {
          ...baseForm,
          name: 'Обновлённое правило',
          eventType: 'order.created',
          actionType: 'change_production_status',
          targetStatusId: 4,
          currentProductionStatusIn: [4],
          currentProductionStatusNotIn: [999],
          priority: 10,
          isEnabled: true,
        },
      ),
    ).toEqual({
      name: 'Обновлённое правило',
      eventType: 'order.created',
      actionType: 'change_production_status',
      targetStatusId: 4,
      conditions: { currentProductionStatusIn: [4], currentProductionStatusNotIn: [999] },
      priority: 10,
      isEnabled: true,
      version: 7,
    });
  });

  it('preserves all non-empty condition values in a create payload', () => {
    expect(
      buildCreatePayload({
        ...baseForm,
        currentOrderStatusIn: [1],
        currentOrderStatusNotIn: [2],
        currentPaymentStatusIn: [3],
        currentPaymentStatusNotIn: [5],
        currentProductionStatusIn: [4],
        currentProductionStatusNotIn: [6],
        paidShareGte: 50,
        orderSourceIn: ['manual', 'bazis', 'import'],
        firstPaymentOnly: true,
      }).conditions,
    ).toEqual({
      currentOrderStatusIn: [1],
      currentOrderStatusNotIn: [2],
      currentPaymentStatusIn: [3],
      currentPaymentStatusNotIn: [5],
      currentProductionStatusIn: [4],
      currentProductionStatusNotIn: [6],
      paidShareGte: 50,
      orderSourceIn: ['manual', 'bazis', 'import'],
      firstPaymentOnly: true,
    });
  });
});
