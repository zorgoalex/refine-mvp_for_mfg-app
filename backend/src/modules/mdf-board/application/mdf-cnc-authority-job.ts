import { createHash } from 'node:crypto';
import { auditService } from '../../../common/audit/audit.service';
import type { TransactionClient } from '../../../database/database.types';
import type { MdfJob } from './mdf-job-runner';
import { MdfNeedsAttention } from './mdf-job-runner';
import type { MdfAcceptedLine, MdfAcceptedSource } from '../domain/mdf-accepted-projection';
import { mdfPositionKey, mdfSum, type MdfPositionQuantity } from '../domain/mdf-quantities';

const CNC_OBSERVATION_REVISION = /^cnc-observation:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CNC_AUTOCUT_SETTING = 'status_automation.cnc_mark_cut_details';

interface AuthorityRow {
  packet_id: string;
  claim_id: string;
  report_state: string;
  failure_code: string | null;
  report_digest: string;
  report: unknown;
  result: unknown;
  correction_epoch: string;
  head_version: string;
  raw_source_version: string;
  observation_version: string;
  target_accepted_revision_key: string;
  target_membership_digest: string;
  target_last_observation_version: string;
  target_state: string;
  current_raw_source_version: string;
  revision_origin: string;
  revision_cause_key: string;
  revision_request_id: string;
  revision_actor_user_id: string|null;
  target_source_chat_id: string;
  target_message_bindings: unknown;
}

export interface MdfCncAuthority {
  packetId: string;
  claimId: string;
  reportDigest: string;
  headVersion: string;
  correctionEpoch: string;
  rawSourceVersion: string;
  observationVersion: string;
  fenceState: 'none' | 'satisfied';
}

interface AcceptedHead {
  kind: string;
  id: string;
  accepted: string | null;
  received: string;
  epoch: string;
}

export interface MdfCncAuthorityEffectResult {
  changedOrderIds: number[];
  /** Completed business-header owners in the locked allocation closure. */
  completedOrderIds: number[];
}

function attention(code: string): never { throw new MdfNeedsAttention(`MDF_CNC_AUTHORITY_${code}`); }
function safePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function parsedJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  }
  return null;
}
function parsedJsonArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; }
    catch { return null; }
  }
  return null;
}

function isCompletedBoundReport(reportValue: unknown, bindingsValue: unknown, sourceChatId: string): boolean {
  const reports = parsedJsonArray(reportValue), bindings = parsedJsonArray(bindingsValue);
  if (!reports || !bindings || reports.length < 1 || reports.length > 3 || reports.length !== bindings.length) return false;
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of reports) {
    const row = parsedJson(item);
    if (!row || typeof row.messageId !== 'number' || !Number.isSafeInteger(row.messageId)
      || row.messageId < 1 || row.messageId > 2147483647 || byId.has(String(row.messageId))) return false;
    byId.set(String(row.messageId), row);
  }
  let thumbsUp = false;
  for (const item of bindings) {
    const binding = parsedJson(item);
    if (!binding || typeof binding.messageId !== 'string' || typeof binding.role !== 'string'
      || typeof binding.sha256 !== 'string') return false;
    const report = byId.get(binding.messageId);
    if (!report || report.chatId !== sourceChatId || report.role !== binding.role
      || typeof report.sha256 !== 'string' || report.sha256.toLowerCase() !== binding.sha256
      || report.present !== true || typeof report.thumbsUp !== 'boolean') return false;
    thumbsUp ||= report.thumbsUp;
  }
  return thumbsUp;
}

/**
 * Classifies the durable authority before allocation. Ordinary jobs do only a
 * small marker/provenance lookup; the more detailed observer joins are only
 * loaded when an authority marker actually exists. A missing marker cannot
 * turn an observation revision into a normal rule-17 job.
 */
