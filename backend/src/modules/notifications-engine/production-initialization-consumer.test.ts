import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationsEngineModule } from './notifications-engine.module';
import { OutboxRelayService, type OutboxConsumer } from './application/outbox-relay.service';
import { PgOrderDeadlineSync } from '../deadlines/adapters/pg-order-deadline-sync';
import type { OutboxEventRecord } from './domain/outbox-event.types';

afterEach(() => vi.restoreAllMocks());

function consumer(enabled: boolean) {
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, NotificationsEngineModule);
  const factory = providers.find((provider: { provide?: unknown }) => provider.provide === OutboxRelayService);
  const relay = factory.useFactory({}, { getFeatureFlags: () => ({ engineOwnsDeadline: false }) }, {}, new ConfigService({
    BACKEND_ENABLE_DEADLINES: enabled, BACKEND_DEADLINES_READ_ONLY: !enabled,
    BACKEND_ENABLE_DEADLINE_ORDER_SYNC: enabled,
  }));
  // Inspect the real module factory's consumer, not a reimplementation.
  return (relay as { deps: { consumers: OutboxConsumer[] } }).deps.consumers.find((item) => item.supports('orders.production_initialized'))!;
}
const event = (marker?: string): OutboxEventRecord => ({
  outboxEventId: 'E2E-init', eventType: 'orders.production_initialized',
  aggregateType: 'order', aggregateId: '11634', attempts: 0,
  payload: { orderId: 11634, actorUserId: 3, actorRole: 'admin', actorUsername: 'E2E-conversion', requestId: 'E2E-req', ...(marker ? { deadlineInitialization: marker } : {}) },
});

describe('production initialization event compatibility', () => {
  it.each([true, false])('does not resync already initialized transactional events (legacy flags=%s)', async (enabled) => {
    const sync = vi.spyOn(PgOrderDeadlineSync.prototype, 'syncOrderDeadlinesInTransaction').mockResolvedValue();
    await consumer(enabled).process({} as never, event('transactional_v1'));
    expect(sync).not.toHaveBeenCalled();
  });
  it('retains shared-transaction legacy initialization for unmarked historical events', async () => {
    const sync = vi.spyOn(PgOrderDeadlineSync.prototype, 'syncOrderDeadlinesInTransaction').mockResolvedValue();
    const tx = {} as never;
    await consumer(true).process(tx, event());
    expect(sync).toHaveBeenCalledWith(tx, expect.objectContaining({ orderId: 11634, requestId: 'E2E-req' }), false);
  });
  it.each([undefined, 'unknown_version'])('does not bypass legacy flag guards for marker %s', async (marker) => {
    await expect(consumer(false).process({} as never, event(marker))).rejects.toThrow('Production deadline initialization is unavailable');
  });
});
