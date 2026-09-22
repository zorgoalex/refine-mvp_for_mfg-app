import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { buildOrderReadScopePredicate, normalizeActorUserId, orderAssignmentExistsSql } from '../../../permissions/policies/order-read-scope-sql';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { requireMdfCommandBoundary } from '../application/mdf-command-boundary';
import { recordMdfReceipt } from '../application/mdf-receipt';
import { loadMdfExecutionDetails } from './mdf-execution-snapshot';

interface BasketItem {
  itemId: string; orderId: number; detailId: number | null; hdfId: number | null;
  sourceType: string; liveOrderId: number | null; quantity: number | null;
  material: string | null; width: number | null; height: number | null; selectedQuantity: number;
}
interface Scope { owners: number[]; items: BasketItem[]; signature: string }
const scopes = new WeakMap<TransactionClient, Scope>();
const insertedResults = new WeakMap<TransactionClient, Set<number>>();
const isMdf = (name: string | null) => new RegExp(MDF,'i').test(name ?? '') && !new RegExp(OTHER,'i').test(name ?? '');
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

async function readScope(tx: TransactionClient, cutJobId: number, commandId: string): Promise<Scope> {
  // LEFT joins are intentional: deleted/reparented/unresolved items must not
  // disappear before validation. HDF is identified by type, never name alone.
  const items = (await tx.query<BasketItem>(`SELECT i.freecut_item_id "itemId",i.order_id::float8 "orderId",i.qty::float8 "selectedQuantity",
    i.order_detail_id::float8 "detailId",i.order_hdf_detail_id::float8 "hdfId",i.source_type "sourceType",
    (CASE WHEN i.source_type='order_hdf_detail' THEN h.order_id ELSE d.order_id END)::float8 "liveOrderId",
    (CASE WHEN i.source_type='order_hdf_detail' THEN h.quantity ELSE d.quantity END)::float8 quantity,
    CASE WHEN i.source_type='order_hdf_detail' THEN h.hdf_sheet_material_name ELSE COALESCE(mt.name,m.material_name) END material,
    (CASE WHEN i.source_type='order_hdf_detail' THEN h.hdf_width_mm ELSE d.width END)::float8 width,
    (CASE WHEN i.source_type='order_hdf_detail' THEN h.hdf_height_mm ELSE d.height END)::float8 height
    FROM cut_job_item i
    LEFT JOIN order_details d ON d.detail_id=i.order_detail_id AND NOT d.delete_flag
    LEFT JOIN order_hdf_details h ON h.order_hdf_detail_id=i.order_hdf_detail_id AND NOT h.delete_flag
    LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE i.cut_job_id=$1 AND i.is_active ORDER BY i.cut_job_item_id LIMIT 5001`,[cutJobId])).rows;
  // A completed replay still belongs to the frozen result owners, even if the
  // current basket was emptied or replaced. Never authorize only today's basket.
  const replayOwners = (await tx.query<{ orderId: number }>(`SELECT DISTINCT owner_id::float8 "orderId" FROM (
    SELECT p.order_id owner_id FROM cut_result_command c JOIN cut_result_placement p ON p.cut_result_id=c.cut_result_id
      WHERE c.cut_job_id=$1 AND c.command_id=$2::uuid
    UNION SELECT d.order_id FROM cut_result_command c JOIN mdf_revision_demand d
      ON d.source_kind='bath' AND d.source_id='cut-result:' || c.cut_result_id::text
      WHERE c.cut_job_id=$1 AND c.command_id=$2::uuid
    ) owners WHERE owner_id IS NOT NULL ORDER BY 1 LIMIT 101`,[cutJobId,commandId])).rows;
  const owners = [...new Set([...items.map(i => i.orderId),...replayOwners.map(r => r.orderId)])].sort((a,b) => a-b);
  if (items.length > 5000 || owners.length > 100 || owners.some(id => !positive(id))) invalid();
  return { owners,items,signature: JSON.stringify([owners,items]) };
}

/** Called BEFORE the cut-job lock in each calculation phase. The caller then
 * rechecks closure after locking the job, never acquiring late owner locks. */
