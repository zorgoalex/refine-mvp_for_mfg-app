import { describe, expect, it } from 'vitest';
import { resolveEffectiveEventType } from './deadline-event-extractor';

describe('resolveEffectiveEventType', () => {
  it('returns the outbox eventType unchanged for non-deadline events', () => {
    expect(
      resolveEffectiveEventType({
        eventType: 'order.production_status_changed',
        payload: { orderId: 100, eventType: 'order.production_status_changed' },
      }),
    ).toBe('order.production_status_changed');

    expect(
      resolveEffectiveEventType({
        eventType: 'order.payment_status_changed',
        payload: null,
      }),
    ).toBe('order.payment_status_changed');
  });

  it('returns the inner payload.eventType for deadline envelope events', () => {
    expect(
      resolveEffectiveEventType({
        eventType: 'deadline.event.created',
        payload: { eventType: 'DEADLINE_EXPIRED', orderId: 100 },
      }),
    ).toBe('DEADLINE_EXPIRED');

    expect(
      resolveEffectiveEventType({
        eventType: 'deadline.event.created',
        payload: { eventType: 'DEADLINE_COMPLETED_ON_TIME' },
      }),
    ).toBe('DEADLINE_COMPLETED_ON_TIME');
  });

  it('falls back to the envelope when inner type is missing or invalid', () => {
    expect(
      resolveEffectiveEventType({
        eventType: 'deadline.event.created',
        payload: { orderId: 100 },
      }),
    ).toBe('deadline.event.created');

    expect(
      resolveEffectiveEventType({
        eventType: 'deadline.event.created',
        payload: {},
      }),
    ).toBe('deadline.event.created');

    expect(
      resolveEffectiveEventType({
        eventType: 'deadline.event.created',
        payload: undefined,
      }),
    ).toBe('deadline.event.created');

    expect(
      resolveEffectiveEventType({
        eventType: 'deadline.event.created',
        payload: { eventType: 123 },
      }),
    ).toBe('deadline.event.created');

    expect(
      resolveEffectiveEventType({
        eventType: 'deadline.event.created',
        payload: { eventType: '   ' },
      }),
    ).toBe('deadline.event.created');
  });
});
