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
  persist: (
    intents: SyncIntent[],
    checkpoint: BackfillCheckpoint,
  ) => Promise<void>;
  batchSize: number;
  dryRun: boolean;
  scope?: BackfillScope;
  checkpoint?: BackfillCheckpoint | null;
  assertOwnership?: () => Promise<void>;
  onProgress?: (progress: BackfillProgress) => void | Promise<void>;
  shouldStop?: () => boolean;
}

export interface BackfillResult {
  clients: number;
  orders: number;
  checkpoint: BackfillCheckpoint;
  alreadyCompleted: boolean;
  interrupted: boolean;
}

export type BackfillScope = 'clients' | 'all';
export type BackfillPhase = 'clients' | 'orders' | 'completed';

export interface BackfillCheckpoint {
  scope: BackfillScope;
  phase: BackfillPhase;
  lastClientId: string | null;
  lastOrderId: string | null;
  processedClients: number;
  processedOrders: number;
}

export interface BackfillProgress {
  kind: 'record' | 'phase' | 'completed';
  entity: 'client' | 'order' | null;
  checkpoint: BackfillCheckpoint;
  committed: boolean;
}

/**
 * Resumable backfill: paginates clients and, for scope=all, orders through the
 * consumer/persist path.
 *
 * Clients are fully processed before orders so Contact/Company relations exist
 * before deals reference them.
 *
 * The caller must persist a record's intents and supplied checkpoint in one
 * database transaction. A failed record therefore never advances the durable
 * cursor.
 *
 * dryRun: when true, consumer.sync is called (so intent shapes are computed)
 * but persist is never called and a supplied durable checkpoint is ignored.
 */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const {
    source,
    consumer,
    persist,
    batchSize,
    dryRun,
    assertOwnership,
    onProgress,
    shouldStop,
  } = deps;
  const scope = deps.scope ?? 'all';
  let checkpoint = dryRun
    ? freshCheckpoint(scope)
    : deps.checkpoint ?? freshCheckpoint(scope);
  validateCheckpoint(checkpoint, scope);

  if (checkpoint.phase === 'completed') {
    return {
      clients: checkpoint.processedClients,
      orders: checkpoint.processedOrders,
      checkpoint,
      alreadyCompleted: true,
      interrupted: false,
    };
  }

  // ── Phase 1: clients ────────────────────────────────────────────────────────
  if (checkpoint.phase === 'clients') {
    let after = checkpoint.lastClientId ?? '0';
    for (;;) {
      if (shouldStop?.()) return interruptedResult(checkpoint);
      const ids = await source.listClientIds(after, batchSize);
      if (!ids.length) break;
      for (const id of ids) {
        if (shouldStop?.()) return interruptedResult(checkpoint);
        await assertOwnership?.();
        const event = synthEvent('client', id);
        const intents = await consumer.sync(event, assertOwnership);
        await assertOwnership?.();
        const nextCheckpoint: BackfillCheckpoint = {
          ...checkpoint,
          lastClientId: id,
          processedClients: checkpoint.processedClients + 1,
        };
        await commitProgress(
          intents,
          nextCheckpoint,
          { kind: 'record', entity: 'client' },
        );
        checkpoint = nextCheckpoint;
      }
      after = ids[ids.length - 1];
    }

    const nextCheckpoint: BackfillCheckpoint = scope === 'clients'
      ? { ...checkpoint, phase: 'completed' }
      : { ...checkpoint, phase: 'orders', lastOrderId: null };
    await commitProgress(
      [],
      nextCheckpoint,
      scope === 'clients'
        ? { kind: 'completed', entity: null }
        : { kind: 'phase', entity: null },
    );
    checkpoint = nextCheckpoint;
  }

  // ── Phase 2: orders (clients fully done first) ──────────────────────────────
  if (checkpoint.phase === 'orders') {
    let after = checkpoint.lastOrderId ?? '0';
    for (;;) {
      if (shouldStop?.()) return interruptedResult(checkpoint);
      const ids = await source.listOrderIds(after, batchSize);
      if (!ids.length) break;
      for (const id of ids) {
        if (shouldStop?.()) return interruptedResult(checkpoint);
        await assertOwnership?.();
        const event = synthEvent('order', id);
        const intents = await consumer.sync(event, assertOwnership);
        await assertOwnership?.();
        const nextCheckpoint: BackfillCheckpoint = {
          ...checkpoint,
          lastOrderId: id,
          processedOrders: checkpoint.processedOrders + 1,
        };
        await commitProgress(
          intents,
          nextCheckpoint,
          { kind: 'record', entity: 'order' },
        );
        checkpoint = nextCheckpoint;
      }
      after = ids[ids.length - 1];
    }

    const nextCheckpoint: BackfillCheckpoint = {
      ...checkpoint,
      phase: 'completed',
    };
    await commitProgress(
      [],
      nextCheckpoint,
      { kind: 'completed', entity: null },
    );
    checkpoint = nextCheckpoint;
  }

  return {
    clients: checkpoint.processedClients,
    orders: checkpoint.processedOrders,
    checkpoint,
    alreadyCompleted: false,
    interrupted: false,
  };

  async function commitProgress(
    intents: SyncIntent[],
    nextCheckpoint: BackfillCheckpoint,
    progress: Pick<BackfillProgress, 'kind' | 'entity'>,
  ): Promise<void> {
    if (!dryRun) {
      await persist(intents, nextCheckpoint);
    }
    if (!onProgress) return;
    try {
      await onProgress({
        ...progress,
        checkpoint: nextCheckpoint,
        committed: !dryRun,
      });
    } catch {
      // Progress reporting must not change synchronization delivery semantics.
    }
  }
}

function interruptedResult(checkpoint: BackfillCheckpoint): BackfillResult {
  return {
    clients: checkpoint.processedClients,
    orders: checkpoint.processedOrders,
    checkpoint,
    alreadyCompleted: false,
    interrupted: true,
  };
}

function freshCheckpoint(scope: BackfillScope): BackfillCheckpoint {
  return {
    scope,
    phase: 'clients',
    lastClientId: null,
    lastOrderId: null,
    processedClients: 0,
    processedOrders: 0,
  };
}

function validateCheckpoint(
  checkpoint: BackfillCheckpoint,
  expectedScope: BackfillScope,
): void {
  if (checkpoint.scope !== expectedScope) {
    throw new Error(
      `Backfill checkpoint scope ${checkpoint.scope} does not match ${expectedScope}`,
    );
  }
  if (expectedScope === 'clients' && checkpoint.phase === 'orders') {
    throw new Error('Clients-only backfill checkpoint cannot be in orders phase');
  }
  if (
    !Number.isSafeInteger(checkpoint.processedClients) ||
    checkpoint.processedClients < 0 ||
    !Number.isSafeInteger(checkpoint.processedOrders) ||
    checkpoint.processedOrders < 0
  ) {
    throw new Error('Backfill checkpoint counts must be non-negative safe integers');
  }
}
