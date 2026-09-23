import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { assertCurrentWorkerSessionInTransaction } from './cnc-telegram-worker-session-fencing';
import { requireMdfCommandBoundary } from '../../mdf-board/application/mdf-command-boundary';
import { recordMdfReceipt, type MdfReceiptLine } from '../../mdf-board/application/mdf-receipt';
import { loadMdfExecutionSnapshot, mdfSourceKey } from '../../mdf-board/adapters/mdf-execution-snapshot';
import type { MdfExecutionContext } from '../../mdf-board/domain/mdf-execution-context';
import { mdfSum } from '../../mdf-board/domain/mdf-quantities';
import type { CncTelegramWorkerSessionLeaseContext } from '../application/cnc-telegram-worker-session.types';
import type { CncTelegramImportCompleteDto } from '../dto/cnc-telegram-import.dto';
import type {
  CncTelegramMdfObservationRepositoryPort,
  MdfCncObservationClaimDto,
  MdfCncObservationFailureReason,
  MdfCncObservationMessageRole,
  MdfCncObservationReport,
  MdfCncObservationResult,
} from '../application/mdf-cnc-observations.types';

type Row = QueryResultRow;
const OBSERVATION_LEASE_SECONDS = 90;
const OBSERVATION_POLL_SECONDS = 60;
const OBSERVATION_FAILURE_SECONDS = 300;
const MAX_OWNERS = 100;
const MAX_DETAILS = 5000;
const source = (packetId: string) => ['packet', packetId] as const;
const sourceKey = (packetId: string) => mdfSourceKey({ kind: 'packet', id: packetId });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }
function validBigint(value: unknown, positive = true): value is string {
  return typeof value === 'string' && (positive ? /^[1-9]\d*$/.test(value) : /^(0|[1-9]\d*)$/.test(value));
}
function safeId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(409, 'MDF_CNC_OBSERVATION_SCOPE_UNAVAILABLE', 'Связанный состав CNC больше недоступен');
  return id;
}
function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`MDF_CNC_OBSERVATION_INVALID_${key}`);
  return value;
}
function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`MDF_CNC_OBSERVATION_INVALID_${key}`);
  return value;
}
function jsonArray<T>(value: unknown): T[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error('MDF_CNC_OBSERVATION_INVALID_JSON');
  return parsed as T[];
}
function tokenMatches(raw: string, savedHash: string): boolean {
  const actual = Buffer.from(digest(raw), 'hex'), expected = Buffer.from(savedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function requireWorker(user: CurrentUser, lease: CncTelegramWorkerSessionLeaseContext): void {
  if (!user.permissions.includes('cut.manage') || !lease.sourceChatId.trim()
    || !lease.workerInstanceId.trim() || !lease.leaseToken.trim()
    || !Number.isSafeInteger(lease.leaseGeneration) || lease.leaseGeneration < 1) {
    fail(403, 'PERMISSION_DENIED', 'Нет доступа к наблюдению CNC');
  }
}

interface TargetRow extends Row {
  packet_id: string; import_item_id: string; candidate_id: string; source_chat_id: string;
  source_group_message_id: string; message_bindings: unknown; registered_revision_key: string;
  registered_membership_digest: string; accepted_revision_key: string; last_observation_version: string; work_state: string;
  next_due_at: string; claim_id: string | null; claim_token_hash: string | null;
  claim_generation: string; claim_worker_instance_id: string | null; claim_session_generation: string | null;
  claim_expires_at: string | null; claim_head_version: string | null; claim_correction_epoch: string | null;
  claim_raw_source_version: string | null; claim_observation_version: string | null;
  claim_live?: boolean; due_now?: boolean;
}
interface HeadRow extends Row { received_revision_key: string; accepted_revision_key: string | null; version: string; correction_epoch: string }
interface FenceRow extends Row { correction_epoch: string; baseline_source_version: string; pending_source_version: string | null; completion_source_version: string | null; state: string }
interface Binding { messageId: string; role: MdfCncObservationMessageRole; sha256: string }

/** Durable bounded exact-message observer. Every public method owns its RC transaction. */
export class PgCncTelegramMdfObservationRepository implements CncTelegramMdfObservationRepositoryPort {
  constructor(private readonly database: Pick<DatabaseService, 'transaction'>) {}

  async claim(input: { currentUser: CurrentUser; lease: CncTelegramWorkerSessionLeaseContext }): Promise<MdfCncObservationClaimDto | null> {
    requireWorker(input.currentUser, input.lease);
    return this.database.transaction(async tx => {
      const boundary = await requireMdfCommandBoundary(tx, { writer: 'cnc.mdf_observation.claim', capability: 'cnc-receipt' });
      if (!boundary.queued) return null;
      await tx.query('LOCK TABLE production_statuses IN SHARE MODE');
      // Discovery is read-only and does not lock target/packet before owners.
      const candidate = (await tx.query<Row>(`SELECT t.packet_id::text packet_id,t.accepted_revision_key,
        t.source_chat_id,t.work_state,t.next_due_at FROM mdf_cnc_observation_targets t
        JOIN mdf_source_heads h ON h.source_kind='packet' AND h.source_id=t.packet_id::text
        WHERE t.work_state='active' AND t.next_due_at<=clock_timestamp()
          AND (t.claim_id IS NULL OR t.claim_expires_at<=clock_timestamp()) AND t.source_chat_id=$1
          AND h.accepted_revision_key IS NOT NULL AND h.accepted_revision_key=h.received_revision_key
          AND EXISTS (SELECT 1 FROM mdf_revision_demand d WHERE d.source_kind='packet'
            AND d.source_id=t.packet_id::text AND d.revision_key=h.accepted_revision_key)
          AND (SELECT count(DISTINCT d.order_id) FROM mdf_revision_demand d WHERE d.source_kind='packet'
            AND d.source_id=t.packet_id::text AND d.revision_key=h.accepted_revision_key) BETWEEN 1 AND $2
          AND NOT EXISTS (SELECT 1 FROM mdf_revision_demand d LEFT JOIN orders o ON o.order_id=d.order_id
            WHERE d.source_kind='packet' AND d.source_id=t.packet_id::text AND d.revision_key=h.accepted_revision_key
              AND (o.order_id IS NULL OR o.delete_flag OR o.order_kind<>'production_order'))
        ORDER BY t.next_due_at,t.packet_id LIMIT 1`, [input.lease.sourceChatId,MAX_OWNERS])).rows[0];
      if (!candidate) return null;
      const packetId = text(candidate, 'packet_id');
      const preflightHead = await this.readHead(tx, packetId, false);
      if (!preflightHead.accepted_revision_key || preflightHead.accepted_revision_key !== preflightHead.received_revision_key) return null;
      const owners = await this.ownerIds(tx, packetId, preflightHead.accepted_revision_key);
      if (!await this.lockOwnersAndDetails(tx, owners)) {
        await assertCurrentWorkerSessionInTransaction(tx, input.lease);
        await this.lockSourceSuffix(tx, packetId);
        const current = await this.lockCurrent(tx, packetId);
        if (current.target.work_state === 'active' && current.target.due_now
          && current.head.accepted_revision_key === preflightHead.accepted_revision_key
          && current.head.accepted_revision_key === current.head.received_revision_key) {
          await this.quarantineTarget(tx, current.target, input.currentUser, 'owner_scope_invalid', owners);
        }
        return null;
      }
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      await this.lockSourceSuffix(tx, packetId);
      const { target, head, packet, fence } = await this.lockCurrent(tx, packetId);
      if (target.source_chat_id !== input.lease.sourceChatId || target.work_state !== 'active'
        || !head.accepted_revision_key || head.accepted_revision_key !== head.received_revision_key
        || target.claim_live || !target.due_now) return null;
      await this.assertOwnersUnchanged(tx, packetId, head.accepted_revision_key, owners);
      try {
        await this.assertAcceptedContext(tx, packetId, head, owners);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'MDF_CNC_OBSERVATION_SOURCE_UNAVAILABLE') throw error;
        await this.quarantineTarget(tx, target, input.currentUser, 'accepted_context_invalid', owners);
        return null;
      }
      if (await this.membershipDigest(tx, packetId, head.accepted_revision_key) !== target.registered_membership_digest) {
        await this.quarantineTarget(tx, target, input.currentUser, 'membership_changed', owners);
        return null;
      }
      if (fence && fence.correction_epoch !== head.correction_epoch) {
        await this.quarantineTarget(tx, target, input.currentUser, 'fence_epoch_mismatch', owners);
        return null;
      }
      if (!validBigint(packet.source_version) || !validBigint(head.version) || !validBigint(head.correction_epoch, false)
        || !validBigint(target.last_observation_version)) fail(503, 'MDF_CNC_OBSERVATION_STATE_INVALID', 'Состояние источника CNC повреждено');
      const messages = this.bindings(target.message_bindings);
      const claimId = randomUUID();
      const claimToken = randomBytes(32).toString('hex');
      const tokenHash = digest(claimToken);
      const generation = Number(target.claim_generation) + 1;
      if (!Number.isSafeInteger(generation) || generation < 1) fail(503, 'MDF_CNC_OBSERVATION_STATE_INVALID', 'Счётчик CNC повреждён');
      const updated = (await tx.query<{ expires_at: string }>(`UPDATE mdf_cnc_observation_targets SET
        claim_id=$2::uuid,claim_token_hash=$3,claim_generation=$4,claim_worker_instance_id=$5::uuid,
        claim_session_generation=$6,claim_expires_at=clock_timestamp()+($7::integer*interval '1 second'),
        claim_head_version=$8::bigint,claim_correction_epoch=$9::bigint,claim_raw_source_version=$10::bigint,
        claim_observation_version=$11::bigint,accepted_revision_key=$12,updated_at=now()
        WHERE packet_id=$1::uuid RETURNING claim_expires_at::text expires_at`,
      [packetId, claimId, tokenHash, generation, input.lease.workerInstanceId, input.lease.leaseGeneration,
        OBSERVATION_LEASE_SECONDS, head.version, head.correction_epoch, packet.source_version, target.last_observation_version,
        head.accepted_revision_key])).rows[0];
      const expiresAt=new Date(updated?.expires_at ?? '');
      if (!Number.isFinite(expiresAt.getTime())) fail(503,'MDF_CNC_OBSERVATION_STATE_INVALID','Срок заявки CNC повреждён');
      const auditId=await auditService.record(tx, { event: 'cnc.mdf_observation.claimed', actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username, actorRole: input.currentUser.role,
        entityType: 'cnc_telegram_packet', entityId: packetId, source: 'cnc_mdf_observation_worker',
        requestId: `mdf-observation-claim:${claimId}`, metadata: { claimId, claimGeneration: generation,
          workerInstanceId: input.lease.workerInstanceId, messageCount: messages.length },
        relatedEntities: owners.map(entityId=>({entityType:'order',entityId})) });
      if (!auditId) throw new Error('MDF_CNC_OBSERVATION_AUDIT_REQUIRED');
      return { claimId, claimToken, claimGeneration: generation,
        expiresAt: expiresAt.toISOString(), packetId, sourceChatId: target.source_chat_id,
        messages: messages.map(message => ({ ...message, messageId: Number(message.messageId) })),
        acceptedRevisionKey: head.accepted_revision_key, headVersion: head.version,
        correctionEpoch: head.correction_epoch, rawSourceVersion: packet.source_version,
        observationVersion: target.last_observation_version };
    }, { mdf: { writer: 'cnc.mdf_observation.claim', capability: 'cnc-receipt' } });
  }

  async complete(input: { currentUser: CurrentUser; lease: CncTelegramWorkerSessionLeaseContext;
    report: MdfCncObservationReport; requestId: string }): Promise<MdfCncObservationResult> {
    requireWorker(input.currentUser, input.lease);
    validateRequestId(input.requestId);
    validateClaimIdentity(input.report.claimId, input.report.claimToken, input.report.claimGeneration);
    const report = normalizeReport(input.report);
    const reportDigest = digest(report);
    return this.database.transaction(async tx => {
      const boundary = await requireMdfCommandBoundary(tx, { writer: 'cnc.mdf_observation.complete', capability: 'cnc-receipt' });
      if (!boundary.queued) fail(503, 'MDF_CNC_OBSERVATION_MODE_DISABLED', 'Наблюдение CNC отключено в текущем режиме');
      await tx.query('LOCK TABLE production_statuses IN SHARE MODE');
      const preflight = await this.preflightClaim(tx, report.claimId);
      if (!preflight) fail(409, 'MDF_CNC_OBSERVATION_STALE', 'Заявка наблюдения CNC устарела');
      if (preflight.source_chat_id !== input.lease.sourceChatId) fail(403, 'PERMISSION_DENIED', 'Неверный CNC чат');
      const priorReceipt = await this.readReceipt(tx, report.claimId);
      if (priorReceipt) {
        await assertCurrentWorkerSessionInTransaction(tx, input.lease);
        return replayResult(priorReceipt, input.lease, report, reportDigest);
      }
      const owners = await this.ownerIds(tx, preflight.packet_id, preflight.accepted_revision_key);
      const ownerLocksValid=await this.lockOwnersAndDetails(tx, owners);
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      await this.lockSourceSuffix(tx, preflight.packet_id);
      const { target, head, packet, fence } = await this.lockCurrent(tx, preflight.packet_id);
      const racedReceipt = await this.readReceipt(tx, report.claimId);
      if (racedReceipt) return replayResult(racedReceipt, input.lease, report, reportDigest);
      if (!ownerLocksValid) fail(409,'MDF_CNC_OBSERVATION_SCOPE_UNAVAILABLE','Связанный заказ удалён или изменил тип');
      if (!claimStillCurrent(target, report, input.lease) || target.source_chat_id !== input.lease.sourceChatId
        || target.work_state !== 'active' || head.version !== target.claim_head_version
        || head.correction_epoch !== target.claim_correction_epoch || head.received_revision_key !== target.accepted_revision_key
        || head.accepted_revision_key !== target.accepted_revision_key || packet.source_version !== target.claim_raw_source_version
        || target.last_observation_version !== target.claim_observation_version) {
        fail(409, 'MDF_CNC_OBSERVATION_STALE', 'Источник или возврат изменился после получения сообщений; загрузите их заново');
      }
      await this.assertOwnersUnchanged(tx, preflight.packet_id, head.accepted_revision_key!, owners);
      await this.assertAcceptedContext(tx, preflight.packet_id, head, owners);
      if (await this.membershipDigest(tx, preflight.packet_id, head.accepted_revision_key!) !== target.registered_membership_digest) {
        fail(409, 'MDF_CNC_OBSERVATION_STALE', 'Состав исходного CNC-файла изменился после получения сообщений');
      }
      const bindings = this.bindings(target.message_bindings);
      validateReportedGroup(report.messages, bindings, target.source_chat_id);
      if (fence && fence.correction_epoch !== head.correction_epoch) {
        fail(409, 'MDF_CNC_OBSERVATION_STALE', 'Сигнал возврата CNC изменился; загрузите сообщения заново');
      }
      const completed = report.messages.some(message => message.thumbsUp);
      const nextObservationVersion = nextVersion(target.last_observation_version, packet.source_version, fence);
      let result: MdfCncObservationResult = { status: 'recorded', observationVersion: target.last_observation_version,
        fenceState: (fence?.state as MdfCncObservationResult['fenceState'] | undefined) ?? 'none', jobId: null };
      let sequenceAdvanced = false;
      let authorityJob: string | null = null;

      if (fence?.state === 'waiting_pending') {
        if (!completed) {
          await tx.query(`UPDATE mdf_cnc_return_fences SET state='waiting_completion',pending_source_version=$2::bigint,
            updated_at=now() WHERE packet_id=$1::uuid`, [packet.packet_id, nextObservationVersion]);
          sequenceAdvanced = true;
          await this.updateRawStatus(tx, packet.packet_id, false, false);
          result = { status: 'recorded', observationVersion: nextObservationVersion,
            fenceState: 'waiting_completion', jobId: null };
        } else {
          // A post-return fetch that already sees the old 👍 cannot prove a
          // pending transition. Keep both raw state and fence uncredited.
          await this.scheduleAgain(tx, target, OBSERVATION_POLL_SECONDS);
          result = { status: 'recorded', observationVersion: target.last_observation_version,
            fenceState: 'waiting_pending', jobId: null };
        }
      } else if (fence?.state === 'waiting_completion') {
        if (completed) {
          const proof = await this.recordPhysicalCut(tx, input.currentUser, input.lease, target, head,
            report, reportDigest, nextObservationVersion, input.requestId);
          if (proof.kind === 'needs_reconciliation') {
            await tx.query(`UPDATE mdf_cnc_observation_targets SET work_state='needs_reconciliation',
              last_observation_version=$2::bigint,claim_id=NULL,claim_token_hash=NULL,claim_worker_instance_id=NULL,
              claim_session_generation=NULL,claim_expires_at=NULL,claim_head_version=NULL,claim_correction_epoch=NULL,
              claim_raw_source_version=NULL,claim_observation_version=NULL,next_due_at=clock_timestamp()+($3::integer*interval '1 second'),
              updated_at=now() WHERE packet_id=$1::uuid`, [packet.packet_id, nextObservationVersion, OBSERVATION_FAILURE_SECONDS]);
            sequenceAdvanced = true;
            result = { status: 'needs_reconciliation', observationVersion: nextObservationVersion,
              fenceState: 'waiting_completion', jobId: null };
          } else {
            await tx.query(`UPDATE mdf_cnc_return_fences SET state='satisfied',completion_source_version=$2::bigint,
              updated_at=now() WHERE packet_id=$1::uuid`, [packet.packet_id, nextObservationVersion]);
            sequenceAdvanced = true;
            await this.updateRawStatus(tx, packet.packet_id, true, true, true);
            authorityJob = proof.jobId;
            result = { status: 'recorded', observationVersion: nextObservationVersion,
              fenceState: 'satisfied', jobId: proof.jobId };
            await this.finishTarget(tx, target, nextObservationVersion, proof.revisionKey);
          }
        } else {
          await this.updateRawStatus(tx, packet.packet_id, false, false);
          await this.scheduleAgain(tx, target, OBSERVATION_POLL_SECONDS);
        }
      } else if (!fence && completed) {
        const proof = await this.recordPhysicalCut(tx, input.currentUser, input.lease, target, head,
          report, reportDigest, nextObservationVersion, input.requestId);
        if (proof.kind === 'needs_reconciliation') {
          await tx.query(`UPDATE mdf_cnc_observation_targets SET work_state='needs_reconciliation',
            last_observation_version=$2::bigint,claim_id=NULL,claim_token_hash=NULL,claim_worker_instance_id=NULL,
            claim_session_generation=NULL,claim_expires_at=NULL,claim_head_version=NULL,claim_correction_epoch=NULL,
            claim_raw_source_version=NULL,claim_observation_version=NULL,next_due_at=clock_timestamp()+($3::integer*interval '1 second'),
            updated_at=now() WHERE packet_id=$1::uuid`, [packet.packet_id, nextObservationVersion, OBSERVATION_FAILURE_SECONDS]);
          sequenceAdvanced = true;
          result = { status: 'needs_reconciliation', observationVersion: nextObservationVersion,
            fenceState: 'none', jobId: null };
        } else {
          await this.updateRawStatus(tx, packet.packet_id, true, true, true);
          sequenceAdvanced = true;
          result = { status: 'recorded', observationVersion: nextObservationVersion,
            fenceState: 'none', jobId: proof.jobId };
          authorityJob = proof.jobId;
          await this.finishTarget(tx, target, nextObservationVersion, proof.revisionKey);
        }
      } else {
        if (!completed && !(await this.hasAcceptedPhysicalCut(tx, packet.packet_id, head.accepted_revision_key!))) {
          sequenceAdvanced = await this.updateRawStatus(tx, packet.packet_id, false, false);
        }
        await this.scheduleAgain(tx, target, OBSERVATION_POLL_SECONDS);
      }

      const committedVersion = sequenceAdvanced ? nextObservationVersion : target.last_observation_version;
      result = { ...result, observationVersion: committedVersion };
      await this.insertObservationReceipt(tx, { target, lease: input.lease, report, reportDigest,
        state: completed ? 'completed' : 'pending', observationVersion: committedVersion, result });
      if (authorityJob) await this.insertAuthority(tx, authorityJob, packet.packet_id, report.claimId);
      if (sequenceAdvanced && target.work_state === 'active') {
        await tx.query(`UPDATE mdf_cnc_observation_targets SET last_observation_version=$2::bigint,
          claim_id=NULL,claim_token_hash=NULL,claim_worker_instance_id=NULL,claim_session_generation=NULL,
          claim_expires_at=NULL,claim_head_version=NULL,claim_correction_epoch=NULL,claim_raw_source_version=NULL,
          claim_observation_version=NULL,next_due_at=clock_timestamp()+($3::integer*interval '1 second'),updated_at=now()
          WHERE packet_id=$1::uuid`, [packet.packet_id, committedVersion, OBSERVATION_POLL_SECONDS]);
      }
      const auditId=await auditService.record(tx, { event: 'cnc.mdf_observation.completed', actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username, actorRole: input.currentUser.role,
        entityType: 'cnc_telegram_packet', entityId: packet.packet_id, source: 'cnc_mdf_observation_worker',
        requestId: input.requestId, metadata: { claimId: report.claimId, observationVersion: committedVersion,
          reportState: completed ? 'completed' : 'pending', fenceState: result.fenceState, jobId: result.jobId },
        relatedEntities: owners.map(entityId=>({entityType:'order',entityId})) });
      if (!auditId) throw new Error('MDF_CNC_OBSERVATION_AUDIT_REQUIRED');
      await this.enqueueOutbox(tx, packet.packet_id, report.claimId, result, { actorUserId: input.currentUser.id,
        requestId: input.requestId, orderIds: owners, auditId });
      return result;
    }, { mdf: { writer: 'cnc.mdf_observation.complete', capability: 'cnc-receipt' } });
  }

  async fail(input: { currentUser: CurrentUser; lease: CncTelegramWorkerSessionLeaseContext; claimId: string;
    claimToken: string; claimGeneration: number; reason: MdfCncObservationFailureReason; requestId: string }): Promise<void> {
    requireWorker(input.currentUser, input.lease);
    validateRequestId(input.requestId);
    validateClaimIdentity(input.claimId, input.claimToken, input.claimGeneration);
    if (!['FETCH_FAILED', 'MESSAGE_MISSING', 'MESSAGE_MEDIA_MISMATCH', 'MESSAGE_GROUP_INCOMPLETE'].includes(input.reason)) {
      fail(400, 'MDF_CNC_OBSERVATION_REPORT_INVALID', 'Некорректный результат чтения CNC');
    }
    return this.database.transaction(async tx => {
      const boundary = await requireMdfCommandBoundary(tx, { writer: 'cnc.mdf_observation.fail', capability: 'cnc-receipt' });
      if (!boundary.queued) fail(503, 'MDF_CNC_OBSERVATION_MODE_DISABLED', 'Наблюдение CNC отключено в текущем режиме');
      await tx.query('LOCK TABLE production_statuses IN SHARE MODE');
      const preflight = await this.preflightClaim(tx, input.claimId);
      if (!preflight || preflight.source_chat_id !== input.lease.sourceChatId) {
        fail(409, 'MDF_CNC_OBSERVATION_STALE', 'Заявка наблюдения CNC устарела');
      }
      const priorReceipt = await this.readReceipt(tx, input.claimId);
      if (priorReceipt) {
        await assertCurrentWorkerSessionInTransaction(tx, input.lease);
        assertFailureReplay(priorReceipt, input.lease, input.claimToken, input.claimGeneration, input.reason);
        return;
      }
      const owners = await this.ownerIds(tx, preflight.packet_id, preflight.accepted_revision_key);
      const ownerLocksValid=await this.lockOwnersAndDetails(tx, owners);
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      await this.lockSourceSuffix(tx, preflight.packet_id);
      const { target, head, packet } = await this.lockCurrent(tx, preflight.packet_id);
      const racedReceipt = await this.readReceipt(tx, input.claimId);
      if (racedReceipt) {
        assertFailureReplay(racedReceipt, input.lease, input.claimToken, input.claimGeneration, input.reason);
        return;
      }
      if (!ownerLocksValid) fail(409,'MDF_CNC_OBSERVATION_SCOPE_UNAVAILABLE','Связанный заказ удалён или изменил тип');
      if (!claimStillCurrent(target, { claimId: input.claimId, claimToken: input.claimToken,
        claimGeneration: input.claimGeneration }, input.lease)
        || target.source_chat_id !== input.lease.sourceChatId || head.version !== target.claim_head_version
        || head.correction_epoch !== target.claim_correction_epoch || packet.source_version !== target.claim_raw_source_version) {
        fail(409, 'MDF_CNC_OBSERVATION_STALE', 'Заявка наблюдения CNC устарела');
      }
      await this.assertOwnersUnchanged(tx, preflight.packet_id, head.accepted_revision_key!, owners);
      await this.assertAcceptedContext(tx, preflight.packet_id, head, owners);
      if (await this.membershipDigest(tx, preflight.packet_id, head.accepted_revision_key!) !== target.registered_membership_digest) {
        fail(409, 'MDF_CNC_OBSERVATION_STALE', 'Состав исходного CNC-файла изменился после получения сообщений');
      }
      const result: MdfCncObservationResult = { status: 'recorded', observationVersion: target.last_observation_version,
        fenceState: 'none', jobId: null };
      const failureDigest = digest({ claimId: input.claimId, reason: input.reason });
      await tx.query(`INSERT INTO mdf_cnc_observation_receipts(claim_id,packet_id,claim_generation,claim_token_hash,
        worker_instance_id,session_generation,head_version,correction_epoch,raw_source_version,observation_version,
        report_state,failure_code,report_digest,report,result)
        VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7::bigint,$8::bigint,$9::bigint,$10::bigint,
          'failed',$11,$12,'[]'::jsonb,$13::jsonb)`, [input.claimId, packet.packet_id, input.claimGeneration,
        digest(input.claimToken), input.lease.workerInstanceId, input.lease.leaseGeneration, head.version,
        head.correction_epoch, packet.source_version, target.last_observation_version, input.reason, failureDigest,
        JSON.stringify({ ...result, failureReason: input.reason })]);
      await tx.query(`UPDATE mdf_cnc_observation_targets SET claim_id=NULL,claim_token_hash=NULL,
        claim_worker_instance_id=NULL,claim_session_generation=NULL,claim_expires_at=NULL,claim_head_version=NULL,
        claim_correction_epoch=NULL,claim_raw_source_version=NULL,claim_observation_version=NULL,
        next_due_at=clock_timestamp()+($2::integer*interval '1 second'),updated_at=now()
        WHERE packet_id=$1::uuid`, [packet.packet_id, OBSERVATION_FAILURE_SECONDS]);
      const auditId=await auditService.record(tx, { event: 'cnc.mdf_observation.fetch_failed', actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username, actorRole: input.currentUser.role,
        entityType: 'cnc_telegram_packet', entityId: packet.packet_id, source: 'cnc_mdf_observation_worker',
        requestId: input.requestId, metadata: { claimId: input.claimId, reason: input.reason },
        relatedEntities: owners.map(entityId=>({entityType:'order',entityId})) });
      if (!auditId) throw new Error('MDF_CNC_OBSERVATION_AUDIT_REQUIRED');
    }, { mdf: { writer: 'cnc.mdf_observation.fail', capability: 'cnc-receipt' } });
  }

  private async readHead(tx: TransactionClient, packetId: string, lock: boolean): Promise<HeadRow> {
    const row = (await tx.query<HeadRow>(`SELECT received_revision_key,accepted_revision_key,version::text version,
      correction_epoch::text correction_epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1
      ${lock ? 'FOR UPDATE' : ''}`, [packetId])).rows[0];
    if (!row || !validBigint(row.version) || !validBigint(row.correction_epoch, false)) {
      fail(409, 'MDF_CNC_OBSERVATION_SOURCE_UNAVAILABLE', 'Состав CNC ещё не принят в производственный учёт');
    }
    return row;
  }

  private async ownerIds(tx: TransactionClient, packetId: string, revision: string): Promise<number[]> {
    const rows = (await tx.query<{ order_id: string }>(`SELECT DISTINCT order_id::text order_id FROM mdf_revision_demand
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 ORDER BY order_id LIMIT $3`,
    [packetId, revision, MAX_OWNERS + 1])).rows;
    if (!rows.length || rows.length > MAX_OWNERS) fail(409, 'MDF_CNC_OBSERVATION_SCOPE_UNAVAILABLE', 'Состав CNC превышает безопасную область обработки');
    return rows.map(row => safeId(row.order_id)).sort((a, b) => a - b);
  }

  private async lockOwnersAndDetails(tx: TransactionClient, owners: readonly number[]): Promise<boolean> {
    const locked = (await tx.query<{ order_id: number }>(`SELECT order_id::float8 order_id FROM orders
      WHERE order_id=ANY($1::bigint[]) AND NOT delete_flag AND order_kind='production_order'
      ORDER BY order_id FOR UPDATE`, [owners])).rows;
    if (locked.length !== owners.length) return false;
    const details = (await tx.query(`SELECT detail_id FROM order_details WHERE order_id=ANY($1::bigint[])
      ORDER BY order_id,detail_id LIMIT $2 FOR UPDATE`, [owners, MAX_DETAILS + 1])).rows;
    const hdf = (await tx.query(`SELECT order_hdf_detail_id FROM order_hdf_details WHERE order_id=ANY($1::bigint[])
      ORDER BY order_id,order_hdf_detail_id LIMIT $2 FOR UPDATE`, [owners, MAX_DETAILS + 1])).rows;
    return details.length + hdf.length <= MAX_DETAILS;
  }

  private async assertOwnersUnchanged(tx: TransactionClient, packetId: string, revision: string,
    expectedOwners: readonly number[]): Promise<void> {
    const actual = await this.ownerIds(tx, packetId, revision);
    if (actual.length !== expectedOwners.length || actual.some((id, index) => id !== expectedOwners[index])) {
      fail(409, 'MDF_CNC_OBSERVATION_STALE', 'Состав заказа изменился; запросите CNC-сообщения заново');
    }
  }

  private async assertAcceptedContext(tx: TransactionClient, packetId: string, head: HeadRow, owners: readonly number[]): Promise<void> {
    const snapshot = await loadMdfExecutionSnapshot(tx, [{ kind: 'packet', id: packetId, received: head.received_revision_key,
      accepted: head.accepted_revision_key, epoch: head.correction_epoch }], owners);
    const issues = snapshot.issues.get(sourceKey(packetId));
    if (!head.accepted_revision_key || head.accepted_revision_key !== head.received_revision_key || issues?.length) {
      fail(409, 'MDF_CNC_OBSERVATION_SOURCE_UNAVAILABLE', 'Подтверждённый состав CNC изменился или неполон');
    }
  }

  private async membershipDigest(tx: TransactionClient, packetId: string, revision: string): Promise<string> {
    return loadMembershipDigest(tx, packetId, revision);
  }

  private async lockSourceSuffix(tx: TransactionClient, packetId: string): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mdf-source:${JSON.stringify(source(packetId))}`]);
    await tx.query(`SELECT 1 FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1 FOR UPDATE`, [packetId]);
  }

  private async lockCurrent(tx: TransactionClient, packetId: string) {
    const head = await this.readHead(tx, packetId, true);
    const packet = (await tx.query<{ packet_id: string; source_chat_id: string; source_version: string;
      completion_status: string; thumbs_up: boolean; updated_at: string }>(`SELECT packet_id::text packet_id,source_chat_id,
        source_version::text source_version,completion_status,thumbs_up,updated_at::text updated_at
        FROM cnc_telegram_packets WHERE packet_id=$1::uuid FOR UPDATE`, [packetId])).rows[0];
    if (!packet || !validBigint(packet.source_version)) fail(409, 'MDF_CNC_OBSERVATION_SOURCE_UNAVAILABLE', 'Пакет CNC недоступен');
    const target = (await tx.query<TargetRow>(`SELECT t.*,(t.claim_expires_at>clock_timestamp()) claim_live,
      (t.next_due_at<=clock_timestamp()) due_now FROM mdf_cnc_observation_targets t
      WHERE t.packet_id=$1::uuid FOR UPDATE`, [packetId])).rows[0];
    if (!target) fail(409, 'MDF_CNC_OBSERVATION_STALE', 'Источник CNC больше не зарегистрирован');
    const fence = (await tx.query<FenceRow>(`SELECT packet_id,correction_epoch::text correction_epoch,
      baseline_source_version::text baseline_source_version,pending_source_version::text pending_source_version,
      completion_source_version::text completion_source_version,state FROM mdf_cnc_return_fences WHERE packet_id=$1::uuid FOR UPDATE`, [packetId])).rows[0];
    return { target, head, packet, fence };
  }

  private bindings(value: unknown): Binding[] {
    const rows = jsonArray<Binding>(value);
    if (rows.length < 1 || rows.length > 3) fail(503, 'MDF_CNC_OBSERVATION_BINDING_INVALID', 'Состав CNC-сообщений повреждён');
    const ids = new Set<string>(), roles = new Set<string>();
    for (const row of rows) {
      const messageId = Number(row?.messageId);
      if (!row || !/^[1-9]\d*$/.test(row.messageId) || !Number.isSafeInteger(messageId) || messageId > 2147483647
        || !['svg', 'gcode', 'image'].includes(row.role)
        || !/^[a-f0-9]{64}$/.test(row.sha256) || ids.has(row.messageId) || roles.has(row.role)) {
        fail(503, 'MDF_CNC_OBSERVATION_BINDING_INVALID', 'Состав CNC-сообщений повреждён');
      }
      ids.add(row.messageId); roles.add(row.role);
    }
    if (!roles.has('svg')) fail(503, 'MDF_CNC_OBSERVATION_BINDING_INVALID', 'Состав CNC-сообщений неполон');
    return [...rows].sort((a, b) => a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);
  }

  private async preflightClaim(tx: TransactionClient, claimId: string): Promise<TargetRow | null> {
    return (await tx.query<TargetRow>(`SELECT t.* FROM mdf_cnc_observation_targets t
      LEFT JOIN mdf_cnc_observation_receipts r ON r.packet_id=t.packet_id AND r.claim_id=$1::uuid
      WHERE t.claim_id=$1::uuid OR r.claim_id=$1::uuid LIMIT 1`, [claimId])).rows[0] ?? null;
  }

  private async readReceipt(tx: TransactionClient, claimId: string): Promise<Row | null> {
    return (await tx.query<Row>(`SELECT * FROM mdf_cnc_observation_receipts WHERE claim_id=$1::uuid`, [claimId])).rows[0] ?? null;
  }

  private async updateRawStatus(tx: TransactionClient, packetId: string, completed: boolean,
    thumbsUp: boolean, clearReturnFence = false): Promise<boolean> {
    // A pending report is never allowed to erase already accepted physical
    // cut/lamination evidence, even when a return fence is still waiting.
    if (!completed && await this.hasAcceptedPhysicalCutForAnyRevision(tx, packetId)) return false;
    const desired = completed ? 'completed' : 'pending';
    const row = (await tx.query<{ changed: boolean }>(`UPDATE cnc_telegram_packets SET completion_status=$2,
      thumbs_up=$3,completed_at=CASE WHEN $2='completed' THEN COALESCE(completed_at,now()) ELSE NULL END,
      mdf_completion_returned=CASE WHEN $4 THEN false ELSE mdf_completion_returned END,
      updated_at=now() WHERE packet_id=$1::uuid AND (completion_status IS DISTINCT FROM $2 OR thumbs_up IS DISTINCT FROM $3
        OR ($2='pending' AND completed_at IS NOT NULL) OR ($4 AND mdf_completion_returned))
      RETURNING true changed`, [packetId, desired, thumbsUp, clearReturnFence])).rows[0];
    return Boolean(row?.changed);
  }

  private async hasAcceptedPhysicalCutForAnyRevision(tx: TransactionClient, packetId: string): Promise<boolean> {
    return Boolean((await tx.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM mdf_source_heads h
      JOIN mdf_evidence_lines l ON l.source_kind=h.source_kind AND l.source_id=h.source_id
        AND l.revision_key=h.accepted_revision_key
      WHERE h.source_kind='packet' AND h.source_id=$1 AND l.stage_code IN ('cut','laminated')
        AND l.evidence_kind IN ('physical','declaration')) exists`, [packetId])).rows[0]?.exists);
  }

  private async hasAcceptedPhysicalCut(tx: TransactionClient, packetId: string, revision: string): Promise<boolean> {
    return Boolean((await tx.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM mdf_evidence_lines
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 AND stage_code IN ('cut','laminated')
        AND evidence_kind IN ('physical','declaration')) exists`, [packetId, revision])).rows[0]?.exists);
  }

  private async scheduleAgain(tx: TransactionClient, target: TargetRow, seconds: number): Promise<void> {
    await tx.query(`UPDATE mdf_cnc_observation_targets SET claim_id=NULL,claim_token_hash=NULL,
      claim_worker_instance_id=NULL,claim_session_generation=NULL,claim_expires_at=NULL,claim_head_version=NULL,
      claim_correction_epoch=NULL,claim_raw_source_version=NULL,claim_observation_version=NULL,
      next_due_at=clock_timestamp()+($2::integer*interval '1 second'),updated_at=now() WHERE packet_id=$1::uuid`,
    [target.packet_id, seconds]);
  }

  private async quarantineTarget(tx: TransactionClient, target: TargetRow, user: CurrentUser, reason: string,
    owners: readonly number[] = []): Promise<void> {
    await tx.query(`UPDATE mdf_cnc_observation_targets SET work_state='needs_reconciliation',claim_id=NULL,
      claim_token_hash=NULL,claim_worker_instance_id=NULL,claim_session_generation=NULL,claim_expires_at=NULL,
      claim_head_version=NULL,claim_correction_epoch=NULL,claim_raw_source_version=NULL,claim_observation_version=NULL,
      next_due_at=clock_timestamp()+($2::integer*interval '1 second'),updated_at=now()
      WHERE packet_id=$1::uuid`, [target.packet_id, OBSERVATION_FAILURE_SECONDS]);
    const auditId=await auditService.record(tx, { event: 'cnc.mdf_observation.needs_reconciliation', actorUserId: user.id,
      actorUsername: user.username, actorRole: user.role, entityType: 'cnc_telegram_packet',
      entityId: target.packet_id, source: 'cnc_mdf_observation_worker',
      requestId: `mdf-observation-quarantine:${target.packet_id}:${target.accepted_revision_key}`,
      metadata: { reason, acceptedRevisionKey: target.accepted_revision_key },
      relatedEntities: owners.map(entityId=>({entityType:'order',entityId})) });
    if (!auditId) throw new Error('MDF_CNC_OBSERVATION_AUDIT_REQUIRED');
  }

  private async finishTarget(tx: TransactionClient, target: TargetRow, observationVersion: string,
    acceptedRevision: string): Promise<void> {
    await tx.query(`UPDATE mdf_cnc_observation_targets SET work_state='completed',accepted_revision_key=$2,
      last_observation_version=$3::bigint,claim_id=NULL,claim_token_hash=NULL,claim_worker_instance_id=NULL,
      claim_session_generation=NULL,claim_expires_at=NULL,claim_head_version=NULL,claim_correction_epoch=NULL,
      claim_raw_source_version=NULL,claim_observation_version=NULL,updated_at=now() WHERE packet_id=$1::uuid`,
    [target.packet_id, acceptedRevision, observationVersion]);
  }

  private async insertObservationReceipt(tx: TransactionClient, input: { target: TargetRow; lease: CncTelegramWorkerSessionLeaseContext;
    report: MdfCncObservationReport; reportDigest: string; state: 'pending' | 'completed'; observationVersion: string;
    result: MdfCncObservationResult }): Promise<void> {
    if (!input.target.claim_token_hash || !input.target.claim_head_version || !input.target.claim_correction_epoch
      || !input.target.claim_raw_source_version || !input.target.claim_observation_version) {
      fail(409, 'MDF_CNC_OBSERVATION_STALE', 'Заявка наблюдения CNC устарела');
    }
    await tx.query(`INSERT INTO mdf_cnc_observation_receipts(claim_id,packet_id,claim_generation,claim_token_hash,
      worker_instance_id,session_generation,head_version,correction_epoch,raw_source_version,observation_version,
      report_state,failure_code,report_digest,report,result)
      VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7::bigint,$8::bigint,$9::bigint,$10::bigint,
        $11,NULL,$12,$13::jsonb,$14::jsonb)`, [input.report.claimId, input.target.packet_id,
      input.report.claimGeneration, input.target.claim_token_hash, input.lease.workerInstanceId,
      input.lease.leaseGeneration, input.target.claim_head_version, input.target.claim_correction_epoch,
      input.target.claim_raw_source_version, input.observationVersion, input.state, input.reportDigest,
      JSON.stringify(input.report.messages), JSON.stringify(input.result)]);
  }

  private async recordPhysicalCut(tx: TransactionClient, user: CurrentUser, lease: CncTelegramWorkerSessionLeaseContext,
    target: TargetRow, head: HeadRow, report: MdfCncObservationReport, reportDigest: string, observationVersion: string,
    requestId: string): Promise<{ kind: 'recorded'; jobId: string; revisionKey: string } | { kind: 'needs_reconciliation' }> {
    const allocated = (await tx.query<{ allocated: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.state<>'released' AND e.source_kind='packet' AND e.source_id=$1 AND e.revision_key=$2
    ) allocated`, [target.packet_id, head.accepted_revision_key])).rows[0]?.allocated;
    if (allocated) return { kind: 'needs_reconciliation' };
    const revision = head.accepted_revision_key!;
    const base = (await tx.query<MdfReceiptLine>(`SELECT line_key "lineKey",order_id::float8 "orderId",
      detail_id::float8 "detailId",quantity::float8,stage_code "stageCode",evidence_kind "evidenceKind",rework
      FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2
      ORDER BY line_key`, [target.packet_id, revision])).rows;
    const membership = base.filter(line => line.stageCode === 'membership' && line.evidenceKind === 'derived');
    if (!membership.length) return { kind: 'needs_reconciliation' };
    const positions = new Map<string, { orderId: number; detailId: number; rework: boolean; member: number;
      physical: number; declared: number }>();
    for (const line of base) {
      const key = JSON.stringify([line.orderId, line.detailId, line.rework]);
      const value = positions.get(key) ?? { orderId: line.orderId, detailId: line.detailId, rework: line.rework,
        member: 0, physical: 0, declared: 0 };
      if (![line.orderId,line.detailId,line.quantity].every(Number.isSafeInteger) || line.quantity < 0) {
        return { kind: 'needs_reconciliation' };
      }
      try {
        if (line.stageCode === 'membership' && line.evidenceKind === 'derived') value.member = mdfSum(value.member,line.quantity);
        if (line.stageCode === 'cut' && line.evidenceKind === 'physical') value.physical = mdfSum(value.physical,line.quantity);
        if (line.stageCode === 'cut' && line.evidenceKind === 'declaration') value.declared = mdfSum(value.declared,line.quantity);
      } catch {
        return { kind: 'needs_reconciliation' };
      }
      positions.set(key, value);
    }
    const cuts: MdfReceiptLine[] = [];
    const preserved: MdfReceiptLine[] = base.filter(line => !(line.stageCode === 'cut' && line.evidenceKind === 'declaration'));
    for (const position of positions.values()) {
      let consumed: number;
      try { consumed=mdfSum(position.physical,position.declared); }
      catch { return { kind: 'needs_reconciliation' }; }
      if (consumed > position.member) return { kind: 'needs_reconciliation' };
      const quantity = Math.max(position.member - position.physical, 0);
      if (quantity) cuts.push({ lineKey: `cnc-cut:${position.orderId}:${position.detailId}:${position.rework ? 1 : 0}:${report.claimId}`,
        orderId: position.orderId, detailId: position.detailId, quantity, stageCode: 'cut',
        evidenceKind: 'physical', rework: position.rework });
    }
    const contextRow = (await tx.query<Row>(`SELECT c.source_created_at::text source_created_at,c.display_name,
      c.prior_column,c.manual_placement_column,c.composition_complete
      FROM mdf_revision_context c JOIN mdf_revision_seals z USING(source_kind,source_id,revision_key)
      WHERE c.source_kind='packet' AND c.source_id=$1 AND c.revision_key=$2`, [target.packet_id, revision])).rows[0];
    const demandRows = (await tx.query<{ orderId: number; detailId: number; quantity: number }>(`SELECT
      order_id::float8 "orderId",detail_id::float8 "detailId",quantity::float8 quantity FROM mdf_revision_demand
      WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 ORDER BY order_id,detail_id`, [target.packet_id, revision])).rows;
    if (!contextRow || !demandRows.length || !contextRow.composition_complete) return { kind: 'needs_reconciliation' };
    const manualColumn = contextRow.manual_placement_column === 'parsed' ? null : contextRow.manual_placement_column;
    // The first accepted exact-message completion is also the durable CNC
    // authority event. Even when a prior manual physical receipt already
    // covers every quantity, append a distinct receipt/job so CNC authority
    // can drive its own pinned effects exactly once.
    const context: MdfExecutionContext = { sourceCreatedAt: text(contextRow, 'source_created_at'),
      displayName: text(contextRow, 'display_name'), priorColumn: nullableText(contextRow, 'prior_column'),
      manualPlacementColumn: manualColumn, compositionComplete: true, demand: demandRows };
    const rules = (await tx.query<{ ruleId: number; version: number }>(`SELECT id::float8 "ruleId",version::integer version
      FROM status_automation_rules WHERE is_enabled ORDER BY id`)).rows;
    const revisionKey = `cnc-observation:${report.claimId}`;
    const saved = await recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: target.packet_id,
      revisionKey, origin: 'cnc', actorUserId: Number(user.id), requestId,
      causeKey: `cnc-observation:${report.claimId}`, expectedFence: { version: head.version, correctionEpoch: head.correction_epoch },
      sourceDigest: digest([revision, reportDigest, lease.workerInstanceId, observationVersion]),
      executionContext: context, accept: true,
      lines: [...preserved, ...cuts], rules });
    if (!saved.accepted || saved.replay) return { kind: 'needs_reconciliation' };
    return { kind: 'recorded', jobId: saved.jobId, revisionKey };
  }

  private async insertAuthority(tx: TransactionClient, jobId: string, packetId: string, claimId: string): Promise<void> {
    await tx.query(`INSERT INTO mdf_cnc_observation_job_authorities(job_id,packet_id,claim_id,authority)
      VALUES($1::uuid,$2::uuid,$3::uuid,'cnc_autocut')`, [jobId, packetId, claimId]);
  }

  private async enqueueOutbox(tx: TransactionClient, packetId: string, claimId: string,
    result: MdfCncObservationResult, context: { actorUserId: string; requestId: string; orderIds: number[]; auditId: string }): Promise<void> {
    await tx.query(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
      VALUES('cnc.mdf_observation.recorded','cnc_telegram_packet',$1,$2::jsonb,$3)
      ON CONFLICT(idempotency_key) DO NOTHING`, [packetId, JSON.stringify({ packetId, claimId, result,
        actorUserId: context.actorUserId, requestId: context.requestId, orderIds: context.orderIds, auditId: context.auditId }),
      `cnc.mdf_observation:${claimId}`]);
  }
}

/** Called only by the successful explicit-import transaction after packet_id is persisted. */
export async function registerExplicitImportObservationTarget(tx: TransactionClient, input: {
  importItemId: string; packetId: string; completion: CncTelegramImportCompleteDto;
}): Promise<boolean> {
  const boundary = await requireMdfCommandBoundary(tx, { writer: 'cnc.mdf_observation.register', capability: 'cnc-receipt' });
  if (!boundary.queued) return false;
  const selectedSource = input.completion.source;
  const candidate = (await tx.query<Row>(`SELECT c.candidate_id::text candidate_id,c.source_chat_id,
    c.source_message_id::text source_group_message_id,c.source_set_fingerprint,c.svg_message_id::text svg_message_id,
    c.gcode_message_id::text gcode_message_id,c.screenshot_message_id::text screenshot_message_id,
    c.svg_content_sha256,c.gcode_content_sha256,c.screenshot_content_sha256,c.eligibility_status,
    c.expires_at>now() candidate_current,i.status item_status,i.packet_id::text item_packet_id,
    i.source_set_fingerprint item_fingerprint,i.duplicate_snapshot_json,i.duplicate_acknowledged
    FROM cnc_telegram_import_items i JOIN cnc_telegram_import_candidates c USING(candidate_id)
    WHERE i.import_item_id=$1::uuid FOR UPDATE OF i,c`, [input.importItemId])).rows[0];
  if (!candidate || candidate.item_status !== 'imported' || candidate.item_packet_id !== input.packetId
    || candidate.source_set_fingerprint !== candidate.item_fingerprint || !candidate.candidate_current
    || candidate.eligibility_status !== 'valid' || !Array.isArray(candidate.duplicate_snapshot_json)
    || candidate.duplicate_snapshot_json.length > 0 || candidate.duplicate_acknowledged) return false;
  if (candidate.source_chat_id === 'erp-manual-svg-upload' || candidate.source_chat_id !== selectedSource.sourceChatId
    || candidate.source_group_message_id !== selectedSource.sourceMessageId
    || candidate.source_set_fingerprint !== input.completion.sourceSetFingerprint) return false;
  const messages: Binding[] = [];
  const add = (messageId: unknown, role: MdfCncObservationMessageRole, sha: unknown) => {
    if (messageId == null && sha == null) return;
    if (typeof messageId !== 'string' || !/^[1-9]\d*$/.test(messageId)
      || typeof sha !== 'string' || !/^[a-f0-9]{64}$/i.test(sha)) throw new Error('MDF_CNC_OBSERVATION_CANDIDATE_INVALID');
    messages.push({ messageId, role, sha256: sha.toLowerCase() });
  };
  add(candidate.svg_message_id, 'svg', candidate.svg_content_sha256);
  add(candidate.gcode_message_id, 'gcode', candidate.gcode_content_sha256);
  add(candidate.screenshot_message_id, 'image', candidate.screenshot_content_sha256);
  if (messages.length < 1 || messages.length > 3 || !messages.some(message => message.role === 'svg')) return false;
  const fileHashes = new Map(input.completion.sourceFiles.map(file => [file.kind === 'screenshot' ? 'image' : file.kind, file.sha256.toLowerCase()]));
  if (fileHashes.size !== messages.length || messages.some(message => fileHashes.get(message.role) !== message.sha256)) return false;
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mdf-source:${JSON.stringify(source(input.packetId))}`]);
  const head = (await tx.query<HeadRow>(`SELECT received_revision_key,accepted_revision_key,version::text version,
    correction_epoch::text correction_epoch FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1 FOR UPDATE`, [input.packetId])).rows[0];
  if (!head || !head.accepted_revision_key || head.accepted_revision_key !== head.received_revision_key) return false;
  const packet = (await tx.query<Row>(`SELECT source_chat_id,source_version::text source_version
    FROM cnc_telegram_packets WHERE packet_id=$1::uuid FOR UPDATE`, [input.packetId])).rows[0];
  if (!packet || packet.source_chat_id !== 'erp-manual-svg-upload' || !validBigint(packet.source_version)) return false;
  const context = (await tx.query<{ composition_complete: boolean }>(`SELECT c.composition_complete FROM mdf_revision_context c
    JOIN mdf_revision_seals z USING(source_kind,source_id,revision_key)
    WHERE c.source_kind='packet' AND c.source_id=$1 AND c.revision_key=$2`, [input.packetId, head.accepted_revision_key])).rows[0];
  if (!context?.composition_complete) return false;
  const demandRows=(await tx.query<{orderId:number;detailId:number;quantity:number}>(`SELECT order_id::float8 "orderId",
    detail_id::float8 "detailId",quantity::float8 quantity FROM mdf_revision_demand WHERE source_kind='packet'
    AND source_id=$1 AND revision_key=$2 ORDER BY order_id,detail_id`,[input.packetId,head.accepted_revision_key])).rows;
  const owners=[...new Set(demandRows.map(row=>row.orderId))].sort((a,b)=>a-b);
  if (!demandRows.length || owners.length>MAX_OWNERS) return false;
  const execution=await loadMdfExecutionSnapshot(tx,[{kind:'packet',id:input.packetId,received:head.received_revision_key,
    accepted:head.accepted_revision_key,epoch:head.correction_epoch}],owners);
  if (execution.issues.get(sourceKey(input.packetId))?.length) return false;
  const acceptedMembershipDigest=await loadMembershipDigest(tx,input.packetId,head.accepted_revision_key);
  const membershipCount=(await tx.query<{count:string}>(`SELECT count(*)::text count FROM mdf_evidence_lines
    WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2 AND stage_code='membership' AND evidence_kind='derived'`,
  [input.packetId,head.accepted_revision_key])).rows[0]?.count;
  if (!membershipCount || membershipCount==='0') return false;
  const inserted = await tx.query(`INSERT INTO mdf_cnc_observation_targets(packet_id,import_item_id,candidate_id,
    source_chat_id,source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,
    accepted_revision_key,last_observation_version)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::bigint,$6::jsonb,$7,$8,$7,$9::bigint)
    ON CONFLICT(packet_id) DO NOTHING`, [input.packetId, input.importItemId, candidate.candidate_id,
    candidate.source_chat_id, candidate.source_group_message_id, JSON.stringify(messages), head.accepted_revision_key,
    acceptedMembershipDigest, packet.source_version]);
  return (inserted.rowCount ?? 0) === 1;
}

