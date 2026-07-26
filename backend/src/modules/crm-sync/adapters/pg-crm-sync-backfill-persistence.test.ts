import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { SyncIntent } from '../application/bitrix24-sync-consumer';
import type { BackfillCheckpoint } from '../application/crm-sync-backfill';
import {
  BackfillWriterOwnershipLostError,
  PgCrmSyncBackfillPersistence,
} from './pg-crm-sync-backfill-persistence';

const checkpoint: BackfillCheckpoint = {
  scope: 'clients',
  phase: 'clients',
  lastClientId: '5',
  lastOrderId: null,
  processedClients: 5,
  processedOrders: 0,
};

const intent = {
  mapping: {
    entityType: 'client',
    erpId: '5',
    bitrixObject: 'contact',
    bitrixId: '55',
    parentErpId: null,
    status: 'active',
    lastHash: 'hash',
  },
  audit: {
    event: 'crm_sync.upsert',
    entityType: 'client',
    entityId: '5',
    requestId: 'request',
    source: 'crm-sync',
    actorUserId: null,
  },
} as SyncIntent;

function harness(writerOwned: boolean) {
  const tx = { query: vi.fn() } as unknown as TransactionClient;
  const db = {
    transaction: vi.fn(async (handler) => handler(tx)),
  } as unknown as DatabaseService;
  const outbox = {
    heartbeatWriterLock: vi.fn().mockResolvedValue(writerOwned),
  };
  const mapping = {
    upsertSuccess: vi.fn().mockResolvedValue(undefined),
    deletePaymentCreateGuard: vi.fn().mockResolvedValue(undefined),
  };
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  };
  const checkpoints = {
    save: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
  };
  const persistence = new PgCrmSyncBackfillPersistence(
    db,
    outbox as never,
    mapping as never,
    audit as never,
    checkpoints as never,
  );
  return { persistence, outbox, mapping, audit, checkpoints };
}

describe('PgCrmSyncBackfillPersistence', () => {
  it('fences the transaction before every mapping/audit/checkpoint write', async () => {
    const h = harness(true);
    const order: string[] = [];
    h.outbox.heartbeatWriterLock.mockImplementation(async () => {
      order.push('fence');
      return true;
    });
    h.mapping.upsertSuccess.mockImplementation(async () => {
      order.push('mapping');
    });
    h.audit.record.mockImplementation(async () => {
      order.push('audit');
    });
    h.checkpoints.save.mockImplementation(async () => {
      order.push('checkpoint');
    });

    await h.persistence.persist('writer-token', [intent], checkpoint);

    expect(order).toEqual(['fence', 'mapping', 'audit', 'checkpoint']);
    expect(h.outbox.heartbeatWriterLock).toHaveBeenCalledWith(
      expect.anything(),
      'writer-token',
    );
  });

  it('writes nothing when the writer lease was replaced before persistence', async () => {
    const h = harness(false);

    await expect(
      h.persistence.persist('stale-token', [intent], checkpoint),
    ).rejects.toBeInstanceOf(BackfillWriterOwnershipLostError);

    expect(h.mapping.upsertSuccess).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.checkpoints.save).not.toHaveBeenCalled();
  });

  it('fences restart before deleting its selected checkpoint', async () => {
    const h = harness(false);

    await expect(
      h.persistence.reset('stale-token', 'clients'),
    ).rejects.toBeInstanceOf(BackfillWriterOwnershipLostError);
    expect(h.checkpoints.reset).not.toHaveBeenCalled();
  });
});
