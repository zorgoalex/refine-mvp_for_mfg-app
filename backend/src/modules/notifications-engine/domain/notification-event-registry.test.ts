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

  it('does not own legacy-inline deadline/project events in phase 1', () => {
    expect(isEngineOwnedEvent('DEADLINE_EXPIRED')).toBe(false);
    expect(isEngineOwnedEvent('PROJECT_DEADLINE_OVERDUE')).toBe(false);
  });

  it('declares order context + supported resolvers for order status events', () => {
    const def = getEventDefinition('order.status_changed');
    expect(def?.contextFields).toContain('orderId');
    expect(def?.supportsOrderConditions).toBe(true);
    expect(def?.supportedResolvers).toEqual(
      expect.arrayContaining(['order_manager', 'stage_assignee', 'project_participants']),
    );
  });

  it('returns undefined for unknown events', () => {
    expect(getEventDefinition('nope.unknown')).toBeUndefined();
    expect(isEngineOwnedEvent('nope.unknown')).toBe(false);
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

  it('does not add head resolvers to the project-only PROJECT_DEADLINE_OVERDUE event', () => {
    const def = getEventDefinition('PROJECT_DEADLINE_OVERDUE');
    expect(def?.supportedResolvers).toEqual(['project_participants']);
  });

  it('declares deadline condition support only for deadline events', () => {
    expect(getEventDefinition('DEADLINE_EXPIRED')?.supportsDeadlineConditions).toBe(true);
    expect(getEventDefinition('PROJECT_DEADLINE_OVERDUE')?.supportsDeadlineConditions).toBe(true);
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
        'PROJECT_DEADLINE_OVERDUE',
      ]),
    );
    expect(isEngineOwnedEvent('DEADLINE_EXPIRED')).toBe(false);
  });
});
