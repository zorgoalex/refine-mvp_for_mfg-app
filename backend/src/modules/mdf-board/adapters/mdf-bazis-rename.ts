import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { buildOrderReadScopePredicate, normalizeActorUserId, orderAssignmentExistsSql } from '../../../permissions/policies/order-read-scope-sql';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { requireMdfCommandBoundary } from '../application/mdf-command-boundary';
import { recordMdfReceipt, type MdfReceiptLine } from '../application/mdf-receipt';
import { loadMdfExecutionDetails, loadMdfExecutionSnapshot, mdfSourceKey } from './mdf-execution-snapshot';

interface SetMember {
  lineKey: string; sourceType: string; orderId: number | null; detailId: number | null;
  hdfDetailId: number | null; quantity: number; materialName: string | null; cutEnabled: boolean;
}
interface Head { received: string; accepted: string | null; version: string; correctionEpoch: string }
interface DemandRow { orderId: number; detailId: number; quantity: number }
interface OwnerRow { orderId: number; createdBy: string | null; managerId: string | null; assigned: string[] }

export interface ExecuteMdfBazisRenameInput {
  setId: number;
  expectedVersion: number;
  name: string;
  user: CurrentUser;
  requestId: string;
}
export interface ExecuteMdfBazisRenameResult {
  changed: boolean;
  beforeName: string;
  beforeVersion: number;
  owners: number[];
  mdfJobId?: string;
}

/**
 * Active-only metadata rename preflight. Lock order is owning production orders,
 * referenced ordinary/HDF details, MDF source advisory/head, then the BASIS set.
 * It preserves every accepted evidence line; only sealed display metadata and
 * its ordinary rules-empty publication receipt are appended.
 */
