import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import type { SyncIntent } from './bitrix24-sync-consumer';
import { persistSyncIntent } from './persist-sync-intent';

const tx = {} as DatabaseClient;

const intent: SyncIntent = {
  mapping: {
    entityType: 'order', erpId: '2', bitrixObject: 'deal', bitrixId: '20',
    parentErpId: '1', status: 'active', lastHash: 'h',
  },
  audit: {
    event: 'crm_sync.upsert', entityType: 'order', entityId: '2', requestId: 'event-1',
    source: 'crm-sync', actorUserId: null, relatedOrderId: 2, relatedClientId: 1,
    metadata: { bitrixId: '20' },
  },
  extraAudits: [{
    event: 'crm_sync.stale_delete_projected', entityType: 'order', entityId: '2', requestId: 'event-1',
    source: 'crm-sync',
  }],
  clearPaymentCreateGuardId: '7',
};

function deps(applied: boolean) {
  const mapping = {
    upsertSuccess: vi.fn().mockResolvedValue(applied),
    deletePaymentCreateGuard: vi.fn().mockResolvedValue(undefined),
  } as unknown as PgCrmSyncMappingRepository;
  const audit = { record: vi.fn().mockResolvedValue('1') } as unknown as AuditService;
  return { mapping, audit };
}

describe('persistSyncIntent', () => {
  it('records the intent audits when the mapping is written', async () => {
    const { mapping, audit } = deps(true);
    await persistSyncIntent(tx, mapping, audit, intent);
    expect(vi.mocked(audit.record).mock.calls.map(([, event]) => event.event))
      .toEqual(['crm_sync.upsert', 'crm_sync.stale_delete_projected']);
    expect(mapping.deletePaymentCreateGuard).toHaveBeenCalledWith(tx, '7');
  });

  it('records a remote-deleted skip instead of a success when reverse sync deleted the Deal meanwhile', async () => {
    const { mapping, audit } = deps(false);
    await persistSyncIntent(tx, mapping, audit, intent);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit.record).mock.calls[0][1]).toMatchObject({
      event: 'crm_sync.remote_deleted_skipped',
      entityType: 'order',
      entityId: '2',
      relatedOrderId: 2,
      metadata: { bitrixId: '20', conflictCode: 'BITRIX24_DEAL_REMOTE_DELETED' },
    });
  });
});
