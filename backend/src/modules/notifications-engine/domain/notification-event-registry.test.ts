import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_EVENT_REGISTRY,
  isEngineOwnedEvent,
  getEventDefinition,
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
});
