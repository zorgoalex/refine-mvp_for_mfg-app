import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CncTelegramManualSvgOrderFileDto,
  CncTelegramManualSvgTelegramSendClaimResponseDto,
  CncTelegramManualSvgTelegramSendCompleteDto,
  CncTelegramManualSvgTelegramSendResponseDto,
  CncTelegramMediaRestoreCompleteDto,
  CncTelegramMediaRestoreFailureDto,
  CncTelegramMediaRestoreResponseDto,
  CncTelegramMediaRestoreTaskDto,
  CncTelegramOrderScreenshotDto,
} from '../dto/cnc-telegram-media.dto';
import type { CncTelegramWorkerSessionLeaseContext } from '../application/cnc-telegram-worker-session.types';
import { assertCurrentWorkerSessionInTransaction } from './cnc-telegram-worker-session-fencing';

const SOURCE = 'backend-cnc-telegram-media';
const ORIGINAL_RETENTION_SQL = "interval '30 days'";
const RESTORE_LEASE_SQL = "interval '5 minutes'";
const MANUAL_SVG_SEND_UNKNOWN_AFTER_SQL = "interval '15 minutes'";

interface ScreenshotRow extends QueryResultRow {
  kind: 'telegram' | 'svg_cut';
  packet_id: string;
  source_message_id: string | number | null;
  source_created_at: string | Date;
  program_name: string | null;
  material_name: string;
  sheet_image_storage_key: string | null;
  sheet_image_content_type: string | null;
  sheet_image_size_bytes: string | number | null;
  matched_detail_count: string | number;
  item_quantity_total: string | number;
  svg_cut_job_id: string | number | null;
  svg_cut_job_display_number: string | number | null;
  svg_cut_result_no: string | number | null;
  svg_cut_group_id: string | number | null;
  svg_cut_sheet_index: string | number | null;
  svg_cut_sheet_number: string | number | null;
  svg_cut_variant: 'auto' | 'manual' | null;
  original_available: boolean;
  available_until: string | Date;
  restore_request_id: string | null;
  restore_status: 'pending' | 'processing' | 'completed' | 'failed' | null;
  restore_requested_at: string | Date | null;
  restore_error: string | null;
}

interface RestoreRow extends QueryResultRow {
  restore_request_id: string;
  packet_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  requested_at: string | Date;
  available_until: string | Date | null;
  lease_token?: string | null;
  lease_generation?: string | number | null;
  lease_worker_instance_id?: string | null;
  lease_expires_at?: string | Date | null;
  lease_valid?: boolean;
}

interface RestoreTaskRow extends QueryResultRow {
  restore_request_id: string;
  packet_id: string;
  source_chat_id: string;
  source_message_id: string | number;
  sheet_image_storage_key: string;
  attempt_count: string | number;
  lease_token: string;
  lease_generation: string | number;
  lease_worker_instance_id: string;
}

interface RestoreStateRow extends RestoreRow {
  source_chat_id: string;
  source_message_id: string | number;
  sheet_image_storage_key: string;
  lease_worker_instance_id: string | null;
}

interface ManualSvgOrderFileRow extends QueryResultRow {
  file_id: string;
  packet_id: string;
  file_kind: 'svg' | 'gcode' | 'screenshot';
  original_file_name: string;
  content_type: string;
  content_sha256: string;
  size_bytes: string | number;
  generated: boolean;
  created_at: string | Date;
  expires_at: string | Date;
  svg_cut_job_id: string | number | null;
  svg_cut_job_display_number: string | number | null;
  svg_cut_result_id: string | number | null;
  svg_cut_result_no: string | number | null;
  telegram_send_status: 'pending' | 'processing' | 'sent' | 'failed' | 'unknown' | null;
}

interface ManualSvgFileContentRow extends ManualSvgOrderFileRow {
  content_bytes: Buffer;
}

interface ManualSvgTelegramSendTaskRow extends QueryResultRow {
  request_id: string;
  packet_id: string;
  destination_chat_id: string;
  packet_source_chat_id: string;
  cut_job_id: string | number;
  cut_job_display_number: string | number;
  message_text: string;
  attempt_count: string | number;
  files_json: unknown;
  requested_file_count: string | number;
  packet_source_version: string | null;
  accepted_revision_key: string | null;
  received_revision_key: string | null;
  source_head_version: string | null;
  source_correction_epoch: string | null;
  source_context_sealed: boolean;
  source_composition_complete: boolean;
  membership_json: unknown;
  demand_json: unknown;
  observation_binding_version?: 1;
  lease_token: string;
  lease_generation: string | number;
  lease_worker_instance_id: string;
}

interface ManualSvgTelegramSendRow extends QueryResultRow {
  request_id: string;
  packet_id: string;
  destination_chat_id?: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'unknown';
  requested_at: string | Date;
  finished_at: string | Date | null;
  sent_chat_id: string | null;
  sent_message_ids_json: unknown;
  last_error: string | null;
  lease_token?: string | null;
  lease_generation?: string | number | null;
  lease_worker_instance_id?: string | null;
  lease_expires_at?: string | Date | null;
  lease_valid?: boolean;
}

interface ManualSvgObservationClaimSnapshotRow extends QueryResultRow {
  send_request_id: string; lease_generation: string; worker_instance_id: string; session_generation: string;
  lease_token_hash: string; packet_id: string; destination_chat_id: string; requested_file_count: number;
  files_qualified: boolean; files_snapshot: unknown; source_eligible: boolean; source_fence: unknown;
  ineligible_reason: string | null;
}

interface ManualSvgTelegramSendUnknownRow extends QueryResultRow {
  request_id: string;
  packet_id: string;
  previous_status: 'pending' | 'processing';
  state_at: string | Date | null;
  attempt_count: string | number;
  last_error: string | null;
}

export interface OrderScreenshotMediaDescriptor {
  packetId: string;
  sourceMessageId: number;
  sourceCreatedAt: string;
  storageKey: string;
  contentType: string | null;
  sizeBytes: number | null;
  originalAvailable: boolean;
  availableUntil: string;
}

export interface OrderManualSvgFileDescriptor {
  fileId: string;
  packetId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  raw: Buffer;
  expiresAt: string;
}

export class PgCncTelegramMediaRepository {
  constructor(private readonly database: DatabaseService) {}

  async listOrderScreenshots(orderId: number): Promise<CncTelegramOrderScreenshotDto[]> {
    const result = await this.database.query<ScreenshotRow>(screenshotSelectSql(''), [orderId]);
    return result.rows.map((row) => mapScreenshotRow(row, orderId));
  }

  async listOrderManualSvgFiles(orderId: number): Promise<CncTelegramManualSvgOrderFileDto[]> {
    const result = await this.database.query<ManualSvgOrderFileRow>(manualSvgOrderFilesSql('AND f.expires_at > now()'), [orderId]);
    return result.rows.map((row) => mapManualSvgOrderFileRow(row, orderId));
  }