export async function loadMdfCncAuthority(tx: TransactionClient, job: MdfJob): Promise<MdfCncAuthority | null> {
  const marker = (await tx.query<{ authority: string }>(`SELECT authority
    FROM mdf_cnc_observation_job_authorities WHERE job_id=$1::uuid`, [job.job_id])).rows[0];
  if (!marker) {
    const provenance = (await tx.query<{ origin: string; cause_key: string }>(`SELECT origin,cause_key
      FROM mdf_evidence_revisions WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3`,
    [job.source_kind, job.source_id, job.revision_key])).rows[0];
    if (CNC_OBSERVATION_REVISION.test(job.revision_key)
      || provenance?.cause_key.startsWith('cnc-observation:')
      || (provenance?.origin === 'cnc' && provenance.cause_key.startsWith('cnc-autocut:'))) {
      attention('MARKER_MISSING');
    }
    return null;
  }
  const match = CNC_OBSERVATION_REVISION.exec(job.revision_key);
  if (marker.authority !== 'cnc_autocut' || job.source_kind !== 'packet' || !match
    || job.effect_policy !== 'forward') attention('MARKER_INVALID');
  const claimId = match[1].toLowerCase();
  const row = (await tx.query<AuthorityRow>(`SELECT a.packet_id::text packet_id,a.claim_id::text claim_id,a.authority,
      r.report_state,r.failure_code,r.report_digest,r.report,r.result,r.correction_epoch::text correction_epoch,
      r.head_version::text head_version,r.raw_source_version::text raw_source_version,
      r.observation_version::text observation_version,t.accepted_revision_key target_accepted_revision_key,
      t.registered_membership_digest target_membership_digest,t.last_observation_version::text target_last_observation_version,
      t.work_state target_state,p.source_version::text current_raw_source_version,
      t.source_chat_id target_source_chat_id,
      t.message_bindings target_message_bindings,
      e.origin revision_origin,e.cause_key revision_cause_key,e.request_id revision_request_id,
      e.actor_user_id::text revision_actor_user_id
    FROM mdf_cnc_observation_job_authorities a
    JOIN mdf_cnc_observation_receipts r ON r.claim_id=a.claim_id AND r.packet_id=a.packet_id
    JOIN mdf_cnc_observation_targets t ON t.packet_id=a.packet_id
    JOIN cnc_telegram_packets p ON p.packet_id=a.packet_id
    JOIN mdf_evidence_revisions e ON e.source_kind='packet' AND e.source_id=a.packet_id::text
      AND e.revision_key=$2
    WHERE a.job_id=$1::uuid`, [job.job_id, job.revision_key])).rows[0];
  const result = parsedJson(row?.result);
  const packetId = row?.packet_id;
  const reportedFenceState = result?.fenceState;
  if (!row || !packetId || row.claim_id.toLowerCase() !== claimId || packetId !== job.source_id
    || row.report_state !== 'completed' || row.failure_code !== null
    || row.revision_origin !== 'cnc' || row.revision_cause_key !== `cnc-observation:${claimId}`
    || row.revision_request_id !== job.request_id || row.revision_actor_user_id !== job.actor_user_id
    || result?.status !== 'recorded' || result.jobId !== job.job_id
    || result.observationVersion !== row.observation_version
    || (reportedFenceState !== 'none' && reportedFenceState !== 'satisfied')
    // Explicit SVG imports persist a synthetic packet chat id; the immutable
    // observer target retains the verified original Telegram chat binding.
    || !row.target_source_chat_id
    || !isCompletedBoundReport(row.report, row.target_message_bindings, row.target_source_chat_id)
    || !/^[a-f0-9]{64}$/.test(row.report_digest)
    || !/^[1-9]\d*$/.test(row.head_version) || !/^[1-9]\d*$/.test(row.raw_source_version)
    || !/^[1-9]\d*$/.test(row.observation_version) || !/^(0|[1-9]\d*)$/.test(row.correction_epoch)
    || !row.target_membership_digest || !/^[a-f0-9]{64}$/.test(row.target_membership_digest)) {
    attention('RECEIPT_INVALID');
  }
  return { packetId, claimId, reportDigest: row.report_digest, headVersion: row.head_version,
    correctionEpoch: row.correction_epoch, rawSourceVersion: row.raw_source_version,
    observationVersion: row.observation_version, fenceState: reportedFenceState as 'none'|'satisfied' };
}

/** Read and synchronize the legacy AutoCut setting before the accepted
 * allocator takes any owner/source locks. */
export async function lockAndReadMdfCncAutoCut(tx: TransactionClient): Promise<boolean> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CNC_AUTOCUT_SETTING]);
  await tx.query('LOCK TABLE production_statuses IN SHARE MODE');
  const row = (await tx.query<{ is_active: boolean; value_json: unknown }>(`SELECT is_active,value_json
    FROM app_settings WHERE setting_key=$1 LIMIT 1`, [CNC_AUTOCUT_SETTING])).rows[0];
  if (!row?.is_active) return false;
  if (row.value_json === true) return true;
  if (!row.value_json || typeof row.value_json !== 'object' || Array.isArray(row.value_json)) return false;
  const value = row.value_json as Record<string, unknown>;
  return value.value === true || value.enabled === true;
}

