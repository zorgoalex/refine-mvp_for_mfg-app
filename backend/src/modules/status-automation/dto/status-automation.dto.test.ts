import { describe, expect, it } from 'vitest';
import {
  listStatusAutomationEventTypes,
  parseCreateStatusAutomationRuleRequest,
  parseUpdateStatusAutomationRuleRequest,
} from './status-automation.dto';

describe('status automation DTO', () => {
  it('publishes MDF board events for the AutoStatuses event select', () => {
    const titlesByEventType = new Map(
      listStatusAutomationEventTypes().map((eventType) => [eventType.eventType, eventType.title]),
    );

    expect(titlesByEventType.get('mdf.board.completed')).toBe('МДФ-доска распилено');
    expect(titlesByEventType.get('mdf.board.baths')).toBe('МДФ-доска карты ванн');
    expect(titlesByEventType.get('mdf.board.baths_ready')).toBe('МДФ-работы готовы к закатке');
    expect(titlesByEventType.get('mdf.board.baths_laminated')).toBe('МДФ-работы закатаны');
  });

  describe('parseCreateStatusAutomationRuleRequest', () => {
    it('parses and normalizes a valid rule', () => {
      expect(
        parseCreateStatusAutomationRuleRequest({
          name: '  Первый платёж  ',
          eventType: 'payment.created',
          actionType: 'change_order_status',
          targetStatusId: 7,
          conditions: {
            currentOrderStatusIn: [1, 2],
            currentOrderStatusNotIn: [8],
            currentPaymentStatusIn: [],
            currentPaymentStatusNotIn: [3],
            currentProductionStatusIn: [],
            currentProductionStatusNotIn: [4],
            paidShareGte: 0,
            orderSourceIn: [],
            firstPaymentOnly: true,
          },
          priority: 10,
        }),
      ).toEqual({
        name: 'Первый платёж',
        eventType: 'payment.created',
        actionType: 'change_order_status',
        targetStatusId: 7,
        conditions: {
          currentOrderStatusIn: [1, 2],
          currentOrderStatusNotIn: [8],
          currentPaymentStatusNotIn: [3],
          currentProductionStatusNotIn: [4],
          paidShareGte: 0,
          firstPaymentOnly: true,
        },
        priority: 10,
        isEnabled: false,
      });
    });

    it('defaults conditions and priority for create', () => {
      expect(
        parseCreateStatusAutomationRuleRequest({
          name: 'Rule',
          eventType: 'order.created',
          actionType: 'change_production_status',
          targetStatusId: 3,
        }),
      ).toMatchObject({ conditions: {}, priority: 100, isEnabled: false });
    });

    it('parses a many-to-one mapping rule without a single target status', () => {
      expect(parseCreateStatusAutomationRuleRequest({
        name: 'Производство → заказ',
        eventType: 'order.production_status_changed',
        actionType: 'map_production_status_to_order_status',
        targetStatusId: null,
        actionConfig: {
          statusMapping: {
            entries: [{ sourceStatusIds: [3, 4], targetStatusId: 8 }],
          },
        },
      })).toMatchObject({
        actionType: 'map_production_status_to_order_status',
        targetStatusId: null,
        actionConfig: {
          statusMapping: { entries: [{ sourceStatusIds: [3, 4], targetStatusId: 8 }] },
        },
      });
    });

    it.each([
      ['Файлы заказа на станке', 'mdf.order_machine_files_present'],
      ['МДФ-доска распилено', 'mdf.board.completed'],
      ['МДФ-доска карты ванн', 'mdf.board.baths'],
      ['МДФ-работы готовы к закатке', 'mdf.board.baths_ready'],
      ['МДФ-работы закатаны', 'mdf.board.baths_laminated'],
    ] as const)('accepts the MDF production event: %s', (name, eventType) => {
      expect(
        parseCreateStatusAutomationRuleRequest({
          name,
          eventType,
          actionType: 'change_production_status',
          targetStatusId: 3,
          conditions: { currentOrderStatusIn: [1] },
        }),
      ).toMatchObject({
        eventType,
        actionType: 'change_production_status',
        conditions: { currentOrderStatusIn: [1] },
      });
    });

    it.each([
      ['unknown event type', { eventType: 'payment.deleted' }],
      ['invalid action type', { actionType: 'delete_order' }],
      ['unknown condition', { conditions: { unknown: true } }],
      ['firstPaymentOnly on another event', {
        eventType: 'order.created',
        conditions: { firstPaymentOnly: true },
      }],
      ['paidShareGte below zero', { conditions: { paidShareGte: -1 } }],
      ['paidShareGte above 100', { conditions: { paidShareGte: 101 } }],
      ['status array contains zero', { conditions: { currentOrderStatusIn: [0] } }],
      ['excluded status array contains zero', { conditions: { currentOrderStatusNotIn: [0] } }],
      ['status array contains a non-integer', { conditions: { currentOrderStatusIn: [1.5] } }],
      ['source array contains an unknown value', { conditions: { orderSourceIn: ['api'] } }],
      ['name is blank', { name: '   ' }],
      ['name is too long', { name: 'x'.repeat(201) }],
      ['priority is not an integer', { priority: 1.5 }],
      ['target status is not positive', { targetStatusId: 0 }],
      ['single-target action without target status', { targetStatusId: null }],
      ['mapping action without mapping entries', {
        eventType: 'order.status_changed',
        actionType: 'map_order_status_to_details_production_status',
        targetStatusId: null,
        actionConfig: {},
      }],
      ['mapping action on wrong event', {
        eventType: 'order.created',
        actionType: 'map_order_status_to_details_production_status',
        targetStatusId: null,
        actionConfig: { statusMapping: { entries: [{ sourceStatusIds: [1], targetStatusId: 2 }] } },
      }],
      ['duplicate mapping source', {
        eventType: 'order.production_status_changed',
        actionType: 'map_production_status_to_order_status',
        targetStatusId: null,
        actionConfig: { statusMapping: { entries: [
          { sourceStatusIds: [1, 2], targetStatusId: 3 },
          { sourceStatusIds: [2], targetStatusId: 4 },
        ] } },
      }],
      ['isEnabled is not boolean', { isEnabled: 'true' }],
      ['conditions is not an object', { conditions: null }],
    ] as const)('rejects %s with 422', (_caseName, overrides) => {
      expect(() => parseCreateStatusAutomationRuleRequest({ ...validCreate(), ...overrides })).toThrowError(
        expect.objectContaining({ statusCode: 422, code: 'VALIDATION_ERROR' }),
      );
    });

    it.each(['', null, 1, [], undefined])('rejects an invalid body: %s', (body) => {
      expect(() => parseCreateStatusAutomationRuleRequest(body)).toThrowError(
        expect.objectContaining({ statusCode: 422 }),
      );
    });
  });

  describe('parseUpdateStatusAutomationRuleRequest', () => {
    it('parses a partial update and trims name', () => {
      expect(
        parseUpdateStatusAutomationRuleRequest({ version: 4, name: '  Updated  ' }),
      ).toEqual({ version: 4, name: 'Updated' });
    });

    it('normalizes empty condition arrays in an update', () => {
      expect(
        parseUpdateStatusAutomationRuleRequest({
          version: 2,
          eventType: 'payment.created',
          conditions: {
            currentOrderStatusIn: [],
            currentOrderStatusNotIn: [],
            currentPaymentStatusIn: [],
            currentPaymentStatusNotIn: [],
            currentProductionStatusIn: [],
            currentProductionStatusNotIn: [],
            orderSourceIn: [],
          },
        }),
      ).toEqual({ version: 2, eventType: 'payment.created', conditions: {} });
    });

    it('allows a first-payment condition when the update selects payment.created', () => {
      expect(
        parseUpdateStatusAutomationRuleRequest({
          version: 2,
          eventType: 'payment.created',
          conditions: { firstPaymentOnly: true },
        }),
      ).toMatchObject({ conditions: { firstPaymentOnly: true } });
    });

    it.each([undefined, 0, -1, 1.2, '2'])('requires a positive integer version: %s', (version) => {
      expect(() => parseUpdateStatusAutomationRuleRequest({ version, priority: 1 })).toThrowError(
        expect.objectContaining({ statusCode: 422 }),
      );
    });

    it('rejects an update containing only version', () => {
      expect(() => parseUpdateStatusAutomationRuleRequest({ version: 1 })).toThrowError(
        expect.objectContaining({ statusCode: 422 }),
      );
    });

    it('rejects an update-only firstPaymentOnly condition for another event', () => {
      expect(() =>
        parseUpdateStatusAutomationRuleRequest({
          version: 1,
          eventType: 'order.created',
          conditions: { firstPaymentOnly: true },
        }),
      ).toThrowError(expect.objectContaining({ statusCode: 422 }));
    });

    it.each([
      { version: 1, actionType: 'invalid' },
      { version: 1, conditions: { notAllowed: true } },
      { version: 1, conditions: { paidShareGte: 100.1 } },
      { version: 1, targetStatusId: 2.2 },
    ])('rejects invalid update fields: $conditions', (body) => {
      expect(() => parseUpdateStatusAutomationRuleRequest(body)).toThrowError(
        expect.objectContaining({ statusCode: 422 }),
      );
    });
  });
});

function validCreate(): Record<string, unknown> {
  return {
    name: 'Rule',
    eventType: 'payment.created',
    actionType: 'change_order_status',
    targetStatusId: 7,
    conditions: {},
    priority: 10,
    isEnabled: true,
  };
}