export async function executeMdfBazisRename(
  tx: TransactionClient,
  input: ExecuteMdfBazisRenameInput,
): Promise<ExecuteMdfBazisRenameResult> {
  const boundary = await requireMdfCommandBoundary(tx, { writer: 'bazis.rename', capability: 'queued' });
  if (boundary.mode !== 'active') {
    throw new ApiError(409, 'MDF_ENGINE_NOT_ACTIVE', 'Переименование MDF набора доступно только в активном режиме');
  }
  if (!input.user.permissions.includes('cut.manage') || !input.user.permissions.includes('orders.view')) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для переименования набора');
  }
  const key = ['bazisCutSet', String(input.setId)];
  const source = { kind: 'bazisCutSet' as const, id: String(input.setId) };

  // Discovery is deliberately non-locking. All owners are collected before
  // acquiring any row locks, then re-read under the complete owner set.
  const discoveredSet = await loadSetMembers(tx, input.setId);
  const discoveredHead = (await tx.query<Head>(`SELECT received_revision_key received,accepted_revision_key accepted,
    version::text,correction_epoch::text "correctionEpoch" FROM mdf_source_heads
    WHERE source_kind=$1 AND source_id=$2`, key)).rows[0] ?? null;
  let discoveredDemand: DemandRow[] = [];
  if (discoveredHead?.accepted) discoveredDemand = await loadDemand(tx, source.id, discoveredHead.accepted);
  const owners = uniqueSorted([
    ...discoveredSet.map(row => row.orderId),
    ...discoveredDemand.map(row => row.orderId),
  ]);
  if (owners.length > 100 || discoveredSet.length > 5000 || discoveredDemand.length > 5000) reconcile();
  if (owners.length) await lockOwners(tx, input.user, owners);
  await lockSourceDetails(tx, discoveredSet, discoveredDemand, owners);

  // The source lock serializes against receipt writers; the set lock follows
  // the source lock to avoid inversions with MDF command paths.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `mdf-source:${JSON.stringify(key)}`,
  ]);
  const head = (await tx.query<Head>(`SELECT received_revision_key received,accepted_revision_key accepted,
    version::text,correction_epoch::text "correctionEpoch" FROM mdf_source_heads
    WHERE source_kind=$1 AND source_id=$2 FOR UPDATE`, key)).rows[0] ?? null;
  const set = (await tx.query<{ name: string; version: number }>(`SELECT name,version FROM bazis_cut_sets
    WHERE bazis_cut_set_id=$1 FOR UPDATE`, [input.setId])).rows[0];
  if (!set) throw new ApiError(404, 'BAZIS_CUT_SET_NOT_FOUND', 'Набор не найден');
  if (Number(set.version) !== input.expectedVersion) {
    throw new ApiError(409, 'BAZIS_CUT_SET_STALE_VERSION', 'Набор был изменён другим пользователем', {
      expectedVersion: input.expectedVersion, actualVersion: Number(set.version),
    });
  }
  const currentSet = await loadSetMembers(tx, input.setId);
  if (!sameSetMembers(discoveredSet, currentSet)) reconcile();
  const selected = classifyMdfMembers(currentSet);
  if (selected.hasUnknown) reconcile();
  if (set.name === input.name) {
    return { changed: false, beforeName: set.name, beforeVersion: Number(set.version), owners };
  }
  if (Boolean(head) !== Boolean(discoveredHead)
    || (head && discoveredHead && (head.received !== discoveredHead.received
      || head.accepted !== discoveredHead.accepted || head.version !== discoveredHead.version
      || head.correctionEpoch !== discoveredHead.correctionEpoch))) reconcile();
  const demand = head?.accepted ? await loadDemand(tx, source.id, head.accepted) : [];
  if (!sameDemand(discoveredDemand, demand)) reconcile();

  if (!head) {
    // Never bootstrap an existing MDF set from the visual/raw BASIS snapshot.
    if (selected.members.length) reconcile();
    const currentMdfDemand = await loadMdfExecutionDetails(tx, owners);
    const currentMdfDetails = new Set(currentMdfDemand.map(row => row.detailId));
    if (currentSet.some(row => row.sourceType === 'order_detail' && row.detailId !== null
      && currentMdfDetails.has(row.detailId))) reconcile();
    return { changed: true, beforeName: set.name, beforeVersion: Number(set.version), owners };
  }
  if (!head.accepted || head.accepted !== head.received) reconcile();

  const acceptedJob = (await tx.query<{ status: string }>(`SELECT status FROM mdf_recalculation_jobs
    WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3`, [...key, head.accepted])).rows;
  if (acceptedJob.length !== 1 || acceptedJob[0].status !== 'done') {
    conflict('MDF_COMMAND_PENDING', 'Дождитесь завершения обработки карточки');
  }
  const published = (await tx.query<{ issues: string[] }>(`SELECT issues FROM mdf_published_sources
    WHERE source_kind=$1 AND source_id=$2 AND received_revision_key=$3
      AND accepted_revision_key=$3`, [...key, head.accepted])).rows[0];
  if (!published || published.issues.length !== 0) {
    conflict('MDF_COMMAND_PENDING', 'Дождитесь публикации карточки');
  }

  const snapshot = await loadMdfExecutionSnapshot(tx, [{ ...source, ...head, epoch: head.correctionEpoch }], owners);
  const sourceKey = mdfSourceKey(source);
  const metadata = snapshot.metadata.get(sourceKey);
  const issues = snapshot.issues.get(sourceKey) ?? ['MDF_CONTEXT_REQUIRED'];
  const frozenDemand = snapshot.frozenDemand.get(sourceKey) ?? [];
  if (!metadata || issues.length || frozenDemand.length === 0) reconcile();
  const lines = (await tx.query<MdfReceiptLine>(`SELECT line_key "lineKey",order_id::float8 "orderId",
    detail_id::float8 "detailId",quantity::float8 quantity,stage_code "stageCode",
    evidence_kind "evidenceKind",rework FROM mdf_evidence_lines
    WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3 ORDER BY line_key LIMIT 10001`,
  [...key, head.accepted])).rows;
  if (!selected.members.length || !lines.length || lines.length > 10000 || !sameMembership(selected.members, lines)) reconcile();

  const nextName = input.name;
  const revisionKey = `bazis-rename:${input.setId}:v${Number(set.version) + 1}`;
  const saved = await recordMdfReceipt(tx, {
    sourceKind: source.kind, sourceId: source.id, revisionKey, origin: 'manual',
    actorUserId: Number(input.user.id), requestId: input.requestId, causeKey: revisionKey,
    expectedFence: { version: head.version, correctionEpoch: head.correctionEpoch },
    accept: true, rules: [], lines,
    executionContext: {
      sourceCreatedAt: metadata.sourceCreatedAt, displayName: nextName,
      priorColumn: metadata.priorColumn, manualPlacementColumn: metadata.manualPlacementColumn,
      compositionComplete: true, demand: frozenDemand,
    },
  });
  return { changed: true, beforeName: set.name, beforeVersion: Number(set.version), owners, mdfJobId: saved.jobId };
}