function validateRequestId(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || value.includes('\0')) {
    fail(400, 'MDF_CNC_OBSERVATION_INVALID', 'Некорректный идентификатор запроса');
  }
}
async function loadMembershipDigest(tx: TransactionClient, packetId: string, revision: string): Promise<string> {
  const rows = (await tx.query<{ lineKey: string; orderId: string; detailId: string; quantity: string; rework: boolean }>(`SELECT
    line_key "lineKey",order_id::text "orderId",detail_id::text "detailId",quantity::text quantity,rework
    FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$1 AND revision_key=$2
      AND stage_code='membership' AND evidence_kind='derived'
    ORDER BY line_key,order_id,detail_id,rework`, [packetId, revision])).rows;
  return digest(rows.map(row => [row.lineKey, row.orderId, row.detailId, row.quantity, row.rework]));
}
function validateClaimIdentity(id: string, token: string, generation: number): void {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || typeof token !== 'string'
    || !/^[a-f0-9]{64}$/.test(token) || !Number.isSafeInteger(generation) || generation < 1) {
    fail(400, 'MDF_CNC_OBSERVATION_REPORT_INVALID', 'Некорректная заявка наблюдения CNC');
  }
}
function normalizeReport(input: MdfCncObservationReport): MdfCncObservationReport {
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 3) {
    fail(400, 'MDF_CNC_OBSERVATION_REPORT_INVALID', 'Неполный состав CNC-сообщений');
  }
  return { claimId: input.claimId, claimToken: input.claimToken, claimGeneration: input.claimGeneration,
    messages: [...input.messages].map(message => ({ ...message })).sort((a, b) => a.messageId - b.messageId) };
}
function validateReportedGroup(reports: MdfCncObservationReport['messages'], bindings: readonly Binding[], chatId: string): void {
  if (reports.length !== bindings.length) fail(422, 'MDF_CNC_OBSERVATION_GROUP_INCOMPLETE', 'Не удалось проверить все сообщения исходной группы');
  const byId = new Map(reports.map(report => [String(report.messageId), report]));
  for (const binding of bindings) {
    const report = byId.get(binding.messageId);
    if (!report || report.chatId !== chatId || report.role !== binding.role || report.sha256.toLowerCase() !== binding.sha256
      || report.present !== true || typeof report.thumbsUp !== 'boolean') {
      fail(422, 'MDF_CNC_OBSERVATION_MEDIA_MISMATCH', 'Сообщение CNC отсутствует или не совпадает с зарегистрированным файлом');
    }
  }
}
function claimStillCurrent(target: TargetRow, claim: Pick<MdfCncObservationReport, 'claimId' | 'claimToken' | 'claimGeneration'>,
  lease: CncTelegramWorkerSessionLeaseContext): boolean {
  return target.claim_id === claim.claimId && target.claim_token_hash !== null
    && tokenMatches(claim.claimToken, target.claim_token_hash)
    && Number(target.claim_generation) === claim.claimGeneration
    && target.claim_worker_instance_id === lease.workerInstanceId
    && Number(target.claim_session_generation) === lease.leaseGeneration
    && target.claim_live === true;
}
function nextVersion(targetVersion: string, rawVersion: string, fence: FenceRow | undefined): string {
  const values = [targetVersion, rawVersion, fence?.baseline_source_version, fence?.pending_source_version,
    fence?.completion_source_version].filter((value): value is string => Boolean(value));
  if (values.some(value => !validBigint(value))) fail(503, 'MDF_CNC_OBSERVATION_STATE_INVALID', 'Состояние версии CNC повреждено');
  const max = values.reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
  const next = BigInt(max) + 1n;
  if (next > 9223372036854775807n) fail(503, 'MDF_CNC_OBSERVATION_STATE_INVALID', 'Счётчик CNC исчерпан');
  return next.toString();
}
function replayResult(receipt: Row, lease: CncTelegramWorkerSessionLeaseContext, report: MdfCncObservationReport,
  reportDigest: string): MdfCncObservationResult {
  if (text(receipt, 'claim_token_hash') !== digest(report.claimToken)
    || text(receipt, 'worker_instance_id') !== lease.workerInstanceId
    || Number(receipt.session_generation) !== lease.leaseGeneration
    || text(receipt, 'report_digest') !== reportDigest
    || text(receipt, 'report_state') === 'failed') {
    fail(409, 'MDF_CNC_OBSERVATION_REPLAY_CONFLICT', 'Заявка уже завершена другим результатом');
  }
  const result = typeof receipt.result === 'string' ? JSON.parse(receipt.result) : receipt.result;
  if (!result || (result.status !== 'recorded' && result.status !== 'needs_reconciliation')) {
    fail(503, 'MDF_CNC_OBSERVATION_STATE_INVALID', 'Сохранённый результат CNC повреждён');
  }
  return result as MdfCncObservationResult;
}
function assertFailureReplay(receipt: Row, lease: CncTelegramWorkerSessionLeaseContext, token: string,
  generation: number, reason: MdfCncObservationFailureReason): void {
  if (text(receipt, 'report_state') !== 'failed' || text(receipt, 'claim_token_hash') !== digest(token)
    || text(receipt, 'worker_instance_id') !== lease.workerInstanceId
    || Number(receipt.session_generation) !== lease.leaseGeneration
    || Number(receipt.claim_generation) !== generation || text(receipt, 'failure_code') !== reason) {
    fail(409, 'MDF_CNC_OBSERVATION_REPLAY_CONFLICT', 'Заявка уже завершена другим результатом');
  }
}
