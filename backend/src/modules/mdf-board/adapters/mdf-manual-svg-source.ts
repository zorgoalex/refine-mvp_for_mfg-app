import { createHash } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { buildOrderReadScopePredicate, normalizeActorUserId, orderAssignmentExistsSql } from '../../../permissions/policies/order-read-scope-sql';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import { cncPacketCountsForMdfReadinessSql, CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF,
  CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { requireMdfCommandBoundary } from '../application/mdf-command-boundary';
import { recordMdfReceipt } from '../application/mdf-receipt';
import { loadMdfExecutionDetails } from './mdf-execution-snapshot';

const scopes = new WeakMap<TransactionClient, readonly number[]>();
const created = new WeakMap<TransactionClient, Set<string>>();
interface TelegramHandoff { itemId:string; userId:string; sourceDigest:string; duplicate:boolean }
const telegramImports = new WeakMap<TransactionClient, TelegramHandoff>();
/** Internal, transaction-local capability. An HTTP duplicatePolicy is not an authorization. */
export function authorizeMdfTelegramSvg(tx:TransactionClient, input:TelegramHandoff):void {
  telegramImports.set(tx,{...input});
}
export function assertMdfTelegramSvg(tx:TransactionClient,itemId:string,userId:string):void {
  const handoff=telegramImports.get(tx);
  if (!handoff || handoff.itemId!==itemId || handoff.userId!==userId) {
    throw new ApiError(409,'CNC_TELEGRAM_DUPLICATE_APPROVAL_INVALID','Требуется проверенная команда импорта Telegram');
  }
}
export function hasMdfTelegramDuplicate(tx:TransactionClient):boolean { return telegramImports.get(tx)?.duplicate===true; }
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Before SVG, packet or idempotency locks. Never authorize a historical replay
 * from a mutable source's current owners alone. */
export async function lockMdfManualSvgOwners(tx: TransactionClient, user: CurrentUser, selected: readonly number[]): Promise<void> {
  const boundary = await requireMdfCommandBoundary(tx,{ writer:'cnc.manual_svg_upload',capability:'queued' });
  if (!boundary.queued) return;
  if (!user.permissions.includes('cut.manage') || !user.permissions.includes('orders.view')) denied();
  const owners = [...new Set(selected)].sort((a,b)=>a-b), policy = rolePolicyForUser(user).orders.view;
  if (owners.length>100 || owners.some(id=>!positive(id))) invalid();
  if (!owners.length && policy!=='all') denied();
  const params: unknown[] = [owners];
  const actor = policy==='own' || policy==='assigned' ? params.push(normalizeActorUserId(user.id)) : null;
  const predicate = buildOrderReadScopePredicate(policy,actor,actor===null?'FALSE':orderAssignmentExistsSql('o',actor),'o');
  const rows = (await tx.query(`SELECT o.order_id FROM orders o WHERE o.order_id=ANY($1::bigint[])
    AND NOT o.delete_flag AND o.order_kind='production_order' AND ${predicate} ORDER BY o.order_id FOR UPDATE`,params)).rows;
  if (rows.length!==owners.length) denied();
  for (const [table,id] of [['order_details','detail_id'],['order_hdf_details','order_hdf_detail_id']]) {
    const locked = (await tx.query(`SELECT ${id} FROM ${table} WHERE order_id=ANY($1::bigint[])
      ORDER BY order_id,${id} LIMIT 5001 FOR UPDATE`,[owners])).rows;
    if (locked.length>5000) invalid();
  }
  scopes.set(tx,owners);
}

export function registerNewMdfManualSvgSource(tx: TransactionClient, packetId: string): void {
  const ids=created.get(tx) ?? new Set<string>(); ids.add(packetId); created.set(tx,ids);
}

export function assertMdfManualSvgMatchScope(tx: TransactionClient,
  items: readonly { matchOrderId?: number|null; orderId?: number|null }[]): void {
  const owners=scopes.get(tx);
  if (!owners) return;
  if (items.length>5000) invalid();
  for (const item of items) for (const id of [item.matchOrderId,item.orderId]) {
    if (id!=null && !owners.includes(id)) denied();
  }
}

export async function assertMdfManualSvgReplayScope(tx: TransactionClient, packetId: string): Promise<void> {
  const owners=scopes.get(tx);
  if (!owners) return; // legacy command; no new ownership semantics
  const rows=(await tx.query<{ owner: number }>(`SELECT DISTINCT owner::float8 FROM (
    SELECT match_order_id owner FROM cnc_telegram_packet_items WHERE packet_id=$1::uuid
    UNION SELECT order_id FROM mdf_revision_demand WHERE source_kind='packet' AND source_id=$1::text
    ) ids WHERE owner IS NOT NULL LIMIT 101`,[packetId])).rows;
  if (rows.length>100 || rows.some(row=>!owners.includes(row.owner))) denied();
}

/** Upload confirms membership only. Neither comments, detail ranks, an imported
 * cut result nor successful rendering prove that the machine has cut anything. */
export async function captureNewMdfManualSvgSource(tx: TransactionClient, input: {
  packetId: string; user: CurrentUser; requestId: string;
}): Promise<string | undefined> {
  const boundary=await requireMdfCommandBoundary(tx,{ writer:'cnc.manual_svg_upload.capture',capability:'queued' });
  if (!boundary.queued) return;
  const owners=scopes.get(tx);
  if (!owners || !created.get(tx)?.delete(input.packetId)) invalid();
  const header=(await tx.query<{ eligible: boolean; name: string; createdAt: string; rework: boolean;
    resultId: number|null; resultDigest: string|null; payloadHash: string; projectionComplete: boolean|null }>(`SELECT
    ${cncPacketCountsForMdfReadinessSql('p')} eligible,COALESCE(p.program_name,p.external_packet_key) name,
    COALESCE(p.source_created_at,p.created_at)::text "createdAt",p.rework,p.svg_cut_result_id::float8 "resultId",
    r.snapshot_digest "resultDigest",p.payload_hash "payloadHash",
    (l.snapshot_digest=r.snapshot_digest AND l.sheet_count=(SELECT count(*) FROM cut_result_sheet_map WHERE cut_result_id=r.cut_result_id)
      AND l.placement_count=(SELECT count(*) FROM cut_result_placement WHERE cut_result_id=r.cut_result_id)) "projectionComplete"
    FROM cnc_telegram_packets p LEFT JOIN cut_result r ON r.cut_result_id=p.svg_cut_result_id
    LEFT JOIN cut_result_label_map_projection l ON l.cut_result_id=r.cut_result_id
    WHERE p.packet_id=$1::uuid AND p.source_chat_id='erp-manual-svg-upload'
      AND p.completion_status='pending' AND NOT p.thumbs_up`,[input.packetId])).rows[0];
  if (!header) invalid();
  if (!header.eligible) return;
  const items=(await tx.query<{ key: string; owner: number|null; detail: number|null; quantity: number;
    status: string; liveOwner: number|null; material: string|null }>(`SELECT i.packet_item_id::text key,
    i.match_order_id::float8 owner,i.match_detail_id::float8 detail,i.quantity::float8 quantity,
    i.match_status status,d.order_id::float8 "liveOwner",COALESCE(mt.name,m.material_name) material
    FROM cnc_telegram_packet_items i LEFT JOIN order_details d ON d.detail_id=i.match_detail_id AND NOT d.delete_flag
    LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE i.packet_id=$1::uuid ORDER BY i.packet_item_id LIMIT 5001`,[input.packetId])).rows;
  if (items.length>5000) invalid();
  const demand=(await loadMdfExecutionDetails(tx,owners)).map(({orderId,detailId,quantity})=>({orderId,detailId,quantity}));
  const members = new Map<number,{ lineKey: string; orderId: number; detailId: number; quantity: number }>();
  let complete=items.length>0;
  for (const item of items) {
    if (item.owner!==null && !owners.includes(item.owner)) denied();
    if (!positive(item.quantity)) invalid();
    if (item.status!=='matched' || !positive(item.detail) || !positive(item.owner)
      || item.liveOwner!==item.owner || !item.material?.trim()) { complete=false; continue; }
    if (!new RegExp(MDF,'i').test(item.material) || new RegExp(OTHER,'i').test(item.material)) continue;
    const live=demand.find(d=>d.orderId===item.owner && d.detailId===item.detail);
    if (!live) { complete=false; continue; }
    const quantity=(members.get(item.detail)?.quantity ?? 0)+item.quantity;
    if (!positive(quantity) || (!header.rework && quantity>live.quantity)) invalid();
    members.set(item.detail,{ lineKey:`detail:${item.detail}`,orderId:item.owner,detailId:item.detail,quantity });
  }
  // Parser quantities and layout placement counts are independent, especially
  // in lenient uploads. Neither may silently stand in for the other. Validate
  // the exact frozen result, never the mutable job or archive JSON.
  const placements=(await tx.query<{ owner:number|null; detail:number|null; hdf:number|null; quantity:number;
    liveOwner:number|null; material:string|null }>(`SELECT p.order_id::float8 owner,p.order_detail_id::float8 detail,
    p.order_hdf_detail_id::float8 hdf,count(*)::float8 quantity,d.order_id::float8 "liveOwner",COALESCE(mt.name,m.material_name) material
    FROM cut_result_placement p JOIN cut_result_sheet_map s ON s.cut_result_sheet_map_id=p.cut_result_sheet_map_id
      AND s.cut_result_id=p.cut_result_id AND s.is_effective
    LEFT JOIN order_details d ON d.detail_id=p.order_detail_id AND NOT d.delete_flag
    LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE p.cut_result_id=$1 GROUP BY p.order_id,p.order_detail_id,p.order_hdf_detail_id,d.order_id,mt.name,m.material_name
    ORDER BY p.order_id,p.order_detail_id,p.order_hdf_detail_id LIMIT 5001`,[header.resultId])).rows;
  if (placements.length>5000) invalid();
  if (!header.projectionComplete || !placements.length) complete=false;
  const projected = new Map<number,number>();
  for (const p of placements) {
    if (p.owner!==null && !owners.includes(p.owner)) denied();
    if (p.hdf!==null) continue;
    if (!positive(p.owner) || !positive(p.detail) || p.liveOwner!==p.owner || !p.material?.trim()) { complete=false; continue; }
    if (!new RegExp(MDF,'i').test(p.material) || new RegExp(OTHER,'i').test(p.material)) continue;
    if (members.get(p.detail)?.orderId!==p.owner || !positive(p.quantity)) complete=false;
    projected.set(p.detail,p.quantity);
  }
  if (projected.size!==members.size || [...members].some(([id,m])=>projected.get(id)!==m.quantity)) complete=false;
  if (complete && !members.size) return; // Known non-MDF/HDF-only composition.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`mdf-source:${JSON.stringify(['packet',input.packetId])}`]);
  if ((await tx.query("SELECT 1 FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1",[input.packetId])).rows.length) invalid();
  const rules=(await tx.query<{ ruleId:number; version:number }>(`SELECT id::float8 "ruleId",version
    FROM status_automation_rules WHERE is_enabled ORDER BY id`)).rows;
  const revisionKey=`manual-svg-created:${input.packetId}`;
  const imported=telegramImports.get(tx);
  const result=await recordMdfReceipt(tx,{ sourceKind:'packet',sourceId:input.packetId,revisionKey,origin:'derived',
    actorUserId:Number(input.user.id),requestId:input.requestId,causeKey:revisionKey,expectedFence:null,accept:complete && !imported?.duplicate,rules,
    sourceDigest:createHash('sha256').update(JSON.stringify([header.payloadHash,header.resultDigest,imported ?? null])).digest('hex'),
    lines:[...members.values()].map(m=>({...m,stageCode:'membership',evidenceKind:'derived' as const,rework:header.rework})),
    executionContext:{ sourceCreatedAt:header.createdAt,displayName:header.name,priorColumn:'parsed',manualPlacementColumn:null,
      compositionComplete:complete,demand } });
  return result.jobId;
}

function invalid(): never { throw new ApiError(409,'MDF_SVG_SOURCE_INVALID','Не удалось подтвердить состав SVG-файла'); }
function denied(): never { throw new ApiError(403,'PERMISSION_DENIED','Нет доступа ко всем заказам SVG-файла'); }