async function loadSetMembers(tx: TransactionClient, setId: number): Promise<SetMember[]> {
  const rows = (await tx.query<SetMember>(`SELECT bazis_cut_set_detail_id::text "lineKey",source_type "sourceType",
    source_order_id::float8 "orderId",source_order_detail_id::float8 "detailId",
    source_order_hdf_detail_id::float8 "hdfDetailId",quantity::float8 quantity,material_name "materialName",
    cut_enabled "cutEnabled" FROM bazis_cut_set_details WHERE bazis_cut_set_id=$1
    ORDER BY bazis_cut_set_detail_id LIMIT 5001`, [setId])).rows;
  if (rows.length > 5000) reconcile();
  return rows;
}

async function loadDemand(tx: TransactionClient, sourceId: string, revisionKey: string): Promise<DemandRow[]> {
  const rows = (await tx.query<DemandRow>(`SELECT order_id::float8 "orderId",detail_id::float8 "detailId",
    quantity::float8 quantity FROM mdf_revision_demand WHERE source_kind='bazisCutSet' AND source_id=$1
      AND revision_key=$2 ORDER BY order_id,detail_id LIMIT 5001`, [sourceId, revisionKey])).rows;
  if (rows.length > 5000) reconcile();
  return rows;
}

async function lockOwners(tx: TransactionClient, user: CurrentUser, ids: number[]): Promise<void> {
  const params: unknown[] = [ids];
  const scope = rolePolicyForUser(user).orders.view;
  const actor = scope === 'own' || scope === 'assigned' ? params.push(normalizeActorUserId(user.id)) : 0;
  const predicate = buildOrderReadScopePredicate(scope, actor ? params.length : null,
    actor ? orderAssignmentExistsSql('o', params.length) : 'FALSE', 'o');
  const rows = (await tx.query<OwnerRow>(`SELECT o.order_id::float8 "orderId",o.created_by::text "createdBy",
    o.manager_id::text "managerId",ARRAY(SELECT u.user_id::text FROM order_workshops w
      JOIN users u ON u.employee_id=w.responsible_employee_id WHERE w.order_id=o.order_id
      AND NOT w.delete_flag AND u.is_active ORDER BY u.user_id) assigned
    FROM orders o WHERE o.order_id=ANY($1::bigint[]) AND NOT o.delete_flag
      AND o.order_kind='production_order' AND ${predicate}
    ORDER BY o.order_id FOR UPDATE OF o`, params)).rows;
  if (rows.length !== ids.length) throw new ApiError(403, 'PERMISSION_DENIED', 'Нет доступа ко всем заказам набора');
}

async function lockSourceDetails(
  tx: TransactionClient,
  members: readonly SetMember[],
  demand: readonly DemandRow[],
  owners: readonly number[],
): Promise<void> {
  const ordinaryExpected = new Map<number, number>();
  for (const row of members) {
    if (row.sourceType === 'order_detail') {
      if (!validId(row.orderId) || !validId(row.detailId) || row.hdfDetailId !== null) reconcile();
      putExpected(ordinaryExpected, row.detailId, row.orderId);
    } else if (row.sourceType === 'order_hdf_detail') {
      if (!validId(row.orderId) || !validId(row.hdfDetailId) || row.detailId !== null) reconcile();
    } else reconcile();
  }
  for (const row of demand) {
    if (!validId(row.orderId) || !validId(row.detailId) || !validDemandQuantity(row.quantity)) reconcile();
    putExpected(ordinaryExpected, row.detailId, row.orderId);
  }
  const hdfExpected = new Map<number, number>();
  for (const row of members) if (row.sourceType === 'order_hdf_detail') {
    putExpected(hdfExpected, row.hdfDetailId!, row.orderId!);
  }
  const ordinary = [...ordinaryExpected.keys()].sort((a,b) => a-b);
  if (ordinary.length) {
    const rows = (await tx.query<{ detailId: number; orderId: number }>(`SELECT detail_id::float8 "detailId",
      order_id::float8 "orderId" FROM order_details WHERE detail_id=ANY($1::bigint[])
        AND order_id=ANY($2::bigint[]) AND NOT delete_flag ORDER BY order_id,detail_id FOR UPDATE`,
    [ordinary, owners])).rows;
    if (rows.length !== ordinary.length || rows.some(row => ordinaryExpected.get(row.detailId) !== row.orderId)) reconcile();
  }
  const hdf = [...hdfExpected.keys()].sort((a,b) => a-b);
  if (hdf.length) {
    const rows = (await tx.query<{ detailId: number; orderId: number }>(`SELECT order_hdf_detail_id::float8 "detailId",
      order_id::float8 "orderId" FROM order_hdf_details WHERE order_hdf_detail_id=ANY($1::bigint[])
        AND order_id=ANY($2::bigint[]) AND NOT delete_flag ORDER BY order_id,order_hdf_detail_id FOR UPDATE`,
    [hdf, owners])).rows;
    if (rows.length !== hdf.length || rows.some(row => hdfExpected.get(row.detailId) !== row.orderId)) reconcile();
  }
}