/**
 * Apply CNC-specific scalar effects only after the shared allocator has locked
 * the complete accepted closure and validated the current head/demand. No
 * legacy raw packet readiness inputs participate here.
 */
export async function applyMdfCncAuthorityEffects(tx: TransactionClient, input: {
  job: MdfJob;
  authority: MdfCncAuthority;
  heads: readonly AcceptedHead[];
  sources: readonly MdfAcceptedSource[];
  details: readonly (MdfPositionQuantity & { rank: number | null })[];
  orderIds: readonly number[];
  verifiedSourceKeys: ReadonlySet<string>;
  suppressedOrderIds: ReadonlySet<number>;
  enabled: boolean;
}): Promise<MdfCncAuthorityEffectResult> {
  const { job, authority } = input;
  if (authority.packetId !== job.source_id || job.source_kind !== 'packet'
    || job.revision_key !== `cnc-observation:${authority.claimId}`) attention('JOB_BINDING_INVALID');
  const head = input.heads.find(h => h.kind === 'packet' && h.id === authority.packetId);
  if (!head || head.accepted !== job.revision_key || head.received !== job.revision_key
    || head.epoch !== authority.correctionEpoch || job.correction_epoch !== authority.correctionEpoch) {
    attention('CURRENT_HEAD_STALE');
  }
  const current = (await tx.query<{ target_state: string; accepted_revision_key: string;
    last_observation_version: string; raw_source_version: string }>(`SELECT t.work_state target_state,
      t.accepted_revision_key,t.last_observation_version::text last_observation_version,
      p.source_version::text raw_source_version
    FROM mdf_cnc_observation_targets t JOIN cnc_telegram_packets p USING(packet_id)
    WHERE t.packet_id=$1::uuid`, [authority.packetId])).rows[0];
  if (!current || current.target_state !== 'completed' || current.accepted_revision_key !== job.revision_key
    || current.last_observation_version !== authority.observationVersion
    || current.raw_source_version !== authority.rawSourceVersion) attention('OBSERVATION_STALE');
  const fence = (await tx.query<{ correction_epoch: string; baseline_source_version: string;
    pending_source_version: string|null; completion_source_version: string|null; state: string }>(`SELECT
      correction_epoch::text correction_epoch,baseline_source_version::text baseline_source_version,
      pending_source_version::text pending_source_version,completion_source_version::text completion_source_version,state
    FROM mdf_cnc_return_fences WHERE packet_id=$1::uuid`, [authority.packetId])).rows[0] ?? null;
  if (authority.fenceState === 'none') {
    if (fence) attention('UNEXPECTED_RETURN_FENCE');
  } else if (!fence || fence.state !== 'satisfied' || fence.correction_epoch !== authority.correctionEpoch
    || !fence.pending_source_version || fence.completion_source_version !== authority.observationVersion
    || BigInt(fence.pending_source_version) <= BigInt(fence.baseline_source_version)
    || BigInt(fence.completion_source_version) <= BigInt(fence.pending_source_version)) {
    attention('RETURN_FENCE_INVALID');
  }
  const incremented = BigInt(authority.headVersion) + 1n;
  const version = (await tx.query<{ version: string; correction_epoch: string }>(`SELECT version::text version,
    correction_epoch::text correction_epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`,
  [authority.packetId])).rows[0];
  if (!version || version.version !== incremented.toString() || version.correction_epoch !== authority.correctionEpoch) {
    attention('HEAD_BINDING_INVALID');
  }
  const source = input.sources.find(s => s.kind === 'packet' && s.id === authority.packetId);
  if (!source?.verified || !input.verifiedSourceKeys.has(JSON.stringify(['packet', authority.packetId]))
    || source.accepted !== job.revision_key || source.received !== job.revision_key) {
    attention('PACKET_CONTEXT_INVALID');
  }
  await assertRegisteredMembershipDigest(tx, authority.packetId, job.revision_key);

  const allMembers = sumLinesByRework(source.lines.filter(line => line.stage === 'membership'
    && line.evidence === 'derived'));
  if (!allMembers.size) attention('PACKET_MEMBERSHIP_MISSING');
  const allPhysicalCut = sumLinesByRework(source.lines.filter(line => line.stage === 'cut'
    && line.evidence === 'physical'));
  for (const [key, member] of allMembers) {
    if ((allPhysicalCut.get(key)?.quantity ?? 0) < member.quantity) attention('PACKET_CUT_INCOMPLETE');
  }
  const ownMembers = sumLines(source.lines.filter(line => line.stage === 'membership'
    && line.evidence === 'derived' && !line.rework));

  const liveOwners = await tx.query<{ order_id: string; order_status_name: string|null }>(`SELECT o.order_id::text order_id,
      s.order_status_name FROM orders o LEFT JOIN order_statuses s USING(order_status_id)
    WHERE o.order_id=ANY($1::bigint[]) ORDER BY o.order_id`, [input.orderIds]);
  if (liveOwners.rows.length !== input.orderIds.length) attention('OWNER_SCOPE_CHANGED');
  const completedOrderIds: number[] = [];
  for (const row of liveOwners.rows) {
    const orderId = safePositive(row.order_id);
    if (!orderId) attention('OWNER_SCOPE_INVALID');
    const status = row.order_status_name?.trim().toLowerCase().replace(/ё/g, 'е');
    if (status === 'завершен' || status === 'завершено') completedOrderIds.push(orderId);
  }
  const changedOrderIds: number[] = [];
  if (!input.enabled || !ownMembers.size) return { changedOrderIds, completedOrderIds };

  const aggregate = new Map<string, { physical: number; declared: number }>();
  for (const accepted of input.sources) {
    if (!accepted.verified || !input.verifiedSourceKeys.has(JSON.stringify([accepted.kind,accepted.id]))
      || accepted.accepted !== accepted.received
      || accepted.kind !== 'packet' && accepted.kind !== 'bazisCutSet') continue;
    for (const line of accepted.lines) {
      if (line.stage !== 'cut' || line.rework || line.evidence === 'derived') continue;
      const key = mdfPositionKey(line);
      const qty = aggregate.get(key) ?? { physical: 0, declared: 0 };
      if (line.evidence === 'physical') qty.physical = mdfSum(qty.physical, line.quantity);
      else qty.declared = Math.max(qty.declared, line.quantity);
      aggregate.set(key, qty);
    }
  }
  const demandByPosition = new Map(input.details.map(detail => [mdfPositionKey(detail), detail]));
  const eligible = [...ownMembers.entries()].filter(([key, member]) => {
    if (input.suppressedOrderIds.has(member.orderId)) return false;
    const demand = demandByPosition.get(key);
    const amount = aggregate.get(key);
    return Boolean(demand && demand.quantity > 0 && amount
      && Math.max(amount.physical, amount.declared) >= demand.quantity);
  }).map(([, member]) => member).sort((a, b) => a.orderId - b.orderId || a.detailId - b.detailId);
  if (!eligible.length) return { changedOrderIds, completedOrderIds };

  const target = (await tx.query<{ production_status_id: number; sort_order: number|null }>(`SELECT
    production_status_id,sort_order FROM production_statuses
    WHERE COALESCE(is_active,true)=true AND sort_order IS NOT NULL
      AND (lower(trim(production_status_name))='распилен' OR lower(trim(production_status_code))='cut')
    ORDER BY CASE WHEN lower(trim(production_status_name))='распилен' THEN 0 ELSE 1 END,production_status_id
    LIMIT 1 FOR SHARE`)).rows[0];
  if (!target || !Number.isSafeInteger(Number(target.production_status_id)) || !Number.isFinite(Number(target.sort_order))) {
    attention('CUT_STATUS_UNAVAILABLE');
  }
  const ids = eligible.map(row => row.detailId);
  const lockedDetails = await tx.query<{ order_id: string; detail_id: string; production_status_id: number|null;
    current_sort_order: number|null }>(`SELECT d.order_id::text order_id,d.detail_id::text detail_id,d.production_status_id,
      s.sort_order current_sort_order FROM order_details d LEFT JOIN production_statuses s
        ON s.production_status_id=d.production_status_id
    WHERE d.detail_id=ANY($1::bigint[]) AND COALESCE(d.delete_flag,false)=false
    ORDER BY d.order_id,d.detail_id FOR UPDATE OF d`, [ids]);
  if (lockedDetails.rows.length !== ids.length) attention('DETAIL_SCOPE_CHANGED');
  const eligibleIds: number[] = [];
  for (const row of lockedDetails.rows) {
    if (row.production_status_id === null) { eligibleIds.push(Number(row.detail_id)); continue; }
    if (row.current_sort_order === null || row.current_sort_order === undefined) attention('DETAIL_STATUS_UNKNOWN');
    const existingId = Number(row.production_status_id);
    if (!Number.isSafeInteger(existingId) || !Number.isFinite(Number(row.current_sort_order))) attention('DETAIL_STATUS_UNKNOWN');
    if (existingId !== Number(target.production_status_id) && Number(row.current_sort_order) < Number(target.sort_order)) {
      eligibleIds.push(Number(row.detail_id));
    }
  }
  if (!eligibleIds.length) return { changedOrderIds, completedOrderIds };
  const eligibleOrderIds = [...new Set(eligible.map(row => row.orderId))].sort((a,b)=>a-b);
  const ownersBeforeAll = await tx.query<{ order_id: string; order_name: string|null; client_id: string|null;
    version: string; production_status_id: number|null; production_detail_count: number|null;
    production_unassigned_count: number|null; production_distinct_status_count: number|null;
    order_status_id: number; production_status_from_details_enabled: boolean|null }>(`SELECT
      o.order_id::text order_id,o.order_name,o.client_id::text client_id,o.version::text version,o.production_status_id,
      o.production_detail_count,o.production_unassigned_count,o.production_distinct_status_count,o.order_status_id,
      o.production_status_from_details_enabled
    FROM orders o WHERE o.order_id=ANY($1::bigint[]) ORDER BY o.order_id FOR UPDATE`, [eligibleOrderIds]);
  if (ownersBeforeAll.rows.length !== eligibleOrderIds.length) attention('OWNER_SCOPE_CHANGED');
  const changed = await tx.query<{ order_id: string; detail_id: string; before_status_id: number|null }>(`WITH before_rows AS (
      SELECT order_id,detail_id,production_status_id FROM order_details
      WHERE detail_id=ANY($2::bigint[]) AND COALESCE(delete_flag,false)=false
    ) UPDATE order_details d SET production_status_id=$1
      FROM before_rows b WHERE d.detail_id=b.detail_id AND d.production_status_id IS DISTINCT FROM $1
      RETURNING d.order_id::text order_id,d.detail_id::text detail_id,b.production_status_id before_status_id`,
  [target.production_status_id, eligibleIds]);
  if (!changed.rows.length) return { changedOrderIds, completedOrderIds };
  const groups = new Map<number, Array<{ detailId: number; beforeStatusId: number|null }>>();
  for (const row of changed.rows) {
    const orderId = safePositive(row.order_id), detailId = safePositive(row.detail_id);
    if (!orderId || !detailId) attention('DETAIL_SCOPE_INVALID');
    const values = groups.get(orderId) ?? [];
    values.push({ detailId, beforeStatusId: row.before_status_id });
    groups.set(orderId, values);
  }
  const changedIds = [...groups.keys()].sort((a, b) => a - b);
  const changedIdSet = new Set(changedIds.map(String));
  const ownersBefore = ownersBeforeAll.rows.filter(row => changedIdSet.has(row.order_id));
  if (ownersBefore.length !== changedIds.length) attention('OWNER_SCOPE_CHANGED');
  for (const order of ownersBefore) {
    if (order.production_status_from_details_enabled !== false) {
      await tx.query('SELECT recalc_order_production_status($1::bigint)', [Number(order.order_id)]);
    }
    await tx.query('UPDATE orders SET version=version+1,updated_at=now() WHERE order_id=$1::bigint', [Number(order.order_id)]);
  }
  const ownersAfter = await tx.query<{ order_id: string; order_name: string|null; client_id: string|null;
    version: string; production_status_id: number|null; production_detail_count: number|null;
    production_unassigned_count: number|null; production_distinct_status_count: number|null;
    order_status_id: number }>(`SELECT o.order_id::text order_id,o.order_name,o.client_id::text client_id,
      o.version::text version,o.production_status_id,o.production_detail_count,o.production_unassigned_count,
      o.production_distinct_status_count,o.order_status_id FROM orders o
    WHERE o.order_id=ANY($1::bigint[]) ORDER BY o.order_id`, [changedIds]);
  if (ownersAfter.rows.length !== changedIds.length) attention('OWNER_SCOPE_CHANGED');
  for (const after of ownersAfter.rows) {
    const before = ownersBefore.find(row => row.order_id === after.order_id);
    if (!before || before.order_status_id !== after.order_status_id) attention('BUSINESS_HEADER_CHANGED');
  }
  const detailChanges = [...groups].sort((a,b)=>a[0]-b[0]).flatMap(([orderId, rows]) => rows
    .sort((a,b)=>a.detailId-b.detailId).map(row => ({ orderId, detailId: row.detailId, beforeStatusId: row.beforeStatusId,
      afterStatusId: Number(target.production_status_id) })));
  const auditId = await auditService.record(tx, { event: 'cnc.mdf_observation.auto_cut_status_applied',
    actorUserId: job.actor_user_id, requestId: job.request_id, source: 'cnc_mdf_observation_worker',
    entityType: 'cnc_telegram_packet', entityId: authority.packetId,
    statusField: 'production_status_id', statusCode: 'cut',
    before: { details: detailChanges.map(change => ({ detailId: change.detailId, statusId: change.beforeStatusId })),
      owners: ownersBefore },
    after: { details: detailChanges, owners: ownersAfter.rows },
    metadata: { jobId: job.job_id, packetId: authority.packetId, claimId: authority.claimId,
      observationVersion: authority.observationVersion, changedOrderIds: changedIds,
      changedDetailIds: detailChanges.map(change => change.detailId), reportDigest: authority.reportDigest },
    relatedEntities: changedIds.flatMap(orderId => [{ entityType: 'order' as const, entityId: orderId },
      ...groups.get(orderId)!.map(row => ({ entityType: 'order_detail' as const, entityId: row.detailId }))]) });
  if (!auditId) throw new Error('MDF_CNC_AUTHORITY_AUDIT_REQUIRED');
  await tx.query(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
    VALUES('cnc.mdf_observation.auto_cut_status_applied','cnc_telegram_packet',$1,$2::jsonb,$3)
    ON CONFLICT(idempotency_key) DO NOTHING`, [authority.packetId, JSON.stringify({ jobId: job.job_id,
      packetId: authority.packetId, claimId: authority.claimId, requestId: job.request_id,
      actorUserId: job.actor_user_id, auditId, changedOrderIds: changedIds, detailChanges,
      beforeOrders: ownersBefore, afterOrders: ownersAfter.rows }), `cnc.mdf_observation:${authority.claimId}:auto-cut`]);
  changedOrderIds.push(...changedIds);
  return { changedOrderIds, completedOrderIds };
}

function sumLines(lines: readonly MdfAcceptedLine[]): Map<string, MdfPositionQuantity> {
  const result = new Map<string, MdfPositionQuantity>();
  for (const line of lines) {
    const key = mdfPositionKey(line), previous = result.get(key);
    result.set(key, { orderId: line.orderId, detailId: line.detailId,
      quantity: mdfSum(previous?.quantity ?? 0, line.quantity) });
  }
  return result;
}

function sumLinesByRework(lines: readonly MdfAcceptedLine[]): Map<string, MdfPositionQuantity> {
  const result = new Map<string, MdfPositionQuantity>();
  for (const line of lines) {
    const key = `${mdfPositionKey(line)}:${line.rework ? 'rework' : 'normal'}`;
    const previous = result.get(key);
    result.set(key, { orderId: line.orderId, detailId: line.detailId,
      quantity: mdfSum(previous?.quantity ?? 0, line.quantity) });
  }
  return result;
}

async function assertRegisteredMembershipDigest(tx: TransactionClient, packetId: string, revisionKey: string): Promise<void> {
  const target = (await tx.query<{ registered_membership_digest: string }>(`SELECT registered_membership_digest
    FROM mdf_cnc_observation_targets WHERE packet_id=$1::uuid`, [packetId])).rows[0];
  const rows = (await tx.query<{ line_key: string; order_id: string; detail_id: string; quantity: string; rework: boolean }>(`SELECT
    line_key,order_id::text,detail_id::text,quantity::text,rework FROM mdf_evidence_lines
    WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 AND stage_code='membership'
      AND evidence_kind='derived' ORDER BY line_key,order_id,detail_id,rework`, [packetId, revisionKey])).rows;
  const digest = createHash('sha256').update(JSON.stringify(rows.map(row => [row.line_key,row.order_id,
    row.detail_id,row.quantity,row.rework]))).digest('hex');
  if (!target || !rows.length || digest !== target.registered_membership_digest) attention('MEMBERSHIP_BINDING_INVALID');
}
