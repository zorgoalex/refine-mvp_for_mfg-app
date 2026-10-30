import type { AuditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import type { SyncIntent } from './bitrix24-sync-consumer';
import type { MappingRow } from './crm-sync.types';

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
  if (intent.mapping?.entityType === 'client') {
    const kept = await keptMergedAlias(tx, intent.mapping);
    if (kept) {
      await audit.record(tx, {
        event: 'crm_sync.merged_client_skipped',
        entityType: 'client',
        entityId: intent.mapping.erpId,
        requestId: intent.audit.requestId,
        source: intent.audit.source,
        actorUserId: null,
        relatedClientId: Number(intent.mapping.erpId),
        relatedEntities: [{ entityType: 'client', entityId: kept.survivorId }],
        metadata: {
          survivorId: kept.survivorId,
          reason: 'replacement_after_merge',
          keptBitrixObject: kept.bitrixObject,
          keptBitrixId: kept.bitrixId,
          // Created in Bitrix24 before the merge committed, not linked in ERP: shown for a manual clean-up.
          createdBitrixObject: intent.mapping.bitrixObject,
          createdBitrixId: intent.mapping.bitrixId,
        },
      });
      return;
    }
  }
  const applied = intent.mapping ? await mapping.upsertSuccess(tx, intent.mapping) : true;
  if (!applied) {
    await audit.record(tx, {
      ...intent.audit,
      event: 'crm_sync.remote_deleted_skipped',
      metadata: {
        bitrixId: intent.mapping?.bitrixId ?? null,
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

/**
 * A client merged after its outbound delivery started (migration 268) keeps the counterparty it had: requests of the
 * survivor may rely on that exact mapping. Read under the key a merge takes exclusively, so a merge in progress is
 * waited for. Null when the mapping may be written (not merged, or the same counterparty, or none stored yet).
 */
async function keptMergedAlias(
  tx: DatabaseClient,
  row: MappingRow,
): Promise<{ survivorId: number; bitrixObject: string; bitrixId: string } | null> {
  await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [`bitrix24-reverse:client:erp:${row.erpId}`]);
  const result = await tx.query<{ survivor_id: string | number; bitrix_object: string | null; bitrix_id: string | null }>(
    `SELECT r.survivor_id, m.bitrix_object, m.bitrix_id
       FROM client_merge_redirects r
       LEFT JOIN crm_sync_mapping m ON m.entity_type = 'client' AND m.erp_id = r.merged_client_id::text
      WHERE r.merged_client_id = $1`,
    [row.erpId],
  );
  const current = result.rows[0];
  if (!current || !current.bitrix_id || !current.bitrix_object) return null;
  if (current.bitrix_id === row.bitrixId && current.bitrix_object === row.bitrixObject) return null;
  return { survivorId: Number(current.survivor_id), bitrixObject: current.bitrix_object, bitrixId: current.bitrix_id };
}
