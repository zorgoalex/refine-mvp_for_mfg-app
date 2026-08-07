import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type {
  WorkerAuditBatchDto,
  WorkerAuditExportQueryDto,
  WorkerAuditListQueryDto,
} from '../dto/cnc-telegram-worker-audit.dto';

type Writer = { id: string };
const MAX_DETAILED_EXPORT_ROWS = 50_000;

export interface WorkerAuditDetailedExportData {
  scans: Record<string, unknown>[];
  messages: Record<string, unknown>[];
}

export class PgCncTelegramWorkerAuditRepository {
  constructor(private readonly database: DatabaseService) {}

  async capabilities(): Promise<boolean> {
    const result = await this.database.query<{ ready: boolean }>(`
      WITH expected_schema(table_name, column_names, column_hash, constraint_names, constraint_hash, index_names, index_hash) AS (VALUES
        ('cnc_telegram_worker_scans',
         'scan_id,source_chat_id,workday,status,started_at,finished_at,session_user_id,day_yielded_count,day_exhausted,day_truncated,day_error_code,reply_search_yielded_count,reply_search_exhausted,reply_search_truncated,reply_search_error_code,svg_count,processed_count,ingested_count,skipped_count,failed_count,parser_version,worker_version,can_write_chat,error_code,error_message,writer_user_id,created_at,updated_at',
         '93fcf901a0f61b530dda86ed932a153d',
         'chk_cnc_tg_worker_scan_counts,chk_cnc_tg_worker_scan_error_lengths,chk_cnc_tg_worker_scan_reason_codes,chk_cnc_tg_worker_scan_status,cnc_telegram_worker_scans_pkey,cnc_telegram_worker_scans_writer_user_id_fkey',
         '1c8b631a35406a8a1c92c4a88b309b61',
         'cnc_telegram_worker_scans_pkey,idx_cnc_tg_worker_scans_started,idx_cnc_tg_worker_scans_status_started',
         '30c7dde7036a5db58f8801eb18dd8561'),
        ('cnc_telegram_worker_message_logs',
         'log_id,log_key,raw_source_digest,sanitizer_version,source_chat_id,source_message_id,source_thread_id,reply_to_message_id,sender_user_id,source_created_at,source_edited_at,workday,message_type,filename,mime_type,message_text,outgoing,status,reason_code,reason_message,error_code,error_message,related_source_message_id,external_packet_key,source_version,packet_id,cut_job_id,cut_result_no,cutting_sequence_no,backend_applied,backend_stale,ever_ingested,first_observed_at,last_observed_at,last_decision_at,last_scan_id,observed_count,attempt_count,created_at,updated_at',
         '0c9340f3c3b800a68c4119d19b46d181',
         'chk_cnc_tg_worker_message_bounds,chk_cnc_tg_worker_message_reason_codes,chk_cnc_tg_worker_message_status,chk_cnc_tg_worker_message_type,cnc_telegram_worker_message_logs_last_scan_id_fkey,cnc_telegram_worker_message_logs_log_key_key,cnc_telegram_worker_message_logs_pkey',
         '29cd6d96f1102fb3a7b96c6717ac2c42',
         'cnc_telegram_worker_message_logs_log_key_key,cnc_telegram_worker_message_logs_pkey,idx_cnc_tg_worker_messages_reason,idx_cnc_tg_worker_messages_search,idx_cnc_tg_worker_messages_source,idx_cnc_tg_worker_messages_status,idx_cnc_tg_worker_messages_type,idx_cnc_tg_worker_messages_workday',
         'b89261e2356a3cd1967d5c07e9b34ceb'),
        ('cnc_telegram_worker_operations',
         'operation_id,operation_key,scan_id,log_id,operation_type,status,planned_at,finished_at,reason_code,reason_message,error_code,error_message,external_packet_key,source_version,packet_id,cut_job_id,cut_result_no,cutting_sequence_no,backend_applied,backend_stale,reply_text,reply_to_message_id,session_sender_user_id,sent_telegram_message_id,reconciliation_yielded_count,reconciliation_exhausted,reconciliation_truncated,reconciliation_error_code,reconciliation_window_from,reconciliation_window_to,steps_json,responses_json,created_at,updated_at',
         '460b3edcaee829bdfa87ba1564512179',
         'chk_cnc_tg_worker_operation_arrays,chk_cnc_tg_worker_operation_bounds,chk_cnc_tg_worker_operation_reason_codes,chk_cnc_tg_worker_operation_status,chk_cnc_tg_worker_operation_type,cnc_telegram_worker_operations_log_id_fkey,cnc_telegram_worker_operations_operation_key_key,cnc_telegram_worker_operations_pkey,cnc_telegram_worker_operations_scan_id_fkey',
         '262509547ad6915b354af482c8b4acf3',
         'cnc_telegram_worker_operations_operation_key_key,cnc_telegram_worker_operations_pkey,idx_cnc_tg_worker_operations_log,idx_cnc_tg_worker_operations_scan,idx_cnc_tg_worker_operations_type_status',
         '6e836ddb93d11c98f68670a6152b1f97'),
        ('cnc_telegram_worker_message_observations',
         'observation_id,scan_id,log_id,operation_id,source_chat_id,source_message_id,observed_at,read_source,read_ordinal,classification_code,decision_code,related_source_message_id',
         'fcb74f33a29709c731b85a97c1653ff7',
         'chk_cnc_tg_worker_observation_classification_code,chk_cnc_tg_worker_observation_ordinal,chk_cnc_tg_worker_observation_owner,chk_cnc_tg_worker_observation_reason_codes,chk_cnc_tg_worker_observation_source,cnc_telegram_worker_message_observations_log_id_fkey,cnc_telegram_worker_message_observations_operation_id_fkey,cnc_telegram_worker_message_observations_pkey,cnc_telegram_worker_message_observations_scan_id_fkey',
         '895074f6f7db44b091b8b1415a8412bb',
         'cnc_telegram_worker_message_observations_pkey,idx_cnc_tg_worker_observations_log,idx_cnc_tg_worker_observations_scan,uq_cnc_tg_worker_observation_operation_ordinal,uq_cnc_tg_worker_observation_scan_ordinal',
         '0a32f1eea571da3ee5b7e372e0f9ce00')
      )
      SELECT COALESCE(bool_and(
        COALESCE((
          SELECT md5(string_agg(
            format('%s|%s|%s|%s|%s', ordinal_position, column_name, data_type, is_nullable, COALESCE(column_default, '∅')),
            ', ' ORDER BY ordinal_position
          )) = expected_schema.column_hash
          FROM information_schema.columns
          WHERE table_schema='public' AND table_name=expected_schema.table_name
            AND column_name=ANY(string_to_array(expected_schema.column_names, ','))
        ), false)
        AND COALESCE((
          SELECT md5(string_agg(
            conname || '|' || contype::text || '|' || confdeltype::text || '|' || pg_get_constraintdef(oid),
            ', ' ORDER BY conname
          )) = expected_schema.constraint_hash
          FROM pg_constraint
          WHERE connamespace='public'::regnamespace
            AND conrelid::regclass::text=expected_schema.table_name
            AND conname=ANY(string_to_array(expected_schema.constraint_names, ','))
        ), false)
        AND COALESCE((
          SELECT md5(string_agg(indexname || '|' || indexdef, ', ' ORDER BY indexname)) = expected_schema.index_hash
          FROM pg_indexes
          WHERE schemaname='public' AND tablename=expected_schema.table_name
            AND indexname=ANY(string_to_array(expected_schema.index_names, ','))
        ), false)
      ), false)
      AND COALESCE(
        md5(pg_get_functiondef(to_regprocedure('cnc_telegram_worker_reason_code_valid(text)')))
          = 'bb6b155edab4b6ebcc5545fe2b9ab3bc',
        false
      ) AS ready
      FROM expected_schema
    `);
    return Boolean(result.rows[0]?.ready);
  }

