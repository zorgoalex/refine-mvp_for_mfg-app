import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_EVENT_REGISTRY,
  isEngineOwnedEvent,
  getEventDefinition,
  listConfigurableEventTypes,
} from './notification-event-registry';

describe('notification event registry', () => {
  it('owns the three manual status-change events in phase 1', () => {
    expect(isEngineOwnedEvent('order.status_changed')).toBe(true);
    expect(isEngineOwnedEvent('order.production_status_changed')).toBe(true);
    expect(isEngineOwnedEvent('order.payment_status_changed')).toBe(true);
  });

  it('does not own legacy-inline deadline/group events in phase 1', () => {
    expect(isEngineOwnedEvent('DEADLINE_EXPIRED')).toBe(false);
    expect(isEngineOwnedEvent('GROUP_DEADLINE_OVERDUE')).toBe(false);
  });

  it('declares order context + supported resolvers for order status events', () => {
    const def = getEventDefinition('order.status_changed');
    expect(def?.contextFields).toContain('orderId');
    expect(def?.supportsOrderConditions).toBe(true);
    expect(def?.supportedResolvers).toEqual(
      expect.arrayContaining(['order_manager', 'stage_assignee', 'group_participants']),
    );
  });

  it('returns undefined for unknown events', () => {
    expect(getEventDefinition('nope.unknown')).toBeUndefined();
    expect(isEngineOwnedEvent('nope.unknown')).toBe(false);
  });

  it('keeps order doweling refresh as integration-only without user notifications', () => {
    expect(getEventDefinition('order.details_doweling_auto_set')).toBeUndefined();
    expect(isEngineOwnedEvent('order.details_doweling_auto_set')).toBe(false);
  });

  it('exposes workshop_head and direction_head resolvers for order events', () => {
    for (const eventType of [
      'order.status_changed',
      'order.production_status_changed',
      'order.payment_status_changed',
      'DEADLINE_EXPIRED',
    ]) {
      const def = getEventDefinition(eventType);
      expect(def?.supportedResolvers).toEqual(
        expect.arrayContaining(['workshop_head', 'direction_head']),
      );
    }
  });

  it('registers «Переделка» events as engine-owned order events with the rework_managers resolver', () => {
    for (const eventType of ['order.rework_started', 'order.rework_details_added', 'order.rework_reason_clarified', 'order.rework_closed']) {
      expect(isEngineOwnedEvent(eventType)).toBe(true);
      const def = getEventDefinition(eventType);
      expect(def).toMatchObject({ aggregateType: 'order', supportsOrderConditions: true });
      expect(def?.supportedResolvers).toEqual(expect.arrayContaining(['order_manager', 'workshop_head', 'rework_managers']));
    }
    // Other events keep their resolver sets.
    expect(getEventDefinition('order.status_changed')?.supportedResolvers).not.toContain('rework_managers');
  });

  it('does not add head resolvers to the group-only GROUP_DEADLINE_OVERDUE event', () => {
    const def = getEventDefinition('GROUP_DEADLINE_OVERDUE');
    expect(def?.supportedResolvers).toEqual(['group_participants']);
  });

  it('declares deadline condition support only for deadline events', () => {
    expect(getEventDefinition('DEADLINE_EXPIRED')?.supportsDeadlineConditions).toBe(true);
    expect(getEventDefinition('GROUP_DEADLINE_OVERDUE')?.supportsDeadlineConditions).toBe(true);
    expect(getEventDefinition('order.status_changed')?.supportsDeadlineConditions).toBe(false);
    expect(getEventDefinition('order.production_status_changed')?.supportsDeadlineConditions).toBe(false);
    expect(getEventDefinition('order.payment_status_changed')?.supportsDeadlineConditions).toBe(false);
  });

  it('lists deadline-capable event metadata for admin configuration without changing static ownership', () => {
    const eventTypes = listConfigurableEventTypes().map((definition) => definition.eventType);

    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'order.status_changed',
        'order.production_status_changed',
        'order.payment_status_changed',
        'DEADLINE_EXPIRED',
        'GROUP_DEADLINE_OVERDUE',
      ]),
    );
    expect(isEngineOwnedEvent('DEADLINE_EXPIRED')).toBe(false);
  });
});