export async function lockMdfCutOwners(tx: TransactionClient, input: {
  cutJobId: number; commandId: string; user: CurrentUser;
}): Promise<string | undefined> {
  const boundary = await requireMdfCommandBoundary(tx,{ writer: 'cut.calculate.owners',capability: 'queued' });
  if (!boundary.queued) return undefined;
  if (!input.user.permissions.includes('cut.manage') || !input.user.permissions.includes('orders.view')) denied();
  const scope = await readScope(tx,input.cutJobId,input.commandId);
  const params: unknown[] = [scope.owners];
  const policy = rolePolicyForUser(input.user).orders.view;
  const actor = policy === 'own' || policy === 'assigned' ? params.push(normalizeActorUserId(input.user.id)) : null;
  const predicate = buildOrderReadScopePredicate(policy,actor,actor === null ? 'FALSE' : orderAssignmentExistsSql('o',actor),'o');
  const owners = (await tx.query(`SELECT o.order_id FROM orders o WHERE o.order_id=ANY($1::bigint[])
    AND NOT o.delete_flag AND o.order_kind='production_order' AND ${predicate} ORDER BY o.order_id FOR UPDATE`,params)).rows;
  if (owners.length !== scope.owners.length) denied();
  // Freeze full owning demand, not just selected positions. Raw detail writers
  // must wait too. HDF locks follow ordinary details in the common lock order.
  await tx.query(`SELECT detail_id FROM order_details WHERE order_id=ANY($1::bigint[])
    ORDER BY order_id,detail_id FOR UPDATE`,[scope.owners]);
  await tx.query(`SELECT order_hdf_detail_id FROM order_hdf_details WHERE order_id=ANY($1::bigint[])
    ORDER BY order_id,order_hdf_detail_id FOR UPDATE`,[scope.owners]);
  scopes.set(tx,scope);
  return scope.signature;
}

export async function recheckMdfCutOwners(tx: TransactionClient, input: {
  cutJobId: number; commandId: string; expectedSignature?: string;
}): Promise<void> {
  const scope = scopes.get(tx);
  if (!scope) {
    if (input.expectedSignature) throw new ApiError(409,'MDF_CUT_SCOPE_CHANGED','Режим производственного учёта изменился. Повторите расчёт');
    return; // legacy/shadow: no new ownership behavior
  }
  const current = await readScope(tx,input.cutJobId,input.commandId);
  if (scope.signature !== current.signature || (input.expectedSignature !== undefined && input.expectedSignature !== current.signature)) {
    throw new ApiError(409,'MDF_CUT_SCOPE_CHANGED','Состав раскроя изменился. Повторите расчёт');
  }
}

/** Only the actual immutable result INSERT can register freshness. */
export function registerNewMdfBathResult(tx: TransactionClient, resultId: number): void {
  const ids = insertedResults.get(tx) ?? new Set<number>();
  ids.add(resultId); insertedResults.set(tx,ids);
}

