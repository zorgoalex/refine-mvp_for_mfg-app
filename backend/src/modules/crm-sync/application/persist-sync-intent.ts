import type { AuditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import type { SyncIntent } from './bitrix24-sync-consumer';

/**
 * Persists one outbound intent. A Deal deleted in Bitrix while the outbound call was in flight
 * (reverse sync wrote `remote_deleted`) keeps that status: the stale success is recorded as a skip,
 * never as a successful sync that reactivates the mapping.
 */
export async function persistSyncIntent(
  tx: DatabaseClient,
  mapping: PgCrmSyncMappingRepository,
  audit: AuditService,
  intent: SyncIntent,
): Promise<void> {
  const applied = await mapping.upsertSuccess(tx, intent.mapping);
  if (!applied) {
    await audit.record(tx, {
      ...intent.audit,
      event: 'crm_sync.remote_deleted_skipped',
      metadata: {
        bitrixId: intent.mapping.bitrixId,
        conflictCode: 'BITRIX24_DEAL_REMOTE_DELETED',
      },
    });
  } else {
    await audit.record(tx, intent.audit);
    for (const extra of intent.extraAudits ?? []) {
      await audit.record(tx, extra);
    }
  }
  if (intent.clearPaymentCreateGuardId) {
    await mapping.deletePaymentCreateGuard(tx, intent.clearPaymentCreateGuardId);
  }
}