  async resolveOrderManualSvgFile(orderId: number, fileId: string): Promise<OrderManualSvgFileDescriptor> {
    const result = await this.database.query<ManualSvgFileContentRow>(
      manualSvgOrderFilesSql('AND f.file_id = $2::uuid', 'f.content_bytes,'),
      [orderId, fileId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(404, 'NOT_FOUND', 'Файл SVG-раскроя для заказа не найден', {
        orderId,
        fileId,
      });
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new ApiError(410, 'MANUAL_SVG_UPLOAD_FILE_EXPIRED', 'Срок хранения файла в ERP истёк', {
        orderId,
        fileId,
        expiresAt: toIso(row.expires_at),
      });
    }
    return {
      fileId: row.file_id,
      packetId: row.packet_id,
      fileName: row.original_file_name,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      sha256: row.content_sha256,
      raw: row.content_bytes,
      expiresAt: toIso(row.expires_at),
    };
  }

  async resolveOrderScreenshot(orderId: number, packetId: string): Promise<OrderScreenshotMediaDescriptor> {
    const result = await this.database.query<ScreenshotRow>(
      screenshotSelectSql('AND p.packet_id = $2::uuid'),
      [orderId, packetId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(404, 'NOT_FOUND', 'Скрин раскроя для заказа не найден', {
        orderId,
        packetId,
      });
    }
    if (row.kind !== 'telegram' || !row.sheet_image_storage_key || row.source_message_id === null) {
      throw new ApiError(404, 'NOT_FOUND', 'Telegram-скрин раскроя для заказа не найден', {
        orderId,
        packetId,
      });
    }
    return {
      packetId: row.packet_id,
      sourceMessageId: Number(row.source_message_id),
      sourceCreatedAt: toIso(row.source_created_at),
      storageKey: row.sheet_image_storage_key,
      contentType: row.sheet_image_content_type,
      sizeBytes: nullableNumber(row.sheet_image_size_bytes),
      originalAvailable: row.original_available === true,
      availableUntil: toIso(row.available_until),
    };
  }

  async requestRestore(input: {
    orderId: number;
    packetId: string;
    currentUser: CurrentUser;
    requestId: string;
  }): Promise<CncTelegramMediaRestoreResponseDto> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [input.packetId]);
      const packet = await tx.query<ScreenshotRow>(
        screenshotSelectSql('AND p.packet_id = $2::uuid'),
        [input.orderId, input.packetId],
      );
      const packetRow = packet.rows[0];
      if (!packetRow) {
        throw new ApiError(404, 'NOT_FOUND', 'Скрин раскроя для заказа не найден', {
          orderId: input.orderId,
          packetId: input.packetId,
        });
      }
      if (packetRow.kind !== 'telegram') {
        throw new ApiError(409, 'CNC_TELEGRAM_MEDIA_RESTORE_UNAVAILABLE', 'Для SVG-раскроя восстановление Telegram-скрина не требуется', {
          orderId: input.orderId,
          packetId: input.packetId,
        });
      }

      const active = await tx.query<RestoreRow>(
        `SELECT restore_request_id, packet_id, status, requested_at, available_until
         FROM cnc_telegram_media_restore_requests
         WHERE packet_id=$1::uuid AND status IN ('pending','processing')
         ORDER BY requested_at DESC, restore_request_id DESC
         LIMIT 1`,
        [input.packetId],
      );
      if (active.rows[0]) return mapRestoreResponse(active.rows[0]);

      const inserted = await tx.query<RestoreRow>(
        `INSERT INTO cnc_telegram_media_restore_requests (
           packet_id, requested_by, request_trace_id
         ) VALUES ($1::uuid, $2::bigint, $3)
         RETURNING restore_request_id, packet_id, status, requested_at, available_until`,
        [input.packetId, input.currentUser.id, input.requestId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('restore request insert returned no row');
      await auditService.record(tx, {
        event: 'cnc.telegram_media.restore_requested',
        entityType: 'cnc_telegram_media_restore_request',
        entityId: row.restore_request_id,
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username ?? null,
        actorRole: input.currentUser.role ?? null,
        requestId: input.requestId,
        source: SOURCE,
        relatedOrderId: input.orderId,
        before: {},
        after: { status: 'pending' },
        diff: { status: { from: null, to: 'pending' } },
        metadata: { packetId: input.packetId },
      });
      return mapRestoreResponse(row);
    });
  }

