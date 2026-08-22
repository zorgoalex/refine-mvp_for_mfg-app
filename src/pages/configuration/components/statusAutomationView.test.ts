import { describe, expect, it } from 'vitest';
import type {
  StatusAutomationEventTypeDto,
  StatusAutomationRuleDto,
} from '../../../api/types/statusAutomationApi.types';
import {
  addStatusAutomationCondition,
  allowedConditionKeysForEvent,
  buildCreatePayload,
  buildEventTypeSelectOptions,
  buildStatusAutomationRulesExportFile,
  buildUpdatePayload,
  changeStatusAutomationAction,
  changeStatusAutomationEvent,
  describeAction,
  describeConditions,
  describeFormAction,
  describeFormConditions,
  planStatusAutomationRulesImport,
  readStatusAutomationRulesImportSource,
  validateStatusAutomationRuleBuilder,
  type StatusAutomationFormValues,
  type StatusAutomationRuleBuilderState,
} from './statusAutomationView';

const catalogs = {
  orderStatusNames: new Map([
    [1, 'Новый'],
    [2, 'Оплачен'],
  ]),
  paymentStatusNames: new Map([[3, 'Частично оплачен']]),
  productionStatusNames: new Map([[4, 'В работе'], [5, 'Готово']]),
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

const importStatusCatalog = {
  orderStatusIds: new Set([1, 2]),
  activeOrderStatusIds: new Set([1, 2]),
  paymentStatusIds: new Set([3]),
  productionStatusIds: new Set([4, 5]),
  activeProductionStatusIds: new Set([4]),
};

describe('statusAutomationView', () => {
  it('groups event options in stable user-facing order', () => {
    expect(
      buildEventTypeSelectOptions([
        eventDescriptor({
          eventType: 'payment.created',
          title: 'Платёж создан',
          group: 'payments',
        }),
        eventDescriptor({
          eventType: 'order.planned_completion_date_changed',
          title: 'Изменилась плановая дата готовности',
          group: 'dates',
        }),
        eventDescriptor({ eventType: 'order.created', title: 'Заказ создан', group: 'order' }),
        eventDescriptor({
          eventType: 'order.status_changed',
          title: 'Изменился статус заказа',
          group: 'statuses',
        }),
        eventDescriptor({
          eventType: 'mdf.order_machine_files_present',
          title: 'Файлы заказа на станке',
          group: 'production',
        }),
      ]),
    ).toEqual([
      { label: 'Заказ', options: [{ value: 'order.created', label: 'Заказ создан' }] },
      {
        label: 'Даты',
        options: [
          {
            value: 'order.planned_completion_date_changed',
            label: 'Изменилась плановая дата готовности',
          },
        ],
      },
      {
        label: 'Статусы',
        options: [{ value: 'order.status_changed', label: 'Изменился статус заказа' }],
      },
      {
        label: 'Производство',
        options: [
          { value: 'mdf.order_machine_files_present', label: 'Файлы заказа на станке' },
        ],
      },
      { label: 'Оплаты', options: [{ value: 'payment.created', label: 'Платёж создан' }] },
    ]);
  });

  it('derives groups when an older backend omits group and description', () => {
    expect(
      buildEventTypeSelectOptions([
        eventDescriptor({ eventType: 'order.updated', title: 'Заказ сохранён' }),
        eventDescriptor({ eventType: 'order.payment_status_changed', title: 'Статус оплаты' }),
      ]),
    ).toEqual([
      { label: 'Заказ', options: [{ value: 'order.updated', label: 'Заказ сохранён' }] },
      {
        label: 'Оплаты',
        options: [{ value: 'order.payment_status_changed', label: 'Статус оплаты' }],
      },
    ]);
  });

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
      'Статус заказа — один из: Новый, #999; Статус заказа — не входит в: Оплачен; Статус оплаты — один из: Частично оплачен; Статус оплаты — не входит в: #777; Общий статус производства заказа — один из: В работе, #998; Общий статус производства заказа — не входит в: В работе; Оплачено ≥ 50%; Источник: Базис; Только первый платёж',
    );
  });

  it('describes empty conditions in plain language and ignores empty arrays/false-only flags', () => {
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
    ).toBe('Без условий');
    expect(describeConditions(undefined, catalogs)).toBe('Без условий');
  });

  it('builds a plain-language live preview from form values', () => {
    const form = {
      ...baseForm,
      currentOrderStatusIn: [1, 2],
      paidShareGte: 50,
    };

    expect(describeFormConditions(form, catalogs)).toBe(
      'Статус заказа — один из: Новый, Оплачен; Оплачено ≥ 50%',
    );
    expect(describeFormAction(form, catalogs)).toBe(
      'Установить заказу статус «Оплачен»',
    );
    expect(describeFormConditions(baseForm, catalogs)).toBe(
      'Без дополнительных условий',
    );
  });

  it('drives create/edit state through conditions, event pruning, and action switching', () => {
    let state: StatusAutomationRuleBuilderState = {
      form: { ...baseForm },
      activeConditionKeys: [],
    };

    state = addStatusAutomationCondition(state, 'currentOrderStatusIn');
    expect(validateStatusAutomationRuleBuilder(state, eventDescriptor())).toContain(
      'Заполните или удалите пустое условие',
    );

    state = { ...state, form: { ...state.form, currentOrderStatusIn: [1] } };
    expect(validateStatusAutomationRuleBuilder(state, eventDescriptor())).toEqual([]);
    expect(describeFormConditions(state.form, catalogs)).toBe('Статус заказа — один из: Новый');
    expect(buildCreatePayload(state.form).conditions).toEqual({ currentOrderStatusIn: [1] });
    expect(buildUpdatePayload(rule, state.form)).toMatchObject({
      conditions: { currentOrderStatusIn: [1] },
      version: 7,
    });

    state = changeStatusAutomationEvent(
      state,
      eventDescriptor({
        eventType: 'order.production_status_changed',
        allowedConditions: ['paidShareGte'],
        allowedActions: ['change_production_status'],
      }),
    );
    expect(state.activeConditionKeys).toEqual([]);
    expect(state.form.currentOrderStatusIn).toEqual([]);
    expect(state.form.actionType).toBe('change_production_status');
    expect(buildCreatePayload(state.form).conditions).toEqual({});

    state = {
      ...state,
      form: changeStatusAutomationAction(
        state.form,
        'map_production_status_to_order_status',
      ),
    };
    expect(state.form.targetStatusId).toBeNull();
    expect(validateStatusAutomationRuleBuilder(
      state,
      eventDescriptor({ allowedActions: ['map_production_status_to_order_status'] }),
    )).toContain('Заполните все строки соответствий статусов');

    state = {
      ...state,
      form: {
        ...state.form,
        statusMappingEntries: [{ sourceStatusIds: [4, 5], targetStatusId: 2 }],
      },
    };
    expect(buildCreatePayload(state.form)).toMatchObject({
      targetStatusId: null,
      actionConfig: {
        statusMapping: { entries: [{ sourceStatusIds: [4, 5], targetStatusId: 2 }] },
      },
    });
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

  it('exports status automation rules without database ids and versions', () => {
    expect(buildStatusAutomationRulesExportFile([rule], '2026-08-12T00:00:00.000Z')).toEqual({
      schema: 'erp.statusAutomationRules.v1',
      exportedAt: '2026-08-12T00:00:00.000Z',
      rules: [
        {
          name: 'Существующее правило',
          eventType: 'order.created',
          actionType: 'change_production_status',
          targetStatusId: 4,
          conditions: {},
          priority: 50,
          isEnabled: true,
        },
      ],
    });
  });

  it('reads import rules from either a plain array or an export wrapper', () => {
    const imported = [{ name: 'Правило' }];

    expect(readStatusAutomationRulesImportSource(imported)).toBe(imported);
    expect(readStatusAutomationRulesImportSource({ rules: imported })).toBe(imported);
    expect(() => readStatusAutomationRulesImportSource({ items: imported })).toThrow(
      'JSON должен содержать массив правил или объект с полем rules',
    );
  });

  it('plans import and skips existing and in-file duplicate rules', () => {
    const validRule = {
      name: 'Новая копия',
      eventType: 'payment.created',
      actionType: 'change_order_status',
      targetStatusId: 2,
      conditions: { currentOrderStatusIn: [1], paidShareGte: 50 },
      priority: 100,
      isEnabled: true,
    };

    const plan = planStatusAutomationRulesImport(
      [
        validRule,
        { ...validRule, name: 'Дубль в файле' },
        { ...rule, name: 'Дубль существующего' },
      ],
      {
        existingRules: [rule],
        eventTypes: [eventDescriptor(), eventDescriptor({ eventType: 'order.created' })],
        statusCatalog: importStatusCatalog,
      },
    );

    expect(plan.rulesToCreate).toEqual([{ index: 1, name: 'Новая копия', rule: validRule }]);
    expect(plan.skippedDuplicates).toEqual([
      { index: 2, name: 'Дубль в файле', reasons: ['Такое правило уже есть в этом JSON-файле'] },
      {
        index: 3,
        name: 'Дубль существующего',
        reasons: ['Такое правило уже есть в текущем приложении'],
      },
    ]);
    expect(plan.failedRules).toEqual([]);
  });

  it('reports rules that cannot be imported because matching events or statuses are absent', () => {
    const plan = planStatusAutomationRulesImport(
      [
        {
          name: 'Нет события',
          eventType: 'unknown.event',
          actionType: 'change_order_status',
          targetStatusId: 2,
          conditions: {},
        },
        {
          name: 'Нет статусов',
          eventType: 'payment.created',
          actionType: 'change_production_status',
          targetStatusId: 5,
          conditions: {
            currentOrderStatusIn: [999],
            currentPaymentStatusIn: [888],
            currentProductionStatusIn: [777],
          },
          priority: 20,
          isEnabled: true,
        },
      ],
      {
        existingRules: [],
        eventTypes: [eventDescriptor()],
        statusCatalog: importStatusCatalog,
      },
    );

    expect(plan.rulesToCreate).toEqual([]);
    expect(plan.failedRules).toEqual([
      {
        index: 1,
        name: 'Нет события',
        reasons: ['Событие «unknown.event» отсутствует в текущем приложении'],
      },
      {
        index: 2,
        name: 'Нет статусов',
        reasons: [
          'Целевой производственный статус #5 неактивен',
          'Отсутствуют статусы заказа: #999',
          'Отсутствуют статусы оплаты: #888',
          'Отсутствуют статусы производства: #777',
        ],
      },
    ]);
  });

  it('builds and describes many-to-one mapping actions', () => {
    const mappingRule: StatusAutomationRuleDto = {
      ...rule,
      actionType: 'map_production_status_to_order_status',
      targetStatusId: null,
      actionConfig: {
        statusMapping: { entries: [{ sourceStatusIds: [4, 5], targetStatusId: 2 }] },
      },
    };

    expect(describeAction(mappingRule, catalogs)).toBe('В работе, Готово → Оплачен');
    expect(describeFormAction({
      ...baseForm,
      actionType: 'map_order_status_to_details_production_status',
      statusMappingEntries: [{ sourceStatusIds: [], targetStatusId: 0 }],
    }, catalogs)).toBe('Менять статус деталей: соответствие не заполнено');
    expect(buildCreatePayload({
      ...baseForm,
      eventType: 'order.status_changed',
      actionType: 'map_order_status_to_details_production_status',
      statusMappingEntries: [{ sourceStatusIds: [1, 2], targetStatusId: 5 }],
    })).toMatchObject({
      targetStatusId: null,
      actionConfig: {
        statusMapping: { entries: [{ sourceStatusIds: [1, 2], targetStatusId: 5 }] },
      },
    });
  });
});