export async function captureNewMdfBathResult(tx: TransactionClient, input: {
  cutJobId: number; cutResultId: number; user: CurrentUser; requestId: string;
}): Promise<string | undefined> {
  const boundary = await requireMdfCommandBoundary(tx,{ writer: 'cut.calculate.capture',capability: 'queued' });
  if (!boundary.queued) return undefined;
  const scope = scopes.get(tx),id = input.cutResultId;
  if (!scope || !positive(id) || !insertedResults.get(tx)?.delete(id)) invalid();
  const header = (await tx.query<{ isVacuum: boolean; name: string; createdAt: string; complete: boolean; hasPrior: boolean }>(`
    SELECT b.is_vacuum "isVacuum",b.cut_job_name name,b.result_created_at::text "createdAt",
      (p.snapshot_digest=r.snapshot_digest AND p.sheet_count=(SELECT count(*) FROM cut_result_sheet_map WHERE cut_result_id=r.cut_result_id)
       AND p.placement_count=(SELECT count(*) FROM cut_result_placement WHERE cut_result_id=r.cut_result_id)) complete,
      EXISTS(SELECT 1 FROM cut_result prior WHERE prior.cut_job_id=r.cut_job_id AND prior.cut_result_id<>r.cut_result_id) "hasPrior"
    FROM cut_result r JOIN cut_result_board_projection b ON b.cut_result_id=r.cut_result_id AND b.snapshot_digest=r.snapshot_digest
    LEFT JOIN cut_result_label_map_projection p ON p.cut_result_id=r.cut_result_id
    WHERE r.cut_result_id=$1 AND r.cut_job_id=$2`,[id,input.cutJobId])).rows[0];
  if (!header || header.complete !== true) invalid();
  if (!header.isVacuum) return undefined;
  const placements = (await tx.query<{ itemId: string; orderId: number | null; detailId: number | null; quantity: number }>(`
    SELECT p.item_id "itemId",p.order_id::float8 "orderId",p.order_detail_id::float8 "detailId",count(*)::float8 quantity
    FROM cut_result_placement p JOIN cut_result_sheet_map s ON s.cut_result_sheet_map_id=p.cut_result_sheet_map_id
      AND s.cut_result_id=p.cut_result_id
    WHERE p.cut_result_id=$1 AND s.is_effective
    GROUP BY p.item_id,p.order_id,p.order_detail_id ORDER BY p.item_id,p.order_id,p.order_detail_id LIMIT 5001`,[id])).rows;
  if (placements.length > 5000) invalid();
  const members: Array<{ lineKey: string; orderId: number; detailId: number; quantity: number }> = [];
  const seen = new Set<number>();
  for (const p of placements) {
    const matching = scope.items.filter(i => i.itemId === p.itemId);
    if (matching.length !== 1) invalid();
    const item = matching[0];
    if (!positive(p.quantity) || p.orderId !== item.orderId || item.liveOrderId !== item.orderId
      || !positive(item.quantity) || !positive(item.selectedQuantity)
      || p.quantity > item.quantity || p.quantity > item.selectedQuantity) invalid();
    if (item.sourceType === 'order_hdf_detail') {
      if (!positive(item.hdfId) || item.detailId !== null || p.detailId !== null) invalid();
      continue;
    }
    if (item.sourceType !== 'order_detail' || item.hdfId !== null || !positive(item.detailId)
      || p.detailId !== item.detailId || !item.material) invalid();
    if (!isMdf(item.material)) continue;
    if (seen.has(item.detailId)) invalid();
    seen.add(item.detailId);
    members.push({ lineKey: p.itemId,orderId: item.orderId,detailId: item.detailId,quantity: p.quantity });
  }
  if (!members.length) return undefined;
  const details = await loadMdfExecutionDetails(tx,scope.owners);
  for (const m of members) if (!details.some(d => d.orderId===m.orderId && d.detailId===m.detailId && d.quantity>=m.quantity)) invalid();
  const sourceId = `cut-result:${id}`;
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`mdf-source:${JSON.stringify(['bath',sourceId])}`]);
  if ((await tx.query("SELECT 1 FROM mdf_source_heads WHERE source_kind='bath' AND source_id=$1",[sourceId])).rows.length) invalid();
  const rules = (await tx.query<{ ruleId: number; version: number }>(`SELECT id::float8 "ruleId",version
    FROM status_automation_rules WHERE is_enabled ORDER BY id`)).rows;
  const revisionKey = `bath-created:${id}`;
  const saved = await recordMdfReceipt(tx,{ sourceKind: 'bath',sourceId,revisionKey,origin: 'derived',
    actorUserId: Number(input.user.id),requestId: input.requestId,causeKey: revisionKey,expectedFence: null,
    // Recalculation is NOT confirmation that the old physical parts were made
    // again. Keep known membership visible but withhold automatic credit.
    accept: !header.hasPrior,rules,
    lines: members.map(m => ({ ...m,stageCode: 'membership',evidenceKind: 'derived' as const,rework: false })),
    executionContext: { sourceCreatedAt: header.createdAt,displayName: header.name,priorColumn: 'baths',
      manualPlacementColumn: null,compositionComplete: true,
      demand: details.map(({ orderId,detailId,quantity }) => ({ orderId,detailId,quantity })) } });
  return saved.jobId;
}

function invalid(): never { throw new ApiError(409,'MDF_CUT_SOURCE_INVALID','Не удалось подтвердить полный состав результата раскроя'); }
function denied(): never { throw new ApiError(403,'PERMISSION_DENIED','Нет доступа ко всем заказам раскроя'); }
