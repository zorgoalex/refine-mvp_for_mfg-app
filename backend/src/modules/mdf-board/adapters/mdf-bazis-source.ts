import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { requireMdfCommandBoundary } from '../application/mdf-command-boundary';
import { recordMdfReceipt } from '../application/mdf-receipt';
import { loadMdfExecutionDetails } from './mdf-execution-snapshot';

// Provenance is transaction-local, never inferred from a missing ledger head or
// a recent timestamp. Only the actual header INSERT registers new sources.
const created = new WeakMap<TransactionClient, Set<number>>();
export function registerNewMdfBazisSource(tx: TransactionClient, setId: number): void {
  const ids = created.get(tx) ?? new Set<number>();
  ids.add(setId); created.set(tx,ids);
}

/** Called by the owning BASIS create transaction AFTER sorted owner/selected
 * detail locks and typed snapshot inserts. This captures NEW membership, not
 * physical production and not historical acceptance. Existing-source edits need
 * their own correction/preflight path. No legacy dispatch or archive JSON read.
 */
export async function captureNewMdfBazisSource(tx: TransactionClient, input: {
  setId: number; lockedOrderIds: readonly number[]; user: CurrentUser; requestId: string;
}): Promise<string | undefined> {
  const boundary = await requireMdfCommandBoundary(tx,{ writer: 'bazis.create',capability: 'queued' });
  if (boundary.mode !== 'active') throw new Error('MDF_ACTIVE_COMMAND_REQUIRED');
  const { setId,user } = input;
  if (!user.permissions.includes('cut.manage') || !user.permissions.includes('orders.view')) {
    throw new ApiError(403,'PERMISSION_DENIED','Недостаточно прав для создания набора');
  }
  if (!Number.isSafeInteger(setId) || setId <= 0 || !created.get(tx)?.delete(setId)) {
    throw new ApiError(409,'MDF_NEW_SOURCE_REQUIRED','Набор требует отдельного подтверждения истории');
  }
  const owners = [...new Set(input.lockedOrderIds)].sort((a,b) => a-b);
  if (!owners.length || owners.length > 100 || owners.some(id => !Number.isSafeInteger(id) || id <= 0)) invalid();
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`mdf-source:${JSON.stringify(['bazisCutSet',String(setId)])}`]);
  if ((await tx.query("SELECT 1 FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1",[String(setId)])).rows.length) {
    throw new ApiError(409,'MDF_NEW_SOURCE_REQUIRED','Идентификатор набора уже используется в производственной истории');
  }
  const header = (await tx.query<{ name: string; createdAt: string }>(`SELECT name,created_at::text "createdAt"
    FROM bazis_cut_sets WHERE bazis_cut_set_id=$1`,[setId])).rows[0];
  if (!header) invalid();
  const members = (await tx.query<{ lineKey: string; orderId: number; detailId: number; quantity: number }>(`
    SELECT bazis_cut_set_detail_id::text "lineKey",source_order_id::float8 "orderId",
      source_order_detail_id::float8 "detailId",quantity::float8 quantity
    FROM bazis_cut_set_details WHERE bazis_cut_set_id=$1 AND cut_enabled
      AND source_type='order_detail' AND source_order_hdf_detail_id IS NULL
      AND COALESCE(material_name,'') ~* $2 AND COALESCE(material_name,'') !~* $3
    ORDER BY bazis_cut_set_detail_id LIMIT 5001`,[setId,MDF,OTHER])).rows;
  if (!members.length) return undefined; // Normal HDF/non-MDF sets are outside the MDF ledger.
  if (members.length > 5000) invalid();
  const details = await loadMdfExecutionDetails(tx,owners);
  const seen = new Set<number>();
  for (const m of members) {
    if (![m.orderId,m.detailId,m.quantity].every(n => Number.isSafeInteger(n) && n > 0)
      || !m.lineKey || seen.has(m.detailId) || !owners.includes(m.orderId)
      || !details.some(d => d.orderId === m.orderId && d.detailId === m.detailId && d.quantity === m.quantity)) invalid();
    seen.add(m.detailId);
  }
  // Owners with only HDF/non-MDF parts need no MDF demand. All selected owners
  // were authorized by the command; the receipt freezes complete MDF demand.
  const demand = details.map(({ orderId,detailId,quantity }) => ({ orderId,detailId,quantity }));
  const rules = (await tx.query<{ ruleId: number; version: number }>(`SELECT id::float8 "ruleId",version
    FROM status_automation_rules WHERE is_enabled ORDER BY id`)).rows;
  const revisionKey = `bazis-created:${setId}`;
  const saved = await recordMdfReceipt(tx,{ sourceKind: 'bazisCutSet',sourceId: String(setId),revisionKey,
    origin: 'derived',actorUserId: Number(user.id),requestId: input.requestId,causeKey: revisionKey,
    expectedFence: null,accept: true,rules,
    lines: members.map(m => ({ ...m,stageCode: 'membership',evidenceKind: 'derived' as const,rework: false })),
    executionContext: { sourceCreatedAt: header.createdAt,displayName: header.name,priorColumn: 'parsed',
      manualPlacementColumn: null,compositionComplete: true,demand } });
  return saved.jobId;
}

function invalid(): never {
  throw new ApiError(409,'MDF_NEW_SOURCE_INVALID','Состав набора изменился. Обновите выбранные детали');
}