  async claimRestores(
    allowedChatIds: readonly string[],
    limit: number,
    sessionLease: CncTelegramWorkerSessionLeaseContext,
  ): Promise<CncTelegramMediaRestoreTaskDto[]> {
    const sourceChatId = sessionLease.sourceChatId;
    if (allowedChatIds.length !== 1 || allowedChatIds[0] !== sourceChatId) {
      throw new ApiError(403, 'CNC_TELEGRAM_CHAT_DENIED', 'Worker claim chat must equal the current session lease chat');
    }
    const result = await this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, sessionLease);
      return tx.query<RestoreTaskRow>(
        `WITH candidates AS (
         SELECT request.restore_request_id
         FROM cnc_telegram_media_restore_requests request
         JOIN cnc_telegram_packets packet ON packet.packet_id=request.packet_id
         WHERE packet.source_chat_id=$1
           AND packet.source_message_id IS NOT NULL
           AND packet.sheet_image_storage_key IS NOT NULL
           AND request.attempt_count < 5
           AND (
             request.status='pending'
             OR (request.status='processing' AND request.lease_expires_at IS NOT NULL AND request.lease_expires_at <= now())
           )
         ORDER BY request.requested_at, request.restore_request_id
         FOR UPDATE OF request SKIP LOCKED
         LIMIT $2::integer
       ), claimed AS (
         UPDATE cnc_telegram_media_restore_requests request
         SET status='processing',
             attempt_count=request.attempt_count+1,
             claimed_at=now(),
             lease_token=gen_random_uuid()::text || gen_random_uuid()::text,
             lease_generation=request.lease_generation+1,
             lease_worker_instance_id=$3::uuid,
             lease_expires_at=now() + ${RESTORE_LEASE_SQL},
             finished_at=NULL,
             available_until=NULL,
             last_error=NULL,
             updated_at=now()
         FROM candidates
         WHERE request.restore_request_id=candidates.restore_request_id
         RETURNING request.restore_request_id, request.packet_id, request.attempt_count,
                   request.lease_token, request.lease_generation, request.lease_worker_instance_id
       )
       SELECT claimed.restore_request_id, claimed.packet_id, claimed.attempt_count,
              claimed.lease_token, claimed.lease_generation, claimed.lease_worker_instance_id,
              packet.source_chat_id, packet.source_message_id, packet.sheet_image_storage_key
       FROM claimed
       JOIN cnc_telegram_packets packet ON packet.packet_id=claimed.packet_id
       ORDER BY claimed.restore_request_id`,
        [sourceChatId, limit, sessionLease.workerInstanceId],
      );
    });
    return result.rows.map((row) => ({
      requestId: row.restore_request_id,
      packetId: row.packet_id,
      sourceChatId: row.source_chat_id,
      sourceMessageId: Number(row.source_message_id),
      storageKey: row.sheet_image_storage_key,
      attempt: Number(row.attempt_count),
      itemLeaseToken: row.lease_token,
      itemLeaseGeneration: Number(row.lease_generation),
      itemLeaseOwner: row.lease_worker_instance_id,
    }));
  }

  async claimManualSvgTelegramSends(input: {
    currentUser: CurrentUser;
    limit: number;
    requestTraceId: string;
    sessionLease: CncTelegramWorkerSessionLeaseContext;
  }): Promise<CncTelegramManualSvgTelegramSendClaimResponseDto['tasks']> {
    const result = await this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.sessionLease);
      await markStaleManualSvgTelegramSendsUnknown(tx, input);
      const claimed = await tx.query<ManualSvgTelegramSendTaskRow>(
         `WITH candidates AS (
           SELECT request.request_id
           FROM cnc_manual_svg_telegram_send_requests request
           JOIN cnc_telegram_packets packet ON packet.packet_id=request.packet_id
           JOIN cut_job svg_job ON svg_job.cut_job_id=packet.svg_cut_job_id
           WHERE request.status='pending'
             AND request.destination_chat_id=$2
             AND request.attempt_count < 5
             AND packet.svg_cut_import_status='imported'
             AND packet.svg_cut_job_id IS NOT NULL
             AND NULLIF(trim(svg_job.source_display_number::text), '') IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM outbox_events mdf_card
               WHERE mdf_card.idempotency_key =
                 'cnc-manual-svg:' || packet.packet_id::text || ':source-' || packet.source_version::text || ':mdf-card-created'
             )
             AND EXISTS (
               SELECT 1
               FROM cnc_manual_svg_telegram_send_request_files request_file
               JOIN cnc_manual_svg_upload_files file ON file.file_id=request_file.file_id
               WHERE request_file.request_id=request.request_id
                 AND file.expires_at > now()
             )
           ORDER BY request.requested_at, request.request_id
           FOR UPDATE OF request SKIP LOCKED
           LIMIT $1::integer
         ), claimed AS (
           UPDATE cnc_manual_svg_telegram_send_requests request
           SET status='processing',
               attempt_count=request.attempt_count+1,
               claimed_at=now(),
               finished_at=NULL,
               sent_chat_id=NULL,
               sent_message_ids_json='[]'::jsonb,
               lease_token=gen_random_uuid()::text || gen_random_uuid()::text,
               lease_generation=request.lease_generation+1,
               lease_worker_instance_id=$3::uuid,
               lease_expires_at=now() + ${RESTORE_LEASE_SQL},
               last_error=NULL,
               updated_at=now()
           FROM candidates
           WHERE request.request_id=candidates.request_id
           RETURNING request.request_id, request.packet_id, request.destination_chat_id,
                     request.message_text, request.attempt_count,
                     request.lease_token, request.lease_generation, request.lease_worker_instance_id
         )
         SELECT claimed.request_id, claimed.packet_id,
                claimed.destination_chat_id, packet.source_chat_id AS packet_source_chat_id,
                packet.svg_cut_job_id AS cut_job_id,
                svg_job.source_display_number AS cut_job_display_number,
                packet.source_version::text AS packet_source_version,
                head.received_revision_key AS received_revision_key,
                head.accepted_revision_key AS accepted_revision_key,
                head.version::text AS source_head_version,
                head.correction_epoch::text AS source_correction_epoch,
                COALESCE(context.source_context_sealed,false) AS source_context_sealed,
                COALESCE(context.source_composition_complete,false) AS source_composition_complete,
                files.requested_file_count,
                files.files_json,
                COALESCE(membership.membership_json,'[]'::jsonb) AS membership_json,
                COALESCE(demand.demand_json,'[]'::jsonb) AS demand_json,
                claimed.message_text, claimed.attempt_count,
                claimed.lease_token, claimed.lease_generation, claimed.lease_worker_instance_id
         FROM claimed
         JOIN cnc_telegram_packets packet ON packet.packet_id=claimed.packet_id
         JOIN cut_job svg_job ON svg_job.cut_job_id=packet.svg_cut_job_id
         LEFT JOIN mdf_source_heads head ON head.source_kind='packet' AND head.source_id=claimed.packet_id::text
         LEFT JOIN LATERAL (
           SELECT context.composition_complete AS source_composition_complete,true AS source_context_sealed
           FROM mdf_revision_context context JOIN mdf_revision_seals seal USING(source_kind,source_id,revision_key)
           WHERE context.source_kind='packet' AND context.source_id=claimed.packet_id::text
             AND context.revision_key=head.accepted_revision_key LIMIT 1
         ) context ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::integer requested_file_count,
             COALESCE(jsonb_agg(jsonb_build_object('fileId',file.file_id,'kind',file.file_kind,
               'fileName',file.original_file_name,'contentType',file.content_type,'sizeBytes',file.size_bytes,
               'sha256',file.content_sha256,'base64Content',encode(file.content_bytes,'base64'),
               'sendOrder',request_file.send_order)
               ORDER BY request_file.send_order) FILTER (WHERE file.file_id IS NOT NULL AND file.expires_at>now()),
               '[]'::jsonb) files_json
           FROM cnc_manual_svg_telegram_send_request_files request_file
           LEFT JOIN cnc_manual_svg_upload_files file ON file.file_id=request_file.file_id
           WHERE request_file.request_id=claimed.request_id
         ) files ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_array(line.line_key,line.order_id::text,line.detail_id::text,
             line.quantity::text,line.rework) ORDER BY line.line_key,line.order_id,line.detail_id,line.rework) membership_json
           FROM (SELECT line_key,order_id,detail_id,quantity,rework FROM mdf_evidence_lines
             WHERE source_kind='packet' AND source_id=claimed.packet_id::text
               AND revision_key=head.accepted_revision_key AND stage_code='membership' AND evidence_kind='derived'
             ORDER BY line_key,order_id,detail_id,rework LIMIT 5001) line
         ) membership ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_array(demand.order_id::text,demand.detail_id::text,demand.quantity::text)
             ORDER BY demand.order_id,demand.detail_id) demand_json
           FROM (SELECT order_id,detail_id,quantity FROM mdf_revision_demand
             WHERE source_kind='packet' AND source_id=claimed.packet_id::text
               AND revision_key=head.accepted_revision_key
             ORDER BY order_id,detail_id LIMIT 5001) demand
         ) demand ON true
         ORDER BY claimed.request_id`,
        [input.limit, input.sessionLease.sourceChatId, input.sessionLease.workerInstanceId],
      );
      for (const row of claimed.rows) {
        const snapshot = buildManualSvgObservationClaimSnapshot(row);
        await tx.query(`INSERT INTO cnc_manual_svg_observation_claim_snapshots(
          send_request_id,lease_generation,worker_instance_id,session_generation,lease_token_hash,
          packet_id,destination_chat_id,requested_file_count,files_qualified,files_snapshot,
          source_eligible,source_fence,ineligible_reason)
          VALUES($1::uuid,$2::bigint,$3::uuid,$4::bigint,$5,$6::uuid,$7,$8::integer,$9,$10::jsonb,$11,$12::jsonb,$13)
          ON CONFLICT(send_request_id,lease_generation) DO NOTHING`, [row.request_id,row.lease_generation,
          input.sessionLease.workerInstanceId,input.sessionLease.leaseGeneration,
          createHash('sha256').update(row.lease_token).digest('hex'),row.packet_id,row.destination_chat_id,
          snapshot.requestedFileCount,snapshot.filesQualified,JSON.stringify(snapshot.filesSnapshot),
          snapshot.sourceEligible,JSON.stringify(snapshot.sourceFence),snapshot.ineligibleReason]);
        row.observation_binding_version = snapshot.filesQualified ? 1 : undefined;
        const auditId = await auditService.record(tx, {
          event: 'cnc.manual_svg_upload.telegram_send_claimed',
          entityType: 'cnc_manual_svg_telegram_send_request',
          entityId: row.request_id,
          actorUserId: input.currentUser.id,
          actorUsername: input.currentUser.username ?? null,
          actorRole: input.currentUser.role ?? null,
          requestId: input.requestTraceId,
          source: SOURCE,
          before: { status: 'pending' },
          after: { status: 'processing' },
          diff: { status: { from: 'pending', to: 'processing' } },
          metadata: {
            packetId: row.packet_id,
            packetSourceChatId: row.packet_source_chat_id,
            destinationChatId: row.destination_chat_id,
            workerInstanceId: input.sessionLease.workerInstanceId,
            attemptCount: Number(row.attempt_count),
            fileCount: Array.isArray(row.files_json) ? row.files_json.length : 0,
            observationBindingVersion: snapshot.filesQualified ? 1 : null,
            observerSourceEligible: snapshot.sourceEligible,
          },
        });
        if (!auditId) throw new Error('CNC_MANUAL_SVG_SEND_CLAIM_AUDIT_REQUIRED');
      }
      return claimed;
    });
    return result.rows.map(mapManualSvgTelegramSendTaskRow).filter((task) => task.files.length > 0);
  }

  async completeManualSvgTelegramSend(input: {
    requestId: string;
    currentUser: CurrentUser;
    completion: CncTelegramManualSvgTelegramSendCompleteDto;
    requestTraceId: string;
    sessionLease: CncTelegramWorkerSessionLeaseContext;
  }): Promise<CncTelegramManualSvgTelegramSendResponseDto> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.sessionLease);
      const current = await lockManualSvgTelegramSend(tx, input.requestId, input.sessionLease.sourceChatId);
      const snapshot = await readManualSvgObservationClaimSnapshot(tx, input.requestId, input.completion.itemLeaseGeneration);
      const lateSettlement = current.status === 'unknown' || (current.status === 'processing' && current.lease_valid !== true);
      assertItemLeaseIdentity(current, input.completion.itemLeaseToken, input.completion.itemLeaseGeneration,
        input.completion.itemLeaseOwner, input.sessionLease.workerInstanceId, !lateSettlement && current.status === 'processing');
      if (current.destination_chat_id !== input.completion.sentChatId
        || input.completion.sentChatId !== input.sessionLease.sourceChatId) {
        throw new ApiError(409, 'CNC_TELEGRAM_ITEM_LEASE_STALE', 'Manual-send completion chat does not match the claimed destination');
      }
      if (snapshot && (snapshot.packet_id !== current.packet_id
        || Number(snapshot.lease_generation) !== input.completion.itemLeaseGeneration
        || snapshot.worker_instance_id !== input.sessionLease.workerInstanceId
        || Number(snapshot.session_generation) !== input.sessionLease.leaseGeneration
        || createHash('sha256').update(input.completion.itemLeaseToken).digest('hex') !== snapshot.lease_token_hash)) {
        throw new ApiError(409,'CNC_TELEGRAM_ITEM_LEASE_STALE','Manual-send claim snapshot no longer matches this worker session');
      }
      if (current.status === 'sent') {
        const replayDigest = manualSvgSendCompletionDigest(input.completion);
        const prior = (await tx.query<{ completion_digest: string }>(`SELECT completion_digest
          FROM cnc_manual_svg_observation_send_bindings
          WHERE send_request_id=$1::uuid AND lease_generation=$2::bigint`,
        [input.requestId,input.completion.itemLeaseGeneration])).rows[0];
        const exactTransport = current.sent_chat_id === input.completion.sentChatId
          && JSON.stringify(stringArray(current.sent_message_ids_json)) === JSON.stringify(input.completion.sentMessageIds);
        if (!exactTransport || (prior ? prior.completion_digest !== replayDigest
          : Boolean(input.completion.sentFiles || input.completion.observationBindingError))) {
          throw new ApiError(409,'CNC_TELEGRAM_SEND_COMPLETION_CONFLICT','Результат отправки уже сохранён с другими сообщениями');
        }
        return mapManualSvgTelegramSendResponse(current);
      }
      if (current.status !== 'processing' && !(current.status === 'unknown' && snapshot)) {
        throw new ApiError(409, 'CONFLICT', 'Запрос отправки SVG-файлов не находится в обработке');
      }
      if (lateSettlement) {
        if (!snapshot || snapshot.packet_id !== current.packet_id
          || snapshot.worker_instance_id !== input.sessionLease.workerInstanceId
          || Number(snapshot.session_generation) !== input.sessionLease.leaseGeneration
          || Number(snapshot.lease_generation) !== input.completion.itemLeaseGeneration
          || snapshot.destination_chat_id !== input.sessionLease.sourceChatId
          || createHash('sha256').update(input.completion.itemLeaseToken).digest('hex') !== snapshot.lease_token_hash) {
          throw new ApiError(409,'CNC_TELEGRAM_ITEM_LEASE_STALE','Expired manual-send claim cannot be settled by this worker session');
        }
      }
      const completionDigest = manualSvgSendCompletionDigest(input.completion);
      const bindingStatus = snapshot ? classifyManualSvgSentBindings(snapshot,input.completion) : null;
      const completed = await tx.query<ManualSvgTelegramSendRow>(
        `UPDATE cnc_manual_svg_telegram_send_requests
         SET status='sent',
             finished_at=now(),
             sent_chat_id=$2,
             sent_message_ids_json=$3::jsonb,
             last_error=NULL,
             updated_at=now()
         WHERE request_id=$1::uuid
         RETURNING request_id, packet_id, status, requested_at, finished_at, sent_chat_id,
                   sent_message_ids_json, last_error`,
        [input.requestId, input.completion.sentChatId, JSON.stringify(input.completion.sentMessageIds)],
      );
      const row = completed.rows[0];
      if (!row) throw new Error('manual SVG Telegram send completion returned no row');
      if (snapshot) {
        const storedFiles = bindingStatus?.valid ? bindingStatus.sentFiles : null;
        const bindingError = input.completion.observationBindingError
          ?? (input.completion.sentFiles && !bindingStatus?.valid ? 'MEDIA_VERIFICATION_FAILED' : null);
        await tx.query(`INSERT INTO cnc_manual_svg_observation_send_bindings(
          send_request_id,lease_generation,sent_chat_id,transport_message_ids,sent_files,binding_error,completion_digest)
          VALUES($1::uuid,$2::bigint,$3,$4::jsonb,$5::jsonb,$6,$7)`, [input.requestId,
          input.completion.itemLeaseGeneration,input.completion.sentChatId,
          JSON.stringify(input.completion.sentMessageIds),storedFiles ? JSON.stringify(storedFiles) : null,
          bindingError,completionDigest]);
        const workState = bindingStatus?.valid && snapshot.files_qualified && snapshot.source_eligible
          && !bindingError ? 'pending' : 'ineligible';
        const reason = workState === 'pending' ? null
          : snapshot.ineligible_reason ?? bindingStatus?.reason ?? (bindingError ? 'MEDIA_VERIFICATION_FAILED' : 'SENT_BINDING_MISSING');
        await tx.query(`INSERT INTO cnc_manual_svg_observation_registration_work(
          send_request_id,lease_generation,work_state,reason)
          VALUES($1::uuid,$2::bigint,$3,$4)`, [input.requestId,input.completion.itemLeaseGeneration,workState,reason]);
      }
      const auditId = await auditService.record(tx, {
        event: 'cnc.manual_svg_upload.telegram_send_completed',
        entityType: 'cnc_manual_svg_telegram_send_request',
        entityId: input.requestId,
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username ?? null,
        actorRole: input.currentUser.role ?? null,
        requestId: input.requestTraceId,
        source: SOURCE,
        before: { status: current.status },
        after: { status: 'sent', sentChatId: input.completion.sentChatId },
        diff: { status: { from: current.status, to: 'sent' } },
        metadata: {
          packetId: row.packet_id,
          sentMessageIds: input.completion.sentMessageIds,
          observationRegistration: snapshot ? (bindingStatus?.valid ? (snapshot.source_eligible ? 'pending' : 'ineligible') : 'ineligible') : 'legacy_unbound',
          observationRegistrationReason: snapshot
            ? (snapshot.ineligible_reason ?? bindingStatus?.reason ?? input.completion.observationBindingError ?? null) : null,
        },
      });
      if (!auditId) throw new Error('CNC_MANUAL_SVG_SEND_COMPLETION_AUDIT_REQUIRED');
      return mapManualSvgTelegramSendResponse(row);
    });
  }

  async failManualSvgTelegramSend(input: {
    requestId: string;
    currentUser: CurrentUser;
    error: string;
    requestTraceId: string;
    sessionLease: CncTelegramWorkerSessionLeaseContext;
    leaseToken: string;
    leaseGeneration: number;
    leaseOwner: string;
  }): Promise<CncTelegramManualSvgTelegramSendResponseDto> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.sessionLease);
      const current = await lockManualSvgTelegramSend(tx, input.requestId, input.sessionLease.sourceChatId);
      assertItemLeaseIdentity(
        current,
        input.leaseToken,
        input.leaseGeneration,
        input.leaseOwner,
        input.sessionLease.workerInstanceId,
        current.status === 'processing',
      );
      if (current.status === 'failed' || current.status === 'unknown') return mapManualSvgTelegramSendResponse(current);
      if (current.status !== 'processing') {
        throw new ApiError(409, 'CONFLICT', 'Запрос отправки SVG-файлов не находится в обработке');
      }
      const failed = await tx.query<ManualSvgTelegramSendRow>(
        `UPDATE cnc_manual_svg_telegram_send_requests
         SET status='failed',
             finished_at=now(),
             sent_chat_id=NULL,
             sent_message_ids_json='[]'::jsonb,
             last_error=$2,
             updated_at=now()
         WHERE request_id=$1::uuid
         RETURNING request_id, packet_id, status, requested_at, finished_at, sent_chat_id,
                   sent_message_ids_json, last_error`,
        [input.requestId, input.error],
      );
      const row = failed.rows[0];
      if (!row) throw new Error('manual SVG Telegram send failure returned no row');
      await auditService.record(tx, {
        event: 'cnc.manual_svg_upload.telegram_send_failed',
        entityType: 'cnc_manual_svg_telegram_send_request',
        entityId: input.requestId,
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username ?? null,
        actorRole: input.currentUser.role ?? null,
        requestId: input.requestTraceId,
        source: SOURCE,
        before: { status: 'processing' },
        after: { status: 'failed' },
        diff: { status: { from: 'processing', to: 'failed' } },
        metadata: { packetId: row.packet_id, error: input.error },
      });
      return mapManualSvgTelegramSendResponse(row);
    });
  }

  async completeRestore(input: {
    requestId: string;
    media: CncTelegramMediaRestoreCompleteDto;
    currentUser: CurrentUser;
    requestTraceId: string;
    sessionLease: CncTelegramWorkerSessionLeaseContext;
  }): Promise<CncTelegramMediaRestoreResponseDto> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.sessionLease);
      const locked = await tx.query<RestoreStateRow>(
        `SELECT request.restore_request_id, request.packet_id, request.status,
                request.requested_at, request.available_until,
                packet.source_chat_id, packet.source_message_id, packet.sheet_image_storage_key,
                request.lease_token, request.lease_generation, request.lease_worker_instance_id,
                request.lease_expires_at, (request.lease_expires_at > now()) AS lease_valid
         FROM cnc_telegram_media_restore_requests request
         JOIN cnc_telegram_packets packet ON packet.packet_id=request.packet_id
         WHERE request.restore_request_id=$1::uuid
           AND packet.source_chat_id=$2
         FOR UPDATE OF request, packet`,
        [input.requestId, input.sessionLease.sourceChatId],
      );
      const current = locked.rows[0];
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Запрос восстановления не найден');
      assertItemLeaseIdentity(
        current,
        input.media.itemLeaseToken,
        input.media.itemLeaseGeneration,
        input.media.itemLeaseOwner,
        input.sessionLease.workerInstanceId,
        current.status === 'processing',
      );
      if (current.status === 'completed') return mapRestoreResponse(current);
      if (current.status !== 'processing') {
        throw new ApiError(409, 'CONFLICT', 'Запрос восстановления не находится в обработке');
      }
      if (!sameStorageIdentity(current.sheet_image_storage_key, input.media.storageKey)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Восстановлен неожиданный media key', {
          field: 'storageKey',
        });
      }

      await tx.query(
        `UPDATE cnc_telegram_packets
         SET sheet_image_storage_key=$2,
             sheet_image_content_type=$3,
             sheet_image_size_bytes=$4::bigint
         WHERE packet_id=$1::uuid`,
        [current.packet_id, input.media.storageKey, input.media.contentType, input.media.sizeBytes],
      );
      const completed = await tx.query<RestoreRow>(
        `UPDATE cnc_telegram_media_restore_requests
         SET status='completed', finished_at=now(), available_until=now() + ${ORIGINAL_RETENTION_SQL},
             last_error=NULL, updated_at=now()
         WHERE restore_request_id=$1::uuid
         RETURNING restore_request_id, packet_id, status, requested_at, available_until`,
        [input.requestId],
      );
      const row = completed.rows[0];
      if (!row) throw new Error('restore completion returned no row');
      await auditService.record(tx, {
        event: 'cnc.telegram_media.restore_completed',
        entityType: 'cnc_telegram_media_restore_request',
        entityId: input.requestId,
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username ?? null,
        actorRole: input.currentUser.role ?? null,
        requestId: input.requestTraceId,
        source: SOURCE,
        before: { status: 'processing' },
        after: { status: 'completed', availableUntil: toIso(row.available_until) },
        diff: { status: { from: 'processing', to: 'completed' } },
        metadata: { packetId: current.packet_id, sizeBytes: input.media.sizeBytes },
      });
      return mapRestoreResponse(row);
    });
  }

  async failRestore(input: {
    requestId: string;
    error: string;
    currentUser: CurrentUser;
    requestTraceId: string;
    sessionLease: CncTelegramWorkerSessionLeaseContext;
    leaseToken: string;
    leaseGeneration: number;
    leaseOwner: string;
  }): Promise<CncTelegramMediaRestoreResponseDto> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.sessionLease);
      const locked = await tx.query<RestoreRow>(
        `SELECT request.restore_request_id, request.packet_id, request.status, request.requested_at, request.available_until,
                request.lease_token, request.lease_generation, request.lease_worker_instance_id,
                request.lease_expires_at, (request.lease_expires_at > now()) AS lease_valid
         FROM cnc_telegram_media_restore_requests request
         JOIN cnc_telegram_packets packet ON packet.packet_id=request.packet_id
         WHERE request.restore_request_id=$1::uuid
           AND packet.source_chat_id=$2
           FOR UPDATE OF request`,
        [input.requestId, input.sessionLease.sourceChatId],
      );
      const current = locked.rows[0];
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Запрос восстановления не найден');
      assertItemLeaseIdentity(
        current,
        input.leaseToken,
        input.leaseGeneration,
        input.leaseOwner,
        input.sessionLease.workerInstanceId,
        current.status === 'processing',
      );
      if (current.status === 'failed') return mapRestoreResponse(current);
      if (current.status !== 'processing') {
        throw new ApiError(409, 'CONFLICT', 'Запрос восстановления не находится в обработке');
      }
      const failed = await tx.query<RestoreRow>(
        `UPDATE cnc_telegram_media_restore_requests
         SET status='failed', finished_at=now(), available_until=NULL,
             last_error=$2, updated_at=now()
         WHERE restore_request_id=$1::uuid
         RETURNING restore_request_id, packet_id, status, requested_at, available_until`,
        [input.requestId, input.error],
      );
      const row = failed.rows[0];
      if (!row) throw new Error('restore failure returned no row');
      await auditService.record(tx, {
        event: 'cnc.telegram_media.restore_failed',
        entityType: 'cnc_telegram_media_restore_request',
        entityId: input.requestId,
        actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username ?? null,
        actorRole: input.currentUser.role ?? null,
        requestId: input.requestTraceId,
        source: SOURCE,
        before: { status: 'processing' },
        after: { status: 'failed' },
        diff: { status: { from: 'processing', to: 'failed' } },
        metadata: { packetId: current.packet_id, error: input.error },
      });
      return mapRestoreResponse(row);
    });
  }
}

