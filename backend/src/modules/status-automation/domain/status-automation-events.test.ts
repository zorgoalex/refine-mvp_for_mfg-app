import { describe, expect, it } from 'vitest';
import {
  getEventDescriptor,
  STATUS_AUTOMATION_EVENTS,
} from './status-automation-events';

const expectedEventTypes = [
  'payment.created',
  'order.payment_status_changed',
  'order.created',
  'order.updated',
  'order.planned_completion_date_changed',
  'order.status_changed',
  'order.production_status_changed',
  'mdf.order_machine_files_present',
] as const;

const baseConditions = [
  'currentOrderStatusIn',
  'currentOrderStatusNotIn',
  'currentPaymentStatusIn',
  'currentPaymentStatusNotIn',
  'currentProductionStatusIn',
  'currentProductionStatusNotIn',
  'paidShareGte',
  'orderSourceIn',
] as const;

const actionTypes = [
  'change_order_status',
  'change_production_status',
  'change_details_production_status',
] as const;

describe('status automation event catalog', () => {
  it('contains exactly the eight supported events', () => {
    expect(STATUS_AUTOMATION_EVENTS).toHaveLength(8);
    expect(STATUS_AUTOMATION_EVENTS.map((descriptor) => descriptor.eventType)).toEqual(
      expectedEventTypes,
    );
  });

  it('exposes unique event types, groups, and user-facing descriptions', () => {
    expect(new Set(STATUS_AUTOMATION_EVENTS.map((descriptor) => descriptor.eventType)).size).toBe(8);
    for (const descriptor of STATUS_AUTOMATION_EVENTS) {
      expect(['order', 'dates', 'statuses', 'payments', 'production']).toContain(descriptor.group);
      expect(descriptor.description.trim().length).toBeGreaterThan(10);
    }
    expect(getEventDescriptor('order.planned_completion_date_changed')).toMatchObject({
      group: 'dates',
      title: 'Изменилась плановая дата готовности',
    });
    expect(getEventDescriptor('mdf.order_machine_files_present')).toMatchObject({
      group: 'production',
      title: 'Файлы заказа на станке',
    });
  });

  it('allows firstPaymentOnly only for payment.created', () => {
    expect(getEventDescriptor('payment.created')?.allowedConditions).toContain(
      'firstPaymentOnly',
    );
    expect(getEventDescriptor('order.status_changed')?.allowedConditions).not.toContain(
      'firstPaymentOnly',
    );
  });

  it('exposes all base conditions and actions for every event', () => {
    for (const descriptor of STATUS_AUTOMATION_EVENTS) {
      expect(descriptor.allowedConditions).toEqual(expect.arrayContaining(baseConditions));
      expect(descriptor.allowedConditions).toHaveLength(
        baseConditions.length + (descriptor.eventType === 'payment.created' ? 1 : 0),
      );
      expect(descriptor.allowedActions).toEqual(expect.arrayContaining(actionTypes));
      expect(descriptor.allowedActions).toHaveLength(3);
    }
  });

  it('looks up known events and returns null for unknown events', () => {
    expect(getEventDescriptor('payment.created')).toEqual(
      expect.objectContaining({ eventType: 'payment.created' }),
    );
    expect(getEventDescriptor('nope')).toBeNull();
  });
});