  async writeBatch(dto: WorkerAuditBatchDto, writer: Writer): Promise<{ accepted: number }> {
    return this.database.transaction(async (client) => {
      await this.upsertScan(client, dto, writer);
      const logIds = new Map<string, string>();
      for (const message of dto.messages) {
        logIds.set(message.logKey, await this.upsertMessage(client, dto.scan.scanId, message));
      }
      const operationIds = new Map<string, string>();
      for (const operation of dto.operations) {
        const logId = logIds.get(operation.logKey);
        if (!logId) throw new ApiError(422, 'AUDIT_LOG_REFERENCE_MISSING', 'Не найдена ссылка сообщения в пакете');
        operationIds.set(operation.operationKey, await this.upsertOperation(client, logId, operation));
      }
      for (const observation of dto.observations) {
        const logId = logIds.get(observation.logKey);
        if (!logId) throw new ApiError(422, 'AUDIT_LOG_REFERENCE_MISSING', 'Не найдена ссылка сообщения в пакете');
        const operationId = observation.operationKey
          ? operationIds.get(observation.operationKey)
          : null;
        if (observation.operationKey && !operationId) {
          throw new ApiError(422, 'AUDIT_OPERATION_REFERENCE_MISSING', 'Не найдена ссылка операции в пакете');
        }
        const inserted = await client.query<{ observation_id: string }>(`
          INSERT INTO cnc_telegram_worker_message_observations (
            scan_id, log_id, operation_id, source_chat_id, source_message_id, observed_at,
            read_source, read_ordinal, classification_code, decision_code, related_source_message_id
          ) VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6, $7, $8, $9, $10, $11::bigint)
          ON CONFLICT DO NOTHING
          RETURNING observation_id
        `, [
          observation.scanId, logId, operationId, observation.sourceChatId, observation.sourceMessageId,
          observation.observedAt, observation.readSource, observation.readOrdinal,
          observation.classificationCode, observation.decisionCode ?? null,
          observation.relatedSourceMessageId ?? null,
        ]);
        if (!inserted.rows[0]) {
          const replay = await client.query<{ observation_id: string }>(`
            SELECT observation_id
              FROM cnc_telegram_worker_message_observations
             WHERE (
               (operation_id IS NULL AND $3::uuid IS NULL AND scan_id=$1::uuid AND read_source=$7 AND read_ordinal=$8)
               OR (operation_id=$3::uuid AND read_source=$7 AND read_ordinal=$8)
             )
               AND log_id=$2::uuid
               AND source_chat_id=$4::bigint
               AND source_message_id=$5::bigint
               AND observed_at=$6
               AND classification_code=$9
               AND decision_code IS NOT DISTINCT FROM $10
               AND related_source_message_id IS NOT DISTINCT FROM $11::bigint
          `, [
            observation.scanId, logId, operationId, observation.sourceChatId, observation.sourceMessageId,
            observation.observedAt, observation.readSource, observation.readOrdinal,
            observation.classificationCode, observation.decisionCode ?? null,
            observation.relatedSourceMessageId ?? null,
          ]);
          if (!replay.rows[0]) {
            throw new ApiError(409, 'AUDIT_OBSERVATION_CONFLICT', 'Конфликт неизменяемого наблюдения журнала');
          }
        } else {
          await client.query(`
            UPDATE cnc_telegram_worker_message_logs
               SET observed_count=(SELECT count(*)::integer FROM cnc_telegram_worker_message_observations WHERE log_id=$1), updated_at=now()
             WHERE log_id=$1
          `, [logId]);
        }
      }
      await client.query(`
        DELETE FROM cnc_telegram_worker_scans WHERE started_at < now() - interval '14 days';
        DELETE FROM cnc_telegram_worker_message_logs m
         WHERE m.last_observed_at < now() - interval '180 days'
           AND NOT EXISTS (SELECT 1 FROM cnc_telegram_worker_message_observations o WHERE o.log_id=m.log_id)
           AND NOT EXISTS (SELECT 1 FROM cnc_telegram_worker_operations p WHERE p.log_id=m.log_id);
      `);
      return { accepted: dto.messages.length + dto.observations.length + dto.operations.length + 1 };
    });
  }