function manualSvgOrderFilesSql(extraWhere: string, extraSelect = ''): string {
  return `
    SELECT ${extraSelect}
           f.file_id, f.packet_id, f.file_kind, f.original_file_name, f.content_type,
           f.content_sha256, f.size_bytes, f.generated, f.created_at, f.expires_at,
           p.svg_cut_job_id, svg_job.source_display_number AS svg_cut_job_display_number,
           p.svg_cut_result_id, svg_result.result_no AS svg_cut_result_no,
           send.status AS telegram_send_status
    FROM cnc_manual_svg_upload_file_orders link
    JOIN cnc_manual_svg_upload_files f ON f.file_id=link.file_id
    JOIN cnc_telegram_packets p ON p.packet_id=f.packet_id
    LEFT JOIN cut_job svg_job ON svg_job.cut_job_id=p.svg_cut_job_id
    LEFT JOIN cut_result svg_result ON svg_result.cut_result_id=p.svg_cut_result_id
    LEFT JOIN LATERAL (
      SELECT request.status
      FROM cnc_manual_svg_telegram_send_requests request
      JOIN cnc_manual_svg_telegram_send_request_files request_file
        ON request_file.request_id=request.request_id
       AND request_file.file_id=f.file_id
      ORDER BY request.requested_at DESC, request.request_id DESC
      LIMIT 1
    ) send ON true
    WHERE link.order_id=$1::bigint
      ${extraWhere}
    ORDER BY f.created_at DESC,
             CASE f.file_kind WHEN 'svg' THEN 1 WHEN 'gcode' THEN 2 ELSE 3 END,
             f.file_id
  `;
}

