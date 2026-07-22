import { randomUUID } from 'node:crypto';
import type { OutboxEventRecord } from '../../notifications-engine/domain/outbox-event.types';
import type { CrmSourcePort } from './crm-sync.types';
import type { Bitrix24SyncConsumer, SyncIntent } from './bitrix24-sync-consumer';

/**
 * Builds a synthetic OutboxEventRecord for backfill purposes.
 * Backfill events are never persisted to the outbox table — they are ephemeral
 * and passed directly to the consumer.
 */
function synthEvent(entity: 'client' | 'order', id: string): OutboxEventRecord {
  return {
    outboxEventId: randomUUID(),
    eventType: `crm.sync.${entity}.upsert`,
    aggregateType: 'crm_sync',
    aggregateId: id,
    payload: { entity, id, op: 'upsert' },
    attempts: 0,
  };
}

export interface BackfillDeps {
  source: CrmSourcePort;
  consumer: Bitrix24SyncConsumer;
  persist: (intents: SyncIntent[]) => Promise<void>;
  batchSize: number;
  dryRun: boolean;
  assertOwnership?: () => Promise<void>;
}

export interface BackfillResult {
  clients: number;
  orders: number;
}

/**
 * Idempotent backfill: paginates all clients then all orders through the
 * consumer/persist path.
 *
 * Clients are fully processed before orders so Contact/Company relations exist
 * before deals reference them.
 *
 * Idempotency: if a record's hash is unchanged the consumer returns [] and
 * persist([]) is a no-op — re-running is safe.
 *
 * dryRun: when true, consumer.sync is called (so intent shapes are computed)
 * but persist is never called.
 */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const { source, consumer, persist, batchSize, dryRun, assertOwnership } = deps;
  let clients = 0;
  let orders = 0;

  // ── Phase 1: clients ────────────────────────────────────────────────────────
  let after = '0';
  for (;;) {
    const ids = await source.listClientIds(after, batchSize);
    if (!ids.length) break;
    for (const id of ids) {
      await assertOwnership?.();
      const event = synthEvent('client', id);
      const intents = await consumer.sync(event, assertOwnership);
      await assertOwnership?.();
      if (!dryRun) {
        await persist(intents);
      }
      clients++;
    }
    after = ids[ids.length - 1];
  }

  // ── Phase 2: orders (clients fully done first) ──────────────────────────────
  after = '0';
  for (;;) {
    const ids = await source.listOrderIds(after, batchSize);
    if (!ids.length) break;
    for (const id of ids) {
      await assertOwnership?.();
      const event = synthEvent('order', id);
      const intents = await consumer.sync(event, assertOwnership);
      await assertOwnership?.();
      if (!dryRun) {
        await persist(intents);
      }
      orders++;
    }
    after = ids[ids.length - 1];
  }

  return { clients, orders };
}
