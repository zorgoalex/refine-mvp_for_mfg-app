import { describe, expect, it } from 'vitest';
import {
  getEventDescriptor,
  STATUS_AUTOMATION_EVENTS,
} from './status-automation-events';

const expectedEventTypes = [
  'payment.created',
  'order.payment_status_changed',
  'order.created',
  'order.status_changed',
  'order.production_status_changed',
] as const;

const baseConditions = [
  'currentOrderStatusIn',
  'currentPaymentStatusIn',
  'currentProductionStatusIn',
  'paidShareGte',
  'orderSourceIn',
] as const;

const actionTypes = [
  'change_order_status',
  'change_production_status',
  'change_details_production_status',
] as const;

describe('status automation event catalog', () => {
  it('contains exactly the five supported events', () => {
    expect(STATUS_AUTOMATION_EVENTS).toHaveLength(5);
    expect(STATUS_AUTOMATION_EVENTS.map((descriptor) => descriptor.eventType)).toEqual(
      expectedEventTypes,
    );
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
