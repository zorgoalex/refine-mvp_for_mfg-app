import type { CurrentUser } from '../../../permissions/current-user';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import type { MdfJobDatabase } from '../application/mdf-job-runner';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { mdfAllowedOrdersSql, mdfPublishedCardOwnersSql } from './mdf-published-snapshot';
import { loadMdfBazisCompositionRawSnapshot, mdfBazisEligibleRowIdsFromRaw } from './mdf-bazis-composition-snapshot';

export type MdfBazisCompositionUnavailableReason = 'MDF_ENGINE_READ_ONLY'
  | 'MDF_SOURCE_NOT_REGISTERED' | 'MDF_PUBLICATION_PENDING' | 'MDF_SOURCE_ISSUES' | 'MDF_PARTIAL_ACCESS';
export interface MdfBazisCompositionReadiness {
  available: boolean;
  /** Concurrency token for the composition command, NOT an authorization token. */
  sourceToken: string | null;
  reason: MdfBazisCompositionUnavailableReason | null;
  /** Server-resolved rows the composition may keep/change (ordinary MDF rows); every other row
   * (HDF, non-MDF, cut disabled) is preserved raw and must not appear in desiredRows. */
  eligibleRowIds: string[];
}

/** Read-only readiness of a BASIS set for the composition command; null outside active/read_only. The token is issued only
 * for an active engine, a fresh issue-free publication (published received = head received =
 * head accepted) and a caller whose current orders.view scope allows EVERY card owner (same
 * owner set as the published reader). The command itself re-authorizes on every call. */
export async function loadMdfBazisCompositionReadiness(database: MdfJobDatabase, user: CurrentUser,
  setId: number): Promise<MdfBazisCompositionReadiness | null> {
  return database.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const unavailable = (reason: MdfBazisCompositionUnavailableReason) =>
      ({ available: false, sourceToken: null, reason, eligibleRowIds: [] });
    const mode = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode;
    if (mode === 'read_only') return unavailable('MDF_ENGINE_READ_ONLY');
    // Legacy/shadow: the composition command does not apply; callers keep the legacy editor.
    if (mode !== 'active') return null;
    const row = (await tx.query<{ received: string; accepted: string | null; version: string; epoch: string;
      publishedReceived: string | null; issues: string[] | null; ownerCount: number; allowedCount: number }>(
      `WITH allowed AS (${mdfAllowedOrdersSql(user)})
      SELECT h.received_revision_key received,h.accepted_revision_key accepted,h.version::text version,
        h.correction_epoch::text epoch,p.received_revision_key "publishedReceived",p.issues,
        (SELECT count(*)::int FROM (${mdfPublishedCardOwnersSql('p')}) x) "ownerCount",
        (SELECT count(*)::int FROM (${mdfPublishedCardOwnersSql('p')}) x(order_id)
          WHERE EXISTS(SELECT 1 FROM allowed a WHERE a.order_id=x.order_id)) "allowedCount"
      FROM mdf_source_heads h
      LEFT JOIN mdf_published_sources p ON p.source_kind=h.source_kind AND p.source_id=h.source_id
      WHERE h.source_kind='bazisCutSet' AND h.source_id=$2::text`, [user.id, setId])).rows[0];
    if (!row) return unavailable('MDF_SOURCE_NOT_REGISTERED');
    if (!row.publishedReceived || row.publishedReceived !== row.received || row.accepted !== row.received) {
      return unavailable('MDF_PUBLICATION_PENDING');
    }
    if ((row.issues ?? []).length) return unavailable('MDF_SOURCE_ISSUES');
    const fullScope = rolePolicyForUser(user).orders.view === 'all';
    if (row.allowedCount !== row.ownerCount || (row.ownerCount === 0 && !fullScope)) return unavailable('MDF_PARTIAL_ACCESS');
    const eligibleRowIds = [...mdfBazisEligibleRowIdsFromRaw(
      await loadMdfBazisCompositionRawSnapshot(tx, { setId })).rowIds];
    return { available: true, reason: null, eligibleRowIds,
      sourceToken: mdfSourceCommandToken({ kind: 'bazisCutSet', id: String(setId) },
        { received: row.received, version: row.version, epoch: row.epoch }) };
  });
}