  async list(query: WorkerAuditListQueryDto): Promise<Record<string, unknown>> {
    const { params, where } = buildMessageFilter(query);
    const sortDirection = query.sortDirection === 'asc' ? 'ASC' : 'DESC';
    const countResult = await this.database.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM cnc_telegram_worker_message_logs m WHERE ${where.join(' AND ')}`,
      params,
    );
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await this.database.query<Record<string, unknown>>(`
      SELECT
        m.log_id AS "logId", m.log_key AS "logKey", m.source_chat_id::text AS "sourceChatId",
        m.source_message_id::text AS "sourceMessageId", m.source_thread_id::text AS "sourceThreadId",
        m.reply_to_message_id::text AS "replyToMessageId", m.sender_user_id::text AS "senderUserId",
        m.source_created_at AS "sourceCreatedAt", m.source_edited_at AS "sourceEditedAt",
        m.workday::text AS workday, m.message_type AS "messageType", m.filename, m.mime_type AS "mimeType",
        m.message_text AS "messageText", m.outgoing, m.status, m.reason_code AS "reasonCode",
        m.reason_message AS "reasonMessage", m.error_code AS "errorCode", m.error_message AS "errorMessage",
        m.related_source_message_id::text AS "relatedSourceMessageId", m.external_packet_key AS "externalPacketKey",
        m.source_version::text AS "sourceVersion", m.packet_id AS "packetId", m.cut_job_id::text AS "cutJobId",
        m.cut_result_no AS "cutResultNo", m.cutting_sequence_no AS "cuttingSequenceNo",
        m.backend_applied AS "backendApplied", m.backend_stale AS "backendStale", m.ever_ingested AS "everIngested",
        m.first_observed_at AS "firstObservedAt", m.last_observed_at AS "lastObservedAt",
        m.observed_count AS "observedCount", m.attempt_count AS "attemptCount",
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'scanId', o.scan_id, 'operationId', o.operation_id, 'readSource', o.read_source,
          'readOrdinal', o.read_ordinal, 'observedAt', o.observed_at,
          'classificationCode', o.classification_code, 'decisionCode', o.decision_code,
          'relatedSourceMessageId', o.related_source_message_id::text
        ) ORDER BY o.observed_at, o.read_ordinal)
          FROM cnc_telegram_worker_message_observations o WHERE o.log_id=m.log_id), '[]'::jsonb) AS observations,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'operationId', p.operation_id, 'operationKey', p.operation_key, 'scanId', p.scan_id,
          'operationType', p.operation_type, 'status', p.status, 'plannedAt', p.planned_at,
          'finishedAt', p.finished_at, 'reasonCode', p.reason_code, 'reasonMessage', p.reason_message,
          'errorCode', p.error_code, 'errorMessage', p.error_message,
          'externalPacketKey', p.external_packet_key, 'sourceVersion', p.source_version::text,
          'packetId', p.packet_id,
          'cutJobId', p.cut_job_id::text, 'cutResultNo', p.cut_result_no,
          'cuttingSequenceNo', p.cutting_sequence_no, 'backendApplied', p.backend_applied,
          'backendStale', p.backend_stale,
          'replyText', p.reply_text, 'replyToMessageId', p.reply_to_message_id::text,
          'sessionSenderUserId', p.session_sender_user_id::text,
          'sentTelegramMessageId', p.sent_telegram_message_id::text,
          'reconciliationYieldedCount', p.reconciliation_yielded_count,
          'reconciliationExhausted', p.reconciliation_exhausted,
          'reconciliationTruncated', p.reconciliation_truncated,
          'reconciliationErrorCode', p.reconciliation_error_code,
          'reconciliationWindowFrom', p.reconciliation_window_from,
          'reconciliationWindowTo', p.reconciliation_window_to,
          'steps', p.steps_json, 'responses', p.responses_json
        ) ORDER BY p.planned_at, p.operation_id)
          FROM cnc_telegram_worker_operations p WHERE p.log_id=m.log_id), '[]'::jsonb) AS operations
      FROM cnc_telegram_worker_message_logs m
      WHERE ${where.join(' AND ')}
      ORDER BY m.source_created_at ${sortDirection}, m.source_message_id ${sortDirection}, m.log_id ${sortDirection}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    const scans = await this.database.query<Record<string, unknown>>(`
      SELECT scan_id AS "scanId", source_chat_id::text AS "sourceChatId", workday::text AS workday,
        status, started_at AS "startedAt", finished_at AS "finishedAt", session_user_id::text AS "sessionUserId",
        day_yielded_count AS "dayYieldedCount", day_exhausted AS "dayExhausted",
        day_truncated AS "dayTruncated", day_error_code AS "dayErrorCode",
        reply_search_yielded_count AS "replySearchYieldedCount",
        reply_search_exhausted AS "replySearchExhausted", reply_search_truncated AS "replySearchTruncated",
        reply_search_error_code AS "replySearchErrorCode", svg_count AS "svgCount",
        processed_count AS "processedCount", ingested_count AS "ingestedCount",
        skipped_count AS "skippedCount", failed_count AS "failedCount",
        parser_version AS "parserVersion", worker_version AS "workerVersion",
        can_write_chat AS "canWriteChat", error_code AS "errorCode", error_message AS "errorMessage"
      FROM cnc_telegram_worker_scans
      WHERE workday >= $1::date AND workday <= $2::date
      ORDER BY started_at DESC LIMIT 12
    `, [query.dateFrom, query.dateTo]);
    return {
      data: rows.rows,
      scans: scans.rows,
      pagination: { page: query.page, pageSize: query.pageSize, total: Number(countResult.rows[0]?.total ?? 0) },
    };
  }

  async exportDetailed(query: WorkerAuditExportQueryDto): Promise<WorkerAuditDetailedExportData> {
    const { params, where } = buildMessageFilter(query);
    const messageParams = [...params, MAX_DETAILED_EXPORT_ROWS + 1];
    const messages = await this.database.query<Record<string, unknown>>(`
      SELECT
        m.log_id AS "logId", m.log_key AS "logKey",
        m.raw_source_digest AS "rawSourceDigest", m.sanitizer_version AS "sanitizerVersion",
        m.source_chat_id::text AS "sourceChatId", m.source_message_id::text AS "sourceMessageId",
        m.source_thread_id::text AS "sourceThreadId", m.reply_to_message_id::text AS "replyToMessageId",
        m.sender_user_id::text AS "senderUserId", m.source_created_at AS "sourceCreatedAt",
        m.source_edited_at AS "sourceEditedAt", m.workday::text AS workday,
        m.message_type AS "messageType", m.filename, m.mime_type AS "mimeType",
        m.message_text AS "messageText", m.outgoing, m.status,
        m.reason_code AS "reasonCode", m.reason_message AS "reasonMessage",
        m.error_code AS "errorCode", m.error_message AS "errorMessage",
        m.related_source_message_id::text AS "relatedSourceMessageId",
        m.external_packet_key AS "externalPacketKey", m.source_version::text AS "sourceVersion",
        m.packet_id AS "packetId", m.cut_job_id::text AS "cutJobId",
        m.cut_result_no AS "cutResultNo", m.cutting_sequence_no AS "cuttingSequenceNo",
        m.backend_applied AS "backendApplied", m.backend_stale AS "backendStale",
        m.ever_ingested AS "everIngested", m.first_observed_at AS "firstObservedAt",
        m.last_observed_at AS "lastObservedAt", m.last_decision_at AS "lastDecisionAt",
        m.last_scan_id AS "lastScanId", m.observed_count AS "observedCount",
        m.attempt_count AS "attemptCount", m.created_at AS "createdAt", m.updated_at AS "updatedAt",
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'observationId', o.observation_id, 'scanId', o.scan_id, 'logId', o.log_id,
          'operationId', o.operation_id, 'operationKey', op.operation_key,
          'sourceChatId', o.source_chat_id::text, 'sourceMessageId', o.source_message_id::text,
          'observedAt', o.observed_at, 'readSource', o.read_source, 'readOrdinal', o.read_ordinal,
          'classificationCode', o.classification_code, 'decisionCode', o.decision_code,
          'relatedSourceMessageId', o.related_source_message_id::text
        ) ORDER BY o.observed_at, o.read_ordinal, o.observation_id)
          FROM cnc_telegram_worker_message_observations o
          LEFT JOIN cnc_telegram_worker_operations op ON op.operation_id=o.operation_id
          WHERE o.log_id=m.log_id), '[]'::jsonb) AS observations,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'operationId', p.operation_id, 'operationKey', p.operation_key,
          'scanId', p.scan_id, 'logId', p.log_id,
          'operationType', p.operation_type, 'status', p.status,
          'plannedAt', p.planned_at, 'finishedAt', p.finished_at,
          'reasonCode', p.reason_code, 'reasonMessage', p.reason_message,
          'errorCode', p.error_code, 'errorMessage', p.error_message,
          'externalPacketKey', p.external_packet_key, 'sourceVersion', p.source_version::text,
          'packetId', p.packet_id, 'cutJobId', p.cut_job_id::text,
          'cutResultNo', p.cut_result_no, 'cuttingSequenceNo', p.cutting_sequence_no,
          'backendApplied', p.backend_applied, 'backendStale', p.backend_stale,
          'replyText', p.reply_text, 'replyToMessageId', p.reply_to_message_id::text,
          'sessionSenderUserId', p.session_sender_user_id::text,
          'sentTelegramMessageId', p.sent_telegram_message_id::text,
          'reconciliationYieldedCount', p.reconciliation_yielded_count,
          'reconciliationExhausted', p.reconciliation_exhausted,
          'reconciliationTruncated', p.reconciliation_truncated,
          'reconciliationErrorCode', p.reconciliation_error_code,
          'reconciliationWindowFrom', p.reconciliation_window_from,
          'reconciliationWindowTo', p.reconciliation_window_to,
          'steps', p.steps_json, 'responses', p.responses_json,
          'createdAt', p.created_at, 'updatedAt', p.updated_at
        ) ORDER BY p.planned_at, p.operation_id)
          FROM cnc_telegram_worker_operations p
          WHERE p.log_id=m.log_id), '[]'::jsonb) AS operations
      FROM cnc_telegram_worker_message_logs m
      WHERE ${where.join(' AND ')}
      ORDER BY m.workday, m.source_created_at, m.source_message_id, m.log_id
      LIMIT $${messageParams.length}
    `, messageParams);
    if (messages.rows.length > MAX_DETAILED_EXPORT_ROWS) {
      throw exportTooLarge('сообщений');
    }

    const scans = await this.database.query<Record<string, unknown>>(`
      SELECT
        scan_id AS "scanId", source_chat_id::text AS "sourceChatId", workday::text AS workday,
        status, started_at AS "startedAt", finished_at AS "finishedAt",
        session_user_id::text AS "sessionUserId", day_yielded_count AS "dayYieldedCount",
        day_exhausted AS "dayExhausted", day_truncated AS "dayTruncated",
        day_error_code AS "dayErrorCode", reply_search_yielded_count AS "replySearchYieldedCount",
        reply_search_exhausted AS "replySearchExhausted",
        reply_search_truncated AS "replySearchTruncated",
        reply_search_error_code AS "replySearchErrorCode", svg_count AS "svgCount",
        processed_count AS "processedCount", ingested_count AS "ingestedCount",
        skipped_count AS "skippedCount", failed_count AS "failedCount",
        parser_version AS "parserVersion", worker_version AS "workerVersion",
        can_write_chat AS "canWriteChat", error_code AS "errorCode",
        error_message AS "errorMessage", writer_user_id::text AS "writerUserId",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM cnc_telegram_worker_scans
      WHERE workday >= $1::date AND workday <= $2::date
      ORDER BY workday, started_at, scan_id
      LIMIT $3
    `, [query.dateFrom, query.dateTo, MAX_DETAILED_EXPORT_ROWS + 1]);
    if (scans.rows.length > MAX_DETAILED_EXPORT_ROWS) {
      throw exportTooLarge('сканирований');
    }

    return { scans: scans.rows, messages: messages.rows };
  }

  private async upsertScan(client: TransactionClient, dto: WorkerAuditBatchDto, writer: Writer): Promise<void> {
    const s = dto.scan;
    const result = await client.query<{ scan_id: string }>(`
      INSERT INTO cnc_telegram_worker_scans (
        scan_id, source_chat_id, workday, status, started_at, finished_at, session_user_id,
        day_yielded_count, day_exhausted, day_truncated, day_error_code,
        reply_search_yielded_count, reply_search_exhausted, reply_search_truncated, reply_search_error_code,
        svg_count, processed_count, ingested_count, skipped_count, failed_count,
        parser_version, worker_version, can_write_chat, error_code, error_message, writer_user_id
      ) VALUES ($1,$2::bigint,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::bigint)
      ON CONFLICT (scan_id) DO UPDATE SET
        status=CASE WHEN cnc_telegram_worker_scans.status<>'running' AND EXCLUDED.status='running' THEN cnc_telegram_worker_scans.status ELSE EXCLUDED.status END,
        finished_at=COALESCE(EXCLUDED.finished_at, cnc_telegram_worker_scans.finished_at), session_user_id=EXCLUDED.session_user_id,
        day_yielded_count=GREATEST(cnc_telegram_worker_scans.day_yielded_count, EXCLUDED.day_yielded_count),
        day_exhausted=EXCLUDED.day_exhausted, day_truncated=EXCLUDED.day_truncated, day_error_code=EXCLUDED.day_error_code,
        reply_search_yielded_count=GREATEST(cnc_telegram_worker_scans.reply_search_yielded_count, EXCLUDED.reply_search_yielded_count),
        reply_search_exhausted=EXCLUDED.reply_search_exhausted, reply_search_truncated=EXCLUDED.reply_search_truncated,
        reply_search_error_code=EXCLUDED.reply_search_error_code, svg_count=EXCLUDED.svg_count,
        processed_count=EXCLUDED.processed_count, ingested_count=EXCLUDED.ingested_count,
        skipped_count=EXCLUDED.skipped_count, failed_count=EXCLUDED.failed_count,
        error_code=EXCLUDED.error_code, error_message=EXCLUDED.error_message, updated_at=now()
      WHERE cnc_telegram_worker_scans.source_chat_id=EXCLUDED.source_chat_id
        AND cnc_telegram_worker_scans.workday=EXCLUDED.workday
        AND cnc_telegram_worker_scans.started_at=EXCLUDED.started_at
        AND cnc_telegram_worker_scans.parser_version=EXCLUDED.parser_version
        AND cnc_telegram_worker_scans.worker_version=EXCLUDED.worker_version
        AND cnc_telegram_worker_scans.can_write_chat=EXCLUDED.can_write_chat
        AND cnc_telegram_worker_scans.writer_user_id=EXCLUDED.writer_user_id
        AND cnc_telegram_worker_scans.session_user_id IS NOT DISTINCT FROM EXCLUDED.session_user_id
      RETURNING scan_id
    `, [
      s.scanId, s.sourceChatId, s.workday, s.status, s.startedAt, s.finishedAt ?? null, s.sessionUserId ?? null,
      s.dayYieldedCount, s.dayExhausted, s.dayTruncated, s.dayErrorCode ?? null,
      s.replySearchYieldedCount, s.replySearchExhausted, s.replySearchTruncated, s.replySearchErrorCode ?? null,
      s.svgCount, s.processedCount, s.ingestedCount, s.skippedCount, s.failedCount,
      s.parserVersion, s.workerVersion, s.canWriteChat, s.errorCode ?? null, s.errorMessage ?? null, writer.id,
    ]);
    if (!result.rows[0]) throw new ApiError(409, 'AUDIT_SCAN_CONFLICT', 'Конфликт неизменяемого сканирования журнала');
  }

  private async upsertMessage(client: TransactionClient, scanId: string, m: WorkerAuditBatchDto['messages'][number]): Promise<string> {
    const result = await client.query<{ log_id: string }>(`
      INSERT INTO cnc_telegram_worker_message_logs (
        log_key, raw_source_digest, sanitizer_version, source_chat_id, source_message_id,
        source_thread_id, reply_to_message_id, sender_user_id, source_created_at, source_edited_at,
        workday, message_type, filename, mime_type, message_text, outgoing, status, reason_code,
        reason_message, error_code, error_message, related_source_message_id, external_packet_key,
        source_version, packet_id, cut_job_id, cut_result_no, cutting_sequence_no, backend_applied,
        backend_stale, ever_ingested, first_observed_at, last_observed_at, last_decision_at, last_scan_id,
        observed_count, attempt_count
      ) VALUES ($1,$2,$3,$4::bigint,$5::bigint,$6::bigint,$7::bigint,$8::bigint,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::bigint,$23,$24::bigint,$25,$26::bigint,$27,$28,$29,$30,$31,$32,$32,$33,$34,1,$35)
      ON CONFLICT (log_key) DO UPDATE SET
        last_observed_at=GREATEST(cnc_telegram_worker_message_logs.last_observed_at, EXCLUDED.last_observed_at),
        last_scan_id=EXCLUDED.last_scan_id, observed_count=cnc_telegram_worker_message_logs.observed_count,
        status=CASE WHEN EXCLUDED.status='observed' AND cnc_telegram_worker_message_logs.status<>'observed' THEN cnc_telegram_worker_message_logs.status ELSE EXCLUDED.status END,
        reason_code=CASE
          WHEN EXCLUDED.status='observed' AND cnc_telegram_worker_message_logs.status<>'observed'
          THEN cnc_telegram_worker_message_logs.reason_code
          ELSE COALESCE(EXCLUDED.reason_code, cnc_telegram_worker_message_logs.reason_code)
        END,
        reason_message=CASE
          WHEN EXCLUDED.status='observed' AND cnc_telegram_worker_message_logs.status<>'observed'
          THEN cnc_telegram_worker_message_logs.reason_message
          ELSE COALESCE(EXCLUDED.reason_message, cnc_telegram_worker_message_logs.reason_message)
        END,
        error_code=COALESCE(EXCLUDED.error_code, cnc_telegram_worker_message_logs.error_code),
        error_message=COALESCE(EXCLUDED.error_message, cnc_telegram_worker_message_logs.error_message),
        related_source_message_id=COALESCE(EXCLUDED.related_source_message_id, cnc_telegram_worker_message_logs.related_source_message_id),
        external_packet_key=COALESCE(EXCLUDED.external_packet_key, cnc_telegram_worker_message_logs.external_packet_key),
        source_version=COALESCE(EXCLUDED.source_version, cnc_telegram_worker_message_logs.source_version),
        packet_id=COALESCE(EXCLUDED.packet_id, cnc_telegram_worker_message_logs.packet_id),
        cut_job_id=COALESCE(EXCLUDED.cut_job_id, cnc_telegram_worker_message_logs.cut_job_id),
        cut_result_no=COALESCE(EXCLUDED.cut_result_no, cnc_telegram_worker_message_logs.cut_result_no),
        cutting_sequence_no=COALESCE(EXCLUDED.cutting_sequence_no, cnc_telegram_worker_message_logs.cutting_sequence_no),
        backend_applied=COALESCE(EXCLUDED.backend_applied, cnc_telegram_worker_message_logs.backend_applied),
        backend_stale=COALESCE(EXCLUDED.backend_stale, cnc_telegram_worker_message_logs.backend_stale),
        ever_ingested=cnc_telegram_worker_message_logs.ever_ingested OR EXCLUDED.ever_ingested,
        last_decision_at=COALESCE(EXCLUDED.last_decision_at, cnc_telegram_worker_message_logs.last_decision_at),
        attempt_count=cnc_telegram_worker_message_logs.attempt_count,
        updated_at=now()
      WHERE cnc_telegram_worker_message_logs.raw_source_digest=EXCLUDED.raw_source_digest
        AND cnc_telegram_worker_message_logs.source_chat_id=EXCLUDED.source_chat_id
        AND cnc_telegram_worker_message_logs.source_message_id=EXCLUDED.source_message_id
        AND cnc_telegram_worker_message_logs.source_thread_id IS NOT DISTINCT FROM EXCLUDED.source_thread_id
        AND cnc_telegram_worker_message_logs.reply_to_message_id IS NOT DISTINCT FROM EXCLUDED.reply_to_message_id
        AND cnc_telegram_worker_message_logs.sender_user_id IS NOT DISTINCT FROM EXCLUDED.sender_user_id
        AND cnc_telegram_worker_message_logs.source_created_at=EXCLUDED.source_created_at
        AND cnc_telegram_worker_message_logs.source_edited_at IS NOT DISTINCT FROM EXCLUDED.source_edited_at
        AND cnc_telegram_worker_message_logs.workday=EXCLUDED.workday
        AND cnc_telegram_worker_message_logs.message_type=EXCLUDED.message_type
        AND cnc_telegram_worker_message_logs.outgoing=EXCLUDED.outgoing
      RETURNING log_id
    `, [
      m.logKey, m.rawSourceDigest, m.sanitizerVersion, m.sourceChatId, m.sourceMessageId,
      m.sourceThreadId ?? null, m.replyToMessageId ?? null, m.senderUserId ?? null,
      m.sourceCreatedAt, m.sourceEditedAt ?? null, m.workday, m.messageType, m.filename ?? null,
      m.mimeType ?? null, m.messageText ?? null, m.outgoing, m.status, m.reasonCode ?? null,
      m.reasonMessage ?? null, m.errorCode ?? null, m.errorMessage ?? null,
      m.relatedSourceMessageId ?? null, m.externalPacketKey ?? null, m.sourceVersion ?? null,
      m.packetId ?? null, m.cutJobId ?? null, m.cutResultNo ?? null, m.cuttingSequenceNo ?? null,
      m.backendApplied ?? null, m.backendStale ?? null, m.status === 'ingested', m.observedAt,
      m.decisionAt ?? null, scanId, m.status === 'observed' ? 0 : 1,
    ]);
    if (!result.rows[0]) throw new ApiError(409, 'AUDIT_LOG_CONFLICT', 'Конфликт неизменяемого сообщения журнала');
    return result.rows[0].log_id;
  }

  private async upsertOperation(client: TransactionClient, logId: string, p: WorkerAuditBatchDto['operations'][number]): Promise<string> {
    const result = await client.query<{ operation_id: string }>(`
      INSERT INTO cnc_telegram_worker_operations (
        operation_key, scan_id, log_id, operation_type, status, planned_at, finished_at,
        reason_code, reason_message, error_code, error_message, external_packet_key, source_version,
        packet_id, cut_job_id, cut_result_no, cutting_sequence_no, backend_applied, backend_stale,
        reply_text, reply_to_message_id, session_sender_user_id, sent_telegram_message_id,
        reconciliation_yielded_count, reconciliation_exhausted, reconciliation_truncated,
        reconciliation_error_code, reconciliation_window_from, reconciliation_window_to,
        steps_json, responses_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::bigint,$14,$15::bigint,$16,$17,$18,$19,$20,$21::bigint,$22::bigint,$23::bigint,$24,$25,$26,$27,$28,$29,$30::jsonb,$31::jsonb)
      ON CONFLICT (operation_key) DO UPDATE SET
        status=CASE WHEN cnc_telegram_worker_operations.status='planned' THEN EXCLUDED.status ELSE cnc_telegram_worker_operations.status END,
        finished_at=COALESCE(cnc_telegram_worker_operations.finished_at, EXCLUDED.finished_at),
        reason_code=COALESCE(cnc_telegram_worker_operations.reason_code, EXCLUDED.reason_code),
        reason_message=COALESCE(cnc_telegram_worker_operations.reason_message, EXCLUDED.reason_message),
        error_code=COALESCE(cnc_telegram_worker_operations.error_code, EXCLUDED.error_code),
        error_message=COALESCE(cnc_telegram_worker_operations.error_message, EXCLUDED.error_message),
        packet_id=COALESCE(cnc_telegram_worker_operations.packet_id, EXCLUDED.packet_id),
        cut_job_id=COALESCE(cnc_telegram_worker_operations.cut_job_id, EXCLUDED.cut_job_id),
        sent_telegram_message_id=COALESCE(cnc_telegram_worker_operations.sent_telegram_message_id, EXCLUDED.sent_telegram_message_id),
        reconciliation_yielded_count=GREATEST(cnc_telegram_worker_operations.reconciliation_yielded_count, EXCLUDED.reconciliation_yielded_count),
        reconciliation_exhausted=EXCLUDED.reconciliation_exhausted,
        reconciliation_truncated=EXCLUDED.reconciliation_truncated,
        reconciliation_error_code=EXCLUDED.reconciliation_error_code,
        reconciliation_window_from=COALESCE(cnc_telegram_worker_operations.reconciliation_window_from, EXCLUDED.reconciliation_window_from),
        reconciliation_window_to=COALESCE(cnc_telegram_worker_operations.reconciliation_window_to, EXCLUDED.reconciliation_window_to),
        external_packet_key=COALESCE(cnc_telegram_worker_operations.external_packet_key, EXCLUDED.external_packet_key),
        source_version=COALESCE(cnc_telegram_worker_operations.source_version, EXCLUDED.source_version),
        cut_result_no=COALESCE(cnc_telegram_worker_operations.cut_result_no, EXCLUDED.cut_result_no),
        cutting_sequence_no=COALESCE(cnc_telegram_worker_operations.cutting_sequence_no, EXCLUDED.cutting_sequence_no),
        backend_applied=COALESCE(cnc_telegram_worker_operations.backend_applied, EXCLUDED.backend_applied),
        backend_stale=COALESCE(cnc_telegram_worker_operations.backend_stale, EXCLUDED.backend_stale),
        reply_text=COALESCE(cnc_telegram_worker_operations.reply_text, EXCLUDED.reply_text),
        reply_to_message_id=COALESCE(cnc_telegram_worker_operations.reply_to_message_id, EXCLUDED.reply_to_message_id),
        session_sender_user_id=COALESCE(cnc_telegram_worker_operations.session_sender_user_id, EXCLUDED.session_sender_user_id),
        steps_json=CASE WHEN cnc_telegram_worker_operations.status='planned' THEN EXCLUDED.steps_json ELSE cnc_telegram_worker_operations.steps_json END,
        responses_json=CASE WHEN cnc_telegram_worker_operations.status='planned' THEN EXCLUDED.responses_json ELSE cnc_telegram_worker_operations.responses_json END,
        updated_at=now()
      WHERE cnc_telegram_worker_operations.scan_id=EXCLUDED.scan_id
        AND cnc_telegram_worker_operations.log_id=EXCLUDED.log_id
        AND cnc_telegram_worker_operations.operation_type=EXCLUDED.operation_type
        AND cnc_telegram_worker_operations.planned_at=EXCLUDED.planned_at
        AND (
          (
           cnc_telegram_worker_operations.status='planned'
           AND EXCLUDED.status<>'planned'
           AND (cnc_telegram_worker_operations.external_packet_key IS NULL OR cnc_telegram_worker_operations.external_packet_key IS NOT DISTINCT FROM EXCLUDED.external_packet_key)
           AND (cnc_telegram_worker_operations.source_version IS NULL OR cnc_telegram_worker_operations.source_version IS NOT DISTINCT FROM EXCLUDED.source_version)
           AND (cnc_telegram_worker_operations.packet_id IS NULL OR cnc_telegram_worker_operations.packet_id IS NOT DISTINCT FROM EXCLUDED.packet_id)
           AND (cnc_telegram_worker_operations.cut_job_id IS NULL OR cnc_telegram_worker_operations.cut_job_id IS NOT DISTINCT FROM EXCLUDED.cut_job_id)
           AND (cnc_telegram_worker_operations.cut_result_no IS NULL OR cnc_telegram_worker_operations.cut_result_no IS NOT DISTINCT FROM EXCLUDED.cut_result_no)
           AND (cnc_telegram_worker_operations.cutting_sequence_no IS NULL OR cnc_telegram_worker_operations.cutting_sequence_no IS NOT DISTINCT FROM EXCLUDED.cutting_sequence_no)
           AND (cnc_telegram_worker_operations.backend_applied IS NULL OR cnc_telegram_worker_operations.backend_applied IS NOT DISTINCT FROM EXCLUDED.backend_applied)
           AND (cnc_telegram_worker_operations.backend_stale IS NULL OR cnc_telegram_worker_operations.backend_stale IS NOT DISTINCT FROM EXCLUDED.backend_stale)
           AND (cnc_telegram_worker_operations.reply_text IS NULL OR cnc_telegram_worker_operations.reply_text IS NOT DISTINCT FROM EXCLUDED.reply_text)
           AND (cnc_telegram_worker_operations.reply_to_message_id IS NULL OR cnc_telegram_worker_operations.reply_to_message_id IS NOT DISTINCT FROM EXCLUDED.reply_to_message_id)
           AND (cnc_telegram_worker_operations.session_sender_user_id IS NULL OR cnc_telegram_worker_operations.session_sender_user_id IS NOT DISTINCT FROM EXCLUDED.session_sender_user_id)
           AND (cnc_telegram_worker_operations.sent_telegram_message_id IS NULL OR cnc_telegram_worker_operations.sent_telegram_message_id IS NOT DISTINCT FROM EXCLUDED.sent_telegram_message_id)
           AND EXCLUDED.steps_json @> cnc_telegram_worker_operations.steps_json
           AND EXCLUDED.responses_json @> cnc_telegram_worker_operations.responses_json
          )
          OR (
           cnc_telegram_worker_operations.status=EXCLUDED.status
           AND cnc_telegram_worker_operations.finished_at IS NOT DISTINCT FROM EXCLUDED.finished_at
           AND cnc_telegram_worker_operations.reason_code IS NOT DISTINCT FROM EXCLUDED.reason_code
           AND cnc_telegram_worker_operations.reason_message IS NOT DISTINCT FROM EXCLUDED.reason_message
           AND cnc_telegram_worker_operations.error_code IS NOT DISTINCT FROM EXCLUDED.error_code
           AND cnc_telegram_worker_operations.error_message IS NOT DISTINCT FROM EXCLUDED.error_message
           AND cnc_telegram_worker_operations.external_packet_key IS NOT DISTINCT FROM EXCLUDED.external_packet_key
           AND cnc_telegram_worker_operations.source_version IS NOT DISTINCT FROM EXCLUDED.source_version
           AND cnc_telegram_worker_operations.packet_id IS NOT DISTINCT FROM EXCLUDED.packet_id
           AND cnc_telegram_worker_operations.cut_job_id IS NOT DISTINCT FROM EXCLUDED.cut_job_id
           AND cnc_telegram_worker_operations.cut_result_no IS NOT DISTINCT FROM EXCLUDED.cut_result_no
           AND cnc_telegram_worker_operations.cutting_sequence_no IS NOT DISTINCT FROM EXCLUDED.cutting_sequence_no
           AND cnc_telegram_worker_operations.backend_applied IS NOT DISTINCT FROM EXCLUDED.backend_applied
           AND cnc_telegram_worker_operations.backend_stale IS NOT DISTINCT FROM EXCLUDED.backend_stale
           AND cnc_telegram_worker_operations.reply_text IS NOT DISTINCT FROM EXCLUDED.reply_text
           AND cnc_telegram_worker_operations.reply_to_message_id IS NOT DISTINCT FROM EXCLUDED.reply_to_message_id
           AND cnc_telegram_worker_operations.session_sender_user_id IS NOT DISTINCT FROM EXCLUDED.session_sender_user_id
           AND cnc_telegram_worker_operations.sent_telegram_message_id IS NOT DISTINCT FROM EXCLUDED.sent_telegram_message_id
           AND cnc_telegram_worker_operations.reconciliation_yielded_count=EXCLUDED.reconciliation_yielded_count
           AND cnc_telegram_worker_operations.reconciliation_exhausted=EXCLUDED.reconciliation_exhausted
           AND cnc_telegram_worker_operations.reconciliation_truncated=EXCLUDED.reconciliation_truncated
           AND cnc_telegram_worker_operations.reconciliation_error_code IS NOT DISTINCT FROM EXCLUDED.reconciliation_error_code
           AND cnc_telegram_worker_operations.reconciliation_window_from IS NOT DISTINCT FROM EXCLUDED.reconciliation_window_from
           AND cnc_telegram_worker_operations.reconciliation_window_to IS NOT DISTINCT FROM EXCLUDED.reconciliation_window_to
           AND cnc_telegram_worker_operations.steps_json=EXCLUDED.steps_json
           AND cnc_telegram_worker_operations.responses_json=EXCLUDED.responses_json
         )
        )
      RETURNING operation_id
    `, [
      p.operationKey, p.scanId, logId, p.operationType, p.status, p.plannedAt, p.finishedAt ?? null,
      p.reasonCode ?? null, p.reasonMessage ?? null, p.errorCode ?? null, p.errorMessage ?? null,
      p.externalPacketKey ?? null, p.sourceVersion ?? null, p.packetId ?? null, p.cutJobId ?? null,
      p.cutResultNo ?? null, p.cuttingSequenceNo ?? null, p.backendApplied ?? null, p.backendStale ?? null,
      p.replyText ?? null, p.replyToMessageId ?? null, p.sessionSenderUserId ?? null,
      p.sentTelegramMessageId ?? null, p.reconciliationYieldedCount, p.reconciliationExhausted,
      p.reconciliationTruncated, p.reconciliationErrorCode ?? null, p.reconciliationWindowFrom ?? null,
      p.reconciliationWindowTo ?? null, JSON.stringify(p.steps), JSON.stringify(p.responses),
    ]);
    if (!result.rows[0]) throw new ApiError(409, 'AUDIT_OPERATION_CONFLICT', 'Конфликт неизменяемой операции журнала');
    await client.query(`
      UPDATE cnc_telegram_worker_message_logs
         SET attempt_count=(SELECT count(*)::integer FROM cnc_telegram_worker_operations WHERE log_id=$1), updated_at=now()
       WHERE log_id=$1
    `, [logId]);
    return result.rows[0].operation_id;
  }
}