function putExpected(expected: Map<number, number>, detailId: number, orderId: number): void {
  if (expected.has(detailId) && expected.get(detailId) !== orderId) reconcile();
  expected.set(detailId, orderId);
}
function validId(value: number | null): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function validQuantity(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function validDemandQuantity(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

function classifyMdfMembers(rows: readonly SetMember[]): { members: Array<{ lineKey: string; orderId: number; detailId: number; quantity: number }>; hasUnknown: boolean } {
  const members: Array<{ lineKey: string; orderId: number; detailId: number; quantity: number }> = [];
  let hasUnknown = false;
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.sourceType === 'order_hdf_detail') {
      if (row.hdfDetailId === null || row.orderId === null) hasUnknown = true;
      continue;
    }
    if (row.sourceType !== 'order_detail' || row.hdfDetailId !== null || row.orderId === null || row.detailId === null) {
      hasUnknown = true;
      continue;
    }
    const material = row.materialName ?? '';
    const isMdf = new RegExp(MDF, 'i').test(material);
    const isOther = new RegExp(OTHER, 'i').test(material);
    if (!isMdf || isOther) {
      if (!isOther) hasUnknown = true;
      continue;
    }
    if (!row.cutEnabled) { hasUnknown = true; continue; }
    if (!Number.isSafeInteger(row.orderId) || !row.orderId || !Number.isSafeInteger(row.detailId) || !row.detailId
      || !Number.isSafeInteger(row.quantity) || row.quantity <= 0 || !row.lineKey || keys.has(row.lineKey)) {
      hasUnknown = true;
      continue;
    }
    keys.add(row.lineKey);
    members.push({ lineKey: row.lineKey, orderId: row.orderId, detailId: row.detailId, quantity: row.quantity });
  }
  return { members, hasUnknown };
}

function sameMembership(members: ReturnType<typeof classifyMdfMembers>['members'], lines: readonly MdfReceiptLine[]): boolean {
  const membershipLines = lines.filter(line => line.stageCode === 'membership');
  if (membershipLines.some(line => line.evidenceKind !== 'derived' || line.rework)) return false;
  const actual = membershipLines
    .map(({ lineKey, orderId, detailId, quantity }) => ({ lineKey, orderId, detailId, quantity }))
    .sort((a,b) => a.lineKey.localeCompare(b.lineKey));
  return JSON.stringify(actual) === JSON.stringify([...members].sort((a,b) => a.lineKey.localeCompare(b.lineKey)));
}

function sameSetMembers(a: readonly SetMember[], b: readonly SetMember[]): boolean {
  const normalize = (rows: readonly SetMember[]) => rows.map(r => [r.lineKey,r.sourceType,r.orderId,r.detailId,
    r.hdfDetailId,r.quantity,r.materialName,r.cutEnabled]).sort((x,y) => String(x[0]).localeCompare(String(y[0])));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
function sameDemand(a: readonly DemandRow[], b: readonly DemandRow[]): boolean {
  const normalize = (rows: readonly DemandRow[]) => rows.map(r => [r.orderId,r.detailId,r.quantity])
    .sort((x,y) => Number(x[0])-Number(y[0]) || Number(x[1])-Number(y[1]));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
function uniqueSorted(values: Array<number | null>): number[] {
  const ids = [...new Set(values.filter((v): v is number => v !== null))].sort((a,b) => a-b);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) reconcile();
  return ids;
}
function reconcile(): never {
  throw new ApiError(409, 'MDF_COMMAND_RECONCILIATION_REQUIRED', 'Состав набора требует проверки перед переименованием');
}
function conflict(code: string, message: string): never { throw new ApiError(409, code, message); }