async function markStaleManualSvgTelegramSendsUnknown(
  tx: TransactionClient,
  input: {
    currentUser: CurrentUser;
    requestTraceId: string;
    sessionLease: CncTelegramWorkerSessionLeaseContext;
  },
): Promise<void> {
  const staleProcessing = await tx.query<ManualSvgTelegramSendUnknownRow>(
    `UPDATE cnc_manual_svg_telegram_send_requests AS request
     SET status='unknown',
         finished_at=now(),
         last_error='Статус отправки неизвестен: воркер не завершил запрос после отправки/начала отправки',
         updated_at=now()
     WHERE request.destination_chat_id=$1
       AND request.status='processing'
       AND claimed_at < now() - ${MANUAL_SVG_SEND_UNKNOWN_AFTER_SQL}
     RETURNING request.request_id, request.packet_id, 'processing'::text AS previous_status, request.claimed_at AS state_at, request.attempt_count, request.last_error`,
    [input.sessionLease.sourceChatId],
  );
  await writeManualSvgTelegramSendUnknownAudits(tx, input, staleProcessing.rows);

  const stalePendingWithoutFiles = await tx.query<ManualSvgTelegramSendUnknownRow>(
    `UPDATE cnc_manual_svg_telegram_send_requests request
     SET status='unknown',
         claimed_at=COALESCE(claimed_at, now()),
         attempt_count=GREATEST(attempt_count, 1),
         finished_at=now(),
         sent_chat_id=NULL,
         sent_message_ids_json='[]'::jsonb,
         last_error='Статус отправки неизвестен: в заявке нет доступных файлов для отправки в Telegram',
         updated_at=now()
     WHERE request.destination_chat_id=$1
       AND request.status='pending'
       AND request.requested_at < now() - ${MANUAL_SVG_SEND_UNKNOWN_AFTER_SQL}
       AND NOT EXISTS (
         SELECT 1
         FROM cnc_manual_svg_telegram_send_request_files request_file
         JOIN cnc_manual_svg_upload_files file ON file.file_id=request_file.file_id
         WHERE request_file.request_id=request.request_id
           AND file.expires_at > now()
       )
     RETURNING request.request_id, request.packet_id, 'pending'::text AS previous_status, request.requested_at AS state_at, request.attempt_count, request.last_error`,
    [input.sessionLease.sourceChatId],
  );
  await writeManualSvgTelegramSendUnknownAudits(tx, input, stalePendingWithoutFiles.rows);
}

