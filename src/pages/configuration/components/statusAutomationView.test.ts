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
  currentPaymentStatusIn: [],
  currentProductionStatusIn: [],
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
    'currentPaymentStatusIn',
    'currentProductionStatusIn',
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
          currentPaymentStatusIn: [3],
          currentProductionStatusIn: [4, 998],
          paidShareGte: 50,
          orderSourceIn: ['bazis'],
          firstPaymentOnly: true,
        },
        catalogs,
      ),
    ).toBe(
      'Статус заказа: Новый, #999; Статус оплаты: Частично оплачен; Статус производства: В работе, #998; Оплачено ≥ 50%; Источник: Базис; Только первый платёж',
    );
  });

  it('returns an em dash for empty conditions and ignores empty arrays/false-only flags', () => {
    expect(
      describeConditions(
        {
          currentOrderStatusIn: [],
          currentPaymentStatusIn: [],
          currentProductionStatusIn: [],
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
      'currentPaymentStatusIn',
      'currentProductionStatusIn',
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
        orderSourceIn: [],
      }),
    ).toEqual({
      name: 'Автоматическое правило',
      eventType: 'payment.created',
      actionType: 'change_order_status',
      targetStatusId: 2,
      conditions: {
        currentOrderStatusIn: [1],
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
          priority: 10,
          isEnabled: true,
        },
      ),
    ).toEqual({
      name: 'Обновлённое правило',
      eventType: 'order.created',
      actionType: 'change_production_status',
      targetStatusId: 4,
      conditions: { currentProductionStatusIn: [4] },
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
        currentPaymentStatusIn: [3],
        currentProductionStatusIn: [4],
        paidShareGte: 50,
        orderSourceIn: ['manual', 'bazis', 'import'],
        firstPaymentOnly: true,
      }).conditions,
    ).toEqual({
      currentOrderStatusIn: [1],
      currentPaymentStatusIn: [3],
      currentProductionStatusIn: [4],
      paidShareGte: 50,
      orderSourceIn: ['manual', 'bazis', 'import'],
      firstPaymentOnly: true,
    });
  });
});