function buildMessageFilter(
  query: WorkerAuditListQueryDto | WorkerAuditExportQueryDto,
): { params: unknown[]; where: string[] } {
  const params: unknown[] = [query.dateFrom, query.dateTo];
  const where = [
    "m.source_created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Almaty')",
    "m.source_created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Almaty')",
  ];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (query.status) add('m.status = ?', query.status);
  if (query.messageType) add('m.message_type = ?', query.messageType);
  if (query.reasonCode) add('m.reason_code = ?', query.reasonCode);
  if (query.search) {
    if (/^-?[0-9]{1,20}$/.test(query.search)) {
      add('m.source_message_id = ?::bigint', query.search);
    } else {
      add(
        "to_tsvector('simple', COALESCE(m.filename, '') || ' ' || COALESCE(m.message_text, '')) @@ plainto_tsquery('simple', ?)",
        query.search,
      );
    }
  }
  return { params, where };
}

function exportTooLarge(entity: string): ApiError {
  return new ApiError(
    413,
    'AUDIT_EXPORT_TOO_LARGE',
    `В выбранном периоде больше ${MAX_DETAILED_EXPORT_ROWS} ${entity}. Уменьшите период экспорта`,
    { maxRows: MAX_DETAILED_EXPORT_ROWS },
  );
}