async function writeManualSvgTelegramSendUnknownAudits(
  tx: TransactionClient,
  input: {
    currentUser: CurrentUser;
    requestTraceId: string;
  },
  rows: ManualSvgTelegramSendUnknownRow[],
): Promise<void> {
  for (const row of rows) {
    await auditService.record(tx, {
      event: 'cnc.manual_svg_upload.telegram_send_unknown',
      entityType: 'cnc_manual_svg_telegram_send_request',
      entityId: row.request_id,
      actorUserId: input.currentUser.id,
      actorUsername: input.currentUser.username ?? null,
      actorRole: input.currentUser.role ?? null,
      requestId: input.requestTraceId,
      source: SOURCE,
      before: { status: row.previous_status },
      after: { status: 'unknown' },
      diff: { status: { from: row.previous_status, to: 'unknown' } },
      metadata: {
        packetId: row.packet_id,
        previousStatus: row.previous_status,
        stateAt: row.state_at ? toIso(row.state_at) : null,
        attemptCount: Number(row.attempt_count),
        error: row.last_error,
      },
    });
  }
}

async function lockManualSvgTelegramSend(
  tx: TransactionClient,
  requestId: string,
  destinationChatId: string,
): Promise<ManualSvgTelegramSendRow> {
  const result = await tx.query<ManualSvgTelegramSendRow>(
    `SELECT request.request_id, request.packet_id, request.destination_chat_id, request.status, request.requested_at, request.finished_at,
            request.sent_chat_id, request.sent_message_ids_json, request.last_error,
            request.lease_token, request.lease_generation, request.lease_worker_instance_id,
            request.lease_expires_at, (request.lease_expires_at > now()) AS lease_valid
     FROM cnc_manual_svg_telegram_send_requests request
     WHERE request.request_id=$1::uuid
       AND request.destination_chat_id=$2
     FOR UPDATE OF request`,
    [requestId, destinationChatId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Запрос отправки SVG-файлов не найден');
  return row;
}

function assertItemLeaseIdentity(
  row: {
    lease_token?: string | null;
    lease_generation?: string | number | null;
    lease_worker_instance_id?: string | null;
    lease_valid?: boolean;
  },
  leaseToken: string,
  leaseGeneration: number,
  leaseOwner: string,
  sessionWorkerInstanceId: string,
  requireUnexpired: boolean,
): void {
  if (!row.lease_token || row.lease_token !== leaseToken
    || Number(row.lease_generation) !== leaseGeneration
    || row.lease_worker_instance_id !== leaseOwner
    || leaseOwner !== sessionWorkerInstanceId
    || (requireUnexpired && row.lease_valid !== true)) {
    throw new ApiError(409, 'CNC_TELEGRAM_ITEM_LEASE_STALE', 'Worker item lease is stale, expired, or owned by another worker');
  }
}

function screenshotSelectSql(extraWhere: string): string {
  return `
    WITH unique_order_keys AS (
      SELECT lower(trim(order_row.order_name)) AS order_key,
             MIN(order_row.order_id)::bigint AS order_id
      FROM orders order_row
      WHERE order_row.delete_flag=false
        AND NULLIF(trim(order_row.order_name), '') IS NOT NULL
      GROUP BY lower(trim(order_row.order_name))
      HAVING COUNT(*)=1
    ), matched_packets AS (
      SELECT packet.packet_id,
             COUNT(DISTINCT item.source_item_key)::integer AS matched_detail_count,
             SUM(GREATEST(item.quantity, 0))::integer AS item_quantity_total
      FROM cnc_telegram_packets packet
      JOIN cnc_telegram_packet_items item ON item.packet_id=packet.packet_id
      LEFT JOIN unique_order_keys order_key ON order_key.order_key=lower(trim(item.order_name))
      WHERE COALESCE(item.match_order_id, order_key.order_id)=$1::bigint
      GROUP BY packet.packet_id
    )
    SELECT
           CASE
             WHEN p.sheet_image_storage_key IS NOT NULL AND p.source_message_id IS NOT NULL
               THEN 'telegram'
             ELSE 'svg_cut'
           END AS kind,
           p.packet_id, p.source_message_id, COALESCE(p.source_created_at, p.created_at) AS source_created_at,
           p.program_name, p.material_name,
           p.sheet_image_storage_key, p.sheet_image_content_type, p.sheet_image_size_bytes,
           matched.matched_detail_count, matched.item_quantity_total,
           p.svg_cut_job_id, svg_job.source_display_number AS svg_cut_job_display_number,
           svg_result.result_no AS svg_cut_result_no,
           svg_sheet.cut_group_id AS svg_cut_group_id,
           svg_sheet.sheet_index AS svg_cut_sheet_index,
           svg_sheet.sheet_ordinal AS svg_cut_sheet_number,
           svg_sheet.variant AS svg_cut_variant,
           CASE
             WHEN p.sheet_image_storage_key IS NOT NULL AND p.source_message_id IS NOT NULL THEN (
               COALESCE(p.source_created_at, p.created_at) + ${ORIGINAL_RETENTION_SQL} > now()
               OR (restore.status='completed' AND restore.available_until > now())
             )
             ELSE true
           END AS original_available,
           CASE
             WHEN p.sheet_image_storage_key IS NOT NULL AND p.source_message_id IS NOT NULL THEN GREATEST(
               COALESCE(p.source_created_at, p.created_at) + ${ORIGINAL_RETENTION_SQL},
               COALESCE(restore.available_until, '-infinity'::timestamptz)
             )
             ELSE COALESCE(p.source_created_at, p.created_at) + interval '100 years'
           END AS available_until,
           restore.restore_request_id, restore.status AS restore_status,
           restore.requested_at AS restore_requested_at, restore.last_error AS restore_error
    FROM matched_packets matched
    JOIN cnc_telegram_packets p ON p.packet_id=matched.packet_id
    LEFT JOIN cut_job svg_job ON svg_job.cut_job_id=p.svg_cut_job_id
    LEFT JOIN cut_result svg_result ON svg_result.cut_result_id=p.svg_cut_result_id
    LEFT JOIN LATERAL (
      SELECT sheet.cut_group_id, sheet.sheet_index, sheet.sheet_ordinal, sheet.variant
      FROM cut_result_sheet_map sheet
      WHERE sheet.cut_result_id=p.svg_cut_result_id
        AND sheet.is_effective=true
      ORDER BY sheet.sheet_ordinal, sheet.cut_group_id, sheet.sheet_index
      LIMIT 1
    ) svg_sheet ON true
    LEFT JOIN LATERAL (
      SELECT request.restore_request_id, request.status, request.requested_at,
             request.available_until, request.last_error
      FROM cnc_telegram_media_restore_requests request
      WHERE request.packet_id=p.packet_id
      ORDER BY request.requested_at DESC, request.restore_request_id DESC
      LIMIT 1
    ) restore ON true
    WHERE (
        (
          p.sheet_image_storage_key IS NOT NULL
          AND p.source_message_id IS NOT NULL
          AND COALESCE(p.source_created_at, p.created_at) IS NOT NULL
        )
        OR (
          p.svg_cut_import_status='imported'
          AND p.svg_cut_job_id IS NOT NULL
          AND p.svg_cut_result_id IS NOT NULL
          AND svg_result.result_no IS NOT NULL
          AND svg_sheet.cut_group_id IS NOT NULL
          AND COALESCE(p.source_created_at, p.created_at) IS NOT NULL
        )
      )
      ${extraWhere}
    ORDER BY COALESCE(p.source_created_at, p.created_at) DESC, p.source_message_id DESC NULLS LAST, p.packet_id
  `;
}

function mapManualSvgOrderFileRow(
  row: ManualSvgOrderFileRow,
  orderId: number,
): CncTelegramManualSvgOrderFileDto {
  return {
    fileId: row.file_id,
    packetId: row.packet_id,
    kind: row.file_kind,
    fileName: row.original_file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.content_sha256,
    generated: row.generated === true,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    downloadUrl: `/api/v1/cnc-telegram/orders/${orderId}/manual-svg-files/${row.file_id}`,
    cutJobId: nullableNumber(row.svg_cut_job_id),
    cutJobDisplayNumber: nullableDisplayNumber(row.svg_cut_job_id, row.svg_cut_job_display_number),
    cutResultId: nullableNumber(row.svg_cut_result_id),
    cutResultNo: nullableNumber(row.svg_cut_result_no),
    telegramSendStatus: row.telegram_send_status ?? null,
  };
}

function mapScreenshotRow(row: ScreenshotRow, orderId: number): CncTelegramOrderScreenshotDto {
  const packetId = row.packet_id;
  const kind = row.kind === 'svg_cut' ? 'svg_cut' : 'telegram';
  return {
    kind,
    packetId,
    sourceMessageId: row.source_message_id === null ? null : Number(row.source_message_id),
    sourceCreatedAt: toIso(row.source_created_at),
    programName: row.program_name,
    materialName: row.material_name,
    matchedDetailCount: Number(row.matched_detail_count),
    itemQuantityTotal: Number(row.item_quantity_total),
    previewUrl: kind === 'telegram'
      ? `/api/v1/cnc-telegram/orders/${orderId}/screenshots/${packetId}/preview`
      : null,
    imageUrl: kind === 'telegram'
      ? `/api/v1/cnc-telegram/orders/${orderId}/screenshots/${packetId}/image`
      : null,
    cutJobId: nullableNumber(row.svg_cut_job_id),
    cutJobDisplayNumber: nullableDisplayNumber(row.svg_cut_job_id, row.svg_cut_job_display_number),
    cutResultNo: nullableNumber(row.svg_cut_result_no),
    cutGroupId: nullableNumber(row.svg_cut_group_id),
    sheetIndex: nullableNumber(row.svg_cut_sheet_index),
    sheetNumber: nullableNumber(row.svg_cut_sheet_number),
    variant: row.svg_cut_variant === 'manual' ? 'manual' : row.svg_cut_variant === 'auto' ? 'auto' : null,
    originalAvailable: row.original_available === true,
    availableUntil: toIso(row.available_until),
    restore: kind === 'telegram' && row.restore_request_id && row.restore_status && row.restore_requested_at
      ? {
          requestId: row.restore_request_id,
          status: row.restore_status,
          requestedAt: toIso(row.restore_requested_at),
          error: row.restore_error,
        }
      : null,
  };
}

function mapManualSvgTelegramSendTaskRow(
  row: ManualSvgTelegramSendTaskRow,
): CncTelegramManualSvgTelegramSendClaimResponseDto['tasks'][number] {
  return {
    requestId: row.request_id,
    packetId: row.packet_id,
    destinationChatId: row.destination_chat_id,
    cutJobId: Number(row.cut_job_id),
    cutJobDisplayNumber: String(row.cut_job_display_number).trim(),
    messageText: row.message_text,
    attempt: Number(row.attempt_count),
    itemLeaseToken: row.lease_token,
    itemLeaseGeneration: Number(row.lease_generation),
    itemLeaseOwner: row.lease_worker_instance_id,
    files: parseManualSvgTelegramSendFiles(row.files_json),
    ...(row.observation_binding_version === 1 ? { observationBindingVersion: 1 as const } : {}),
  };
}

interface ManualSvgObservationClaimSnapshot {
  requestedFileCount: number;
  filesQualified: boolean;
  filesSnapshot: Array<{ fileId: string; kind: 'svg'|'gcode'|'screenshot'; sha256: string;
    sizeBytes: number; contentType: string; sendOrder: number }>;
  sourceEligible: boolean;
  sourceFence: Record<string, unknown>;
  ineligibleReason: 'FILES_INCOMPLETE'|'SOURCE_UNACCEPTED'|'SOURCE_CONTEXT_INVALID'|'SOURCE_NOT_MDF'|null;
}

function buildManualSvgObservationClaimSnapshot(
  row: ManualSvgTelegramSendTaskRow,
): ManualSvgObservationClaimSnapshot {
  const requestedFileCount = Number(row.requested_file_count);
  const rawFiles = Array.isArray(row.files_json) ? row.files_json : [];
  const filesSnapshot: ManualSvgObservationClaimSnapshot['filesSnapshot'] = [];
  for (const item of rawFiles) {
    if (!item || typeof item !== 'object') continue;
    const file = item as Record<string, unknown>;
    const fileId = typeof file.fileId === 'string' ? file.fileId : '';
    const kind = file.kind;
    const sha256 = typeof file.sha256 === 'string' ? file.sha256.toLowerCase() : '';
    const sizeBytes = Number(file.sizeBytes);
    const contentType = typeof file.contentType === 'string' ? file.contentType : '';
    const sendOrder = Number(file.sendOrder);
    if (!fileId || (kind !== 'svg' && kind !== 'gcode' && kind !== 'screenshot')
      || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 15728640
      || !contentType || !Number.isSafeInteger(sendOrder) || sendOrder < 1 || sendOrder > 10) continue;
    filesSnapshot.push({ fileId, kind, sha256, sizeBytes, contentType, sendOrder });
  }
  filesSnapshot.sort((a,b) => a.sendOrder-b.sendOrder || a.fileId.localeCompare(b.fileId));
  const rawFileIds = rawFiles.map(item => item && typeof item === 'object' ? (item as Record<string,unknown>).fileId : null);
  const kinds = filesSnapshot.map(file=>file.kind);
  const orders = filesSnapshot.map(file=>file.sendOrder);
  const filesQualified = Number.isSafeInteger(requestedFileCount) && requestedFileCount >= 1 && requestedFileCount <= 3
    && rawFiles.length === requestedFileCount && filesSnapshot.length === requestedFileCount
    && new Set(rawFileIds).size === requestedFileCount && new Set(kinds).size === requestedFileCount
    && new Set(orders).size === requestedFileCount && kinds.includes('svg');

  const membership = parseSnapshotRows(row.membership_json);
  const demand = parseSnapshotRows(row.demand_json);
  const receivedRevisionKey = nullableSnapshotString(row.received_revision_key);
  const acceptedRevisionKey = nullableSnapshotString(row.accepted_revision_key);
  const packetSourceVersion = nullableSnapshotString(row.packet_source_version);
  const sourceHeadVersion = nullableSnapshotString(row.source_head_version);
  const sourceCorrectionEpoch = nullableSnapshotString(row.source_correction_epoch);
  const membershipDigest = membership.length ? hashJson(membership) : null;
  const demandDigest = demand.length ? hashJson(demand) : null;
  const sourceFence = {
    packetSourceVersion,
    receivedRevisionKey,
    acceptedRevisionKey,
    headVersion: sourceHeadVersion,
    correctionEpoch: sourceCorrectionEpoch,
    membershipDigest,
    demandDigest,
    compositionComplete: row.source_composition_complete === true,
    sealed: row.source_context_sealed === true,
  };
  const acceptedHeadValid = Boolean(acceptedRevisionKey && acceptedRevisionKey === receivedRevisionKey
    && isPositiveDecimal(packetSourceVersion) && isPositiveDecimal(sourceHeadVersion)
    && isDecimal(sourceCorrectionEpoch));
  const sourceEligible = row.packet_source_chat_id === 'erp-manual-svg-upload' && acceptedHeadValid
    && row.source_context_sealed === true && row.source_composition_complete === true
    && membership.length > 0 && membership.length <= 5000 && demand.length > 0 && demand.length <= 5000;
  const ineligibleReason = !filesQualified ? 'FILES_INCOMPLETE'
    : row.packet_source_chat_id !== 'erp-manual-svg-upload' ? 'SOURCE_NOT_MDF'
      : !acceptedHeadValid ? 'SOURCE_UNACCEPTED'
        : !sourceEligible ? 'SOURCE_CONTEXT_INVALID' : null;
  return { requestedFileCount: Number.isSafeInteger(requestedFileCount) ? requestedFileCount : 0,
    filesQualified, filesSnapshot, sourceEligible, sourceFence, ineligibleReason };
}

function parseSnapshotRows(value: unknown): unknown[][] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  return Array.isArray(parsed) && parsed.every(Array.isArray) ? parsed as unknown[][] : [];
}

function parseSnapshotObjects(value: unknown): Record<string, unknown>[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  return Array.isArray(parsed) && parsed.every(item => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    ? parsed as Record<string, unknown>[] : [];
}

function nullableSnapshotString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isPositiveDecimal(value: string | null): boolean { return Boolean(value && /^[1-9]\d*$/.test(value)); }
function isDecimal(value: string | null): boolean { return Boolean(value && /^(0|[1-9]\d*)$/.test(value)); }

function parseManualSvgTelegramSendFiles(value: unknown): CncTelegramManualSvgTelegramSendClaimResponseDto['tasks'][number]['files'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const kind = row.kind;
    if (kind !== 'svg' && kind !== 'gcode' && kind !== 'screenshot') return [];
    const fileId = stringValue(row.fileId);
    const fileName = stringValue(row.fileName);
    const contentType = stringValue(row.contentType);
    const sha256 = stringValue(row.sha256);
    const base64Content = stringValue(row.base64Content);
    const sizeBytes = row.sizeBytes === null || row.sizeBytes === undefined ? NaN : Number(row.sizeBytes);
    if (!fileId || !fileName || !contentType || !sha256 || !base64Content || !Number.isFinite(sizeBytes)) return [];
    return [{
      fileId,
      kind,
      fileName,
      contentType,
      sizeBytes,
      sha256,
      base64Content,
    }];
  });
}

function mapManualSvgTelegramSendResponse(
  row: ManualSvgTelegramSendRow,
): CncTelegramManualSvgTelegramSendResponseDto {
  return {
    requestId: row.request_id,
    packetId: row.packet_id,
    status: row.status,
    requestedAt: toIso(row.requested_at),
    finishedAt: row.finished_at ? toIso(row.finished_at) : null,
    sentChatId: row.sent_chat_id,
    sentMessageIds: stringArray(row.sent_message_ids_json),
    error: row.last_error,
  };
}

async function readManualSvgObservationClaimSnapshot(
  tx: TransactionClient,
  requestId: string,
  leaseGeneration: number,
): Promise<ManualSvgObservationClaimSnapshotRow | null> {
  return (await tx.query<ManualSvgObservationClaimSnapshotRow>(`SELECT send_request_id::text send_request_id,
    lease_generation::text lease_generation,worker_instance_id::text worker_instance_id,
    session_generation::text session_generation,lease_token_hash,packet_id::text packet_id,
    destination_chat_id,requested_file_count,files_qualified,files_snapshot,source_eligible,source_fence,ineligible_reason
    FROM cnc_manual_svg_observation_claim_snapshots WHERE send_request_id=$1::uuid AND lease_generation=$2::bigint`,
  [requestId,leaseGeneration])).rows[0] ?? null;
}

function manualSvgSendCompletionDigest(completion: CncTelegramManualSvgTelegramSendCompleteDto): string {
  const sentFiles = completion.sentFiles?.map(file => ({ ...file,
    sourceSha256: file.sourceSha256.toLowerCase(),mediaSha256:file.mediaSha256.toLowerCase() })) ?? null;
  return createHash('sha256').update(JSON.stringify({ sentChatId: completion.sentChatId,
    sentMessageIds: completion.sentMessageIds,sentFiles,observationBindingError:completion.observationBindingError ?? null })).digest('hex');
}

function classifyManualSvgSentBindings(
  snapshot: ManualSvgObservationClaimSnapshotRow,
  completion: CncTelegramManualSvgTelegramSendCompleteDto,
): { valid: boolean; reason: string | null; sentFiles: CncTelegramManualSvgTelegramSendCompleteDto['sentFiles'] } {
  if (completion.observationBindingError) return { valid:false,reason:'MEDIA_VERIFICATION_FAILED',sentFiles:undefined };
  if (!completion.sentFiles) return { valid:false,reason:'SENT_BINDING_MISSING',sentFiles:undefined };
  if (snapshot.destination_chat_id !== completion.sentChatId) return { valid:false,reason:'SENT_BINDING_INVALID',sentFiles:undefined };
  const files = parseSnapshotObjects(snapshot.files_snapshot);
  const expected: Array<{fileId:string;kind:string;sha256:string;sendOrder:number}> = [];
  for (const item of files) {
    const row=item;
    if (typeof row.fileId==='string' && typeof row.kind==='string' && typeof row.sha256==='string'
      && Number.isSafeInteger(Number(row.sendOrder))) expected.push({fileId:row.fileId,kind:row.kind,
        sha256:row.sha256.toLowerCase(),sendOrder:Number(row.sendOrder)});
  }
  if (!snapshot.files_qualified || expected.length !== Number(snapshot.requested_file_count)
    || completion.sentFiles.length !== expected.length || !expected.some(file=>file.kind==='svg')) {
    return { valid:false,reason:'FILES_INCOMPLETE',sentFiles:undefined };
  }
  const sentById=new Map(completion.sentFiles.map(file=>[file.fileId,file]));
  if (sentById.size!==expected.length || expected.some(file=>!sentById.has(file.fileId))) {
    return { valid:false,reason:'SENT_BINDING_INVALID',sentFiles:undefined };
  }
  for (const file of expected) {
    const sent=sentById.get(file.fileId)!;
    if (sent.sourceSha256.toLowerCase()!==file.sha256 || !completion.sentMessageIds.includes(sent.messageId)
      || (file.kind!=='screenshot' && sent.mediaSha256.toLowerCase()!==file.sha256)) {
      return { valid:false,reason:'SENT_BINDING_INVALID',sentFiles:undefined };
    }
  }
  const sorted=expected.sort((a,b)=>a.sendOrder-b.sendOrder).map(file=>sentById.get(file.fileId)!);
  return { valid:true,reason:null,sentFiles:sorted };
}

function mapRestoreResponse(row: RestoreRow): CncTelegramMediaRestoreResponseDto {
  return {
    requestId: row.restore_request_id,
    packetId: row.packet_id,
    status: row.status,
    requestedAt: toIso(row.requested_at),
    availableUntil: row.available_until ? toIso(row.available_until) : null,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function sameStorageIdentity(currentKey: string, restoredKey: string): boolean {
  const currentIdentity = storageIdentity(currentKey);
  const restoredIdentity = storageIdentity(restoredKey);
  return currentIdentity !== null && restoredIdentity !== null && currentIdentity === restoredIdentity;
}

function storageIdentity(storageKey: string): string | null {
  const extension = extname(storageKey).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) return null;
  return storageKey.slice(0, -extension.length);
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function nullableDisplayNumber(
  cutJobId: string | number | null,
  sourceDisplayNumber: string | number | null,
): string | null {
  const normalized = sourceDisplayNumber == null ? '' : String(sourceDisplayNumber).trim();
  if (normalized) return normalized;
  const fallbackCutJobId = nullableNumber(cutJobId);
  return fallbackCutJobId === null ? null : String(fallbackCutJobId);
}

function toIso(value: string | Date | null): string {
  if (value === null) throw new Error('expected timestamp');
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
