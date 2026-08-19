import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole, mapRoleIdToRole, type UserRole } from '../../../permissions/permissions';
import { assertCurrentWorkerSessionInTransaction } from './cnc-telegram-worker-session-fencing';
import type { CncTelegramWorkerSessionLeaseContext } from '../application/cnc-telegram-worker-session.types';
import type { CncTelegramImportRepositoryPort } from '../application/cnc-telegram-import.types';
import type {
  CncTelegramImportCandidateBatchDto,
  CncTelegramImportCandidateDto,
  CncTelegramImportCompleteDto,
  CncTelegramImportFailDto,
  CncTelegramImportItemDto,
  CncTelegramImportMatchDto,
  CncTelegramImportRequestDto,
  CncTelegramImportScanCompleteDto,
  CncTelegramImportScanDto,
  CncTelegramImportScanFailureDto,
} from '../dto/cnc-telegram-import.dto';
import type { CncTelegramManualSvgUploadDto, CncTelegramManualSvgUploadResponseDto, CncTelegramStructuredIngestDto } from '../dto/cnc-telegram.dto';
import type { ManualSvgUploadCommand } from '../application/cnc-telegram.types';

type Row = QueryResultRow;
const BUSINESS_TIMEZONE = 'Asia/Almaty';
const MAX_ATTEMPTS = 5;
const LEASE_MINUTES = 5;

export class PgCncTelegramImportRepository implements CncTelegramImportRepositoryPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly explicitImporter: {
      manualSvgUploadInTransaction(tx: TransactionClient, command: ManualSvgUploadCommand): Promise<CncTelegramManualSvgUploadResponseDto>;
    },
  ) {}

  async createScan(input: { currentUser: CurrentUser; sourceChatId: string; dateFrom: string; dateTo: string; requestId: string; idempotencyKey: string }): Promise<CncTelegramImportScanDto> {
    const days = dateRangeDays(input.dateFrom, input.dateTo);
    return this.database.transaction(async (tx) => {
      const hash = digest(JSON.stringify({ dateFrom: input.dateFrom, dateTo: input.dateTo, timezone: BUSINESS_TIMEZONE }));
      const prior = await tx.query<Row>('SELECT * FROM cnc_telegram_import_scans WHERE requested_by=$1 AND idempotency_key=$2 FOR UPDATE', [input.currentUser.id, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (text(prior.rows[0], 'request_hash') !== hash) throw idempotencyConflict();
        return scanDto(prior.rows[0]);
      }
      const active = await tx.query<Row>("SELECT * FROM cnc_telegram_import_scans WHERE requested_by=$1 AND request_hash=$2 AND status IN ('pending','processing') ORDER BY created_at LIMIT 1 FOR SHARE", [input.currentUser.id, hash]);
      if (active.rows[0]) return scanDto(active.rows[0]);
      const result = await tx.query<Row>(`
        INSERT INTO cnc_telegram_import_scans
          (requested_by, source_chat_id, date_from, date_to, business_timezone,
           status, request_id, idempotency_key, request_hash)
        VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)
        RETURNING *
      `, [input.currentUser.id, input.sourceChatId, input.dateFrom, input.dateTo, BUSINESS_TIMEZONE, input.requestId, input.idempotencyKey, hash]);
      const row = requiredRow(result.rows[0], 'scan creation');
      await auditService.record(tx, {
        event: 'cnc.telegram_import.scan_requested', actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username, actorRole: input.currentUser.role,
        entityType: 'cnc_telegram_import_scan', entityId: text(row, 'scan_id'),
        source: 'cnc_telegram_import', requestId: input.requestId,
        metadata: { dateFrom: input.dateFrom, dateTo: input.dateTo, days },
      });
      await enqueueImportOutbox(tx, 'cnc.telegram_import.scan_requested', text(row, 'scan_id'), input.requestId, { actorUserId: input.currentUser.id, scanId: text(row, 'scan_id') });
      return scanDto(row);
    });
  }

  async getScan(input: { currentUser: CurrentUser; scanId: string }): Promise<CncTelegramImportScanDto> {
    return this.database.transaction(async (tx) => scanDto(await this.owned(tx, 'cnc_telegram_import_scans', 'scan_id', input.scanId, input.currentUser)));
  }

  async listCandidates(input: { currentUser: CurrentUser; scanId: string; page: number; pageSize: number }): Promise<{ items: CncTelegramImportCandidateDto[]; total: number }> {
    return this.database.transaction(async (tx) => {
      const scan = await this.owned(tx, 'cnc_telegram_import_scans', 'scan_id', input.scanId, input.currentUser);
      const result = await tx.query<Row>(`
        SELECT c.*, count(*) OVER() AS total
          FROM cnc_telegram_import_candidates c
         WHERE c.scan_id=$1
         ORDER BY c.source_created_at NULLS LAST, c.source_message_id, c.candidate_id
         LIMIT $2 OFFSET $3
      `, [text(scan, 'scan_id'), input.pageSize, (input.page - 1) * input.pageSize]);
      const items = await Promise.all(result.rows.map(async (row) => candidateDto(row, await this.matches(tx, text(row, 'candidate_id')))));
      return { items, total: result.rows[0] ? number(result.rows[0], 'total') : 0 };
    });
  }

  async prepare(input: { currentUser: CurrentUser; scanId: string; candidateIds: string[]; repeatOfImportRequestId?: string | null; requestId: string; idempotencyKey: string }): Promise<CncTelegramImportRequestDto> {
    return this.database.transaction(async (tx) => this.createRequest(tx, input));
  }

  async repeatPrepare(input: { currentUser: CurrentUser; importRequestId: string; candidateIds: string[]; requestId: string; idempotencyKey: string }): Promise<CncTelegramImportRequestDto> {
    return this.database.transaction(async (tx) => {
      const original = await this.owned(tx, 'cnc_telegram_import_requests', 'import_request_id', input.importRequestId, input.currentUser);
      if (!['completed', 'partial', 'failed'].includes(text(original, 'status'))) {
        throw new ApiError(409, 'CNC_TELEGRAM_REPEAT_NOT_TERMINAL', 'Only a terminal import can be repeated');
      }
      const ids = input.candidateIds.length > 0 ? input.candidateIds : await this.requestCandidateIds(tx, text(original, 'import_request_id'));
      return this.createRequest(tx, {
        currentUser: input.currentUser, scanId: text(original, 'scan_id'), candidateIds: ids,
        repeatOfImportRequestId: text(original, 'import_request_id'), requestId: input.requestId, idempotencyKey: input.idempotencyKey,
      });
    });
  }

  async confirm(input: { currentUser: CurrentUser; importRequestId: string; confirmationId: string; duplicateAcknowledgements: Array<{ candidateId: string; duplicateAcknowledged: boolean }>; requestId: string }): Promise<CncTelegramImportRequestDto> {
    return this.database.transaction(async (tx) => {
      const request = await this.owned(tx, 'cnc_telegram_import_requests', 'import_request_id', input.importRequestId, input.currentUser);
      if (text(request, 'confirmation_id') !== input.confirmationId) throw new ApiError(409, 'CNC_TELEGRAM_CONFIRMATION_MISMATCH', 'Confirmation id mismatch');
      if (text(request, 'status') !== 'draft') return this.loadRequest(tx, request);
      const items = await tx.query<Row>('SELECT * FROM cnc_telegram_import_items WHERE import_request_id=$1 ORDER BY created_at, import_item_id FOR UPDATE', [text(request, 'import_request_id')]);
      const acknowledgements = new Map(input.duplicateAcknowledgements.map((ack) => [ack.candidateId, ack.duplicateAcknowledged]));
      if (acknowledgements.size !== items.rowCount || items.rows.some((row) => !acknowledgements.has(text(row, 'candidate_id')))) {
        throw new ApiError(422, 'CNC_TELEGRAM_DUPLICATE_ACK_REQUIRED', 'Provide an explicit acknowledgement for every selected item');
      }
      for (const item of items.rows) {
        const status = text(item, 'status');
        if (status === 'imported' || status === 'failed') continue;
        const matches = parseMatches(json(item, 'duplicate_snapshot_json'));
        const acknowledged = acknowledgements.get(text(item, 'candidate_id')) === true;
        if (matches.length > 0 && !acknowledged) throw new ApiError(409, 'CNC_TELEGRAM_DUPLICATE_ACK_REQUIRED', 'Every duplicate must be explicitly acknowledged');
        await tx.query("UPDATE cnc_telegram_import_items SET duplicate_acknowledged=$1, status='pending', updated_at=now() WHERE import_item_id=$2 AND status IN ('pending','confirmation_required')", [acknowledged, text(item, 'import_item_id')]);
        if (matches.length > 0 && acknowledged) {
          await auditService.record(tx, {
            event: 'cnc.telegram_import.duplicate_acknowledged', actorUserId: input.currentUser.id,
            actorUsername: input.currentUser.username, actorRole: input.currentUser.role,
            entityType: 'cnc_telegram_import_item', entityId: text(item, 'import_item_id'),
            source: 'cnc_telegram_import', requestId: input.requestId,
            metadata: { candidateId: text(item, 'candidate_id'), confirmationId: input.confirmationId, matchCount: matches.length, matchKinds: [...new Set(matches.map((match) => match.kind))] },
          });
          await enqueueImportOutbox(tx, 'cnc.telegram_import.duplicate_acknowledged', text(item, 'import_item_id'), input.requestId, {
            actorUserId: input.currentUser.id, importRequestId: text(request, 'import_request_id'), candidateId: text(item, 'candidate_id'), confirmationId: input.confirmationId,
          });
        }
      }
      const updated = await tx.query<Row>('UPDATE cnc_telegram_import_requests SET status=\'pending\', confirmed_at=now() WHERE import_request_id=$1 RETURNING *', [text(request, 'import_request_id')]);
      await auditService.record(tx, {
        event: 'cnc.telegram_import.selection_confirmed', actorUserId: input.currentUser.id,
        actorUsername: input.currentUser.username, actorRole: input.currentUser.role,
        entityType: 'cnc_telegram_import_request', entityId: text(request, 'import_request_id'),
        source: 'cnc_telegram_import', requestId: input.requestId,
        metadata: { selectedCount: items.rowCount },
      });
      await enqueueImportOutbox(tx, 'cnc.telegram_import.selection_confirmed', text(request, 'import_request_id'), input.requestId, { actorUserId: input.currentUser.id, importRequestId: text(request, 'import_request_id') });
      return this.loadRequest(tx, requiredRow(updated.rows[0], 'confirmation'));
    });
  }

  async getImport(input: { currentUser: CurrentUser; importRequestId: string }): Promise<CncTelegramImportRequestDto> {
    return this.database.transaction(async (tx) => this.loadRequest(tx, await this.owned(tx, 'cnc_telegram_import_requests', 'import_request_id', input.importRequestId, input.currentUser)));
  }

  async claimScans(input: { currentUser: CurrentUser; lease: CncTelegramWorkerSessionLeaseContext; limit: number }): Promise<CncTelegramImportScanDto[]> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      await this.recoverScans(tx, input.lease.sourceChatId);
      const result = await tx.query<Row>(`
        WITH picked AS (
          SELECT scan_id FROM cnc_telegram_import_scans
           WHERE source_chat_id=$1 AND attempt_count < $3
             AND (status='pending' OR (status='processing' AND lease_expires_at <= now()))
           ORDER BY created_at, scan_id FOR UPDATE SKIP LOCKED LIMIT $2
        )
        UPDATE cnc_telegram_import_scans s
           SET status='processing', lease_token=encode(gen_random_bytes(32),'hex'),
               lease_generation=s.lease_generation+1, lease_expires_at=now()+interval '${LEASE_MINUTES} minutes',
               worker_instance_id=$4::uuid, claimed_at=now(), attempt_count=s.attempt_count+1, updated_at=now()
          FROM picked WHERE s.scan_id=picked.scan_id RETURNING s.*
      `, [input.lease.sourceChatId, input.limit, MAX_ATTEMPTS, input.lease.workerInstanceId]);
      for (const row of result.rows) await auditService.record(tx, {
        event: 'cnc.telegram_import.scan_claimed', actorUserId: input.currentUser.id,
        entityType: 'cnc_telegram_import_scan', entityId: text(row, 'scan_id'), source: 'cnc_telegram_import_worker',
        requestId: `scan-claim:${text(row, 'scan_id')}`, metadata: { workerInstanceId: input.lease.workerInstanceId },
      });
      return result.rows.map(scanDto);
    });
  }

  async writeCandidateBatch(input: { currentUser: CurrentUser; scanId: string; lease: CncTelegramWorkerSessionLeaseContext; batch: CncTelegramImportCandidateBatchDto; requestId: string }): Promise<{ accepted: number }> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      const scan = await this.lockScanLease(tx, input.scanId, input.batch.itemLeaseToken, input.batch.itemLeaseGeneration, input.batch.itemLeaseOwner, input.lease.sourceChatId);
      let accepted = 0;
      for (const candidate of input.batch.candidates) {
        if (candidate.sourceChatId !== input.lease.sourceChatId) throw new ApiError(403, 'CNC_TELEGRAM_CHAT_DENIED', 'Candidate chat differs from the session chat');
        const result = await tx.query<Row>(`
          INSERT INTO cnc_telegram_import_candidates
            (scan_id,source_chat_id,source_message_id,source_thread_id,source_created_at,source_updated_at,workday,
             svg_message_id,gcode_message_id,screenshot_message_id,svg_file_name,gcode_file_name,screenshot_file_name,
             svg_content_sha256,gcode_content_sha256,screenshot_content_sha256,source_set_fingerprint,parser_version,
             layout_fingerprint,parsed_snapshot_json,cut_layout_json,warnings_json,eligibility_status,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22::jsonb,$23,now()+interval '7 days')
          ON CONFLICT (scan_id,source_chat_id,source_message_id) DO UPDATE SET
            source_thread_id=EXCLUDED.source_thread_id, source_created_at=EXCLUDED.source_created_at, source_updated_at=EXCLUDED.source_updated_at, workday=EXCLUDED.workday,
            svg_message_id=EXCLUDED.svg_message_id, gcode_message_id=EXCLUDED.gcode_message_id, screenshot_message_id=EXCLUDED.screenshot_message_id,
            svg_file_name=EXCLUDED.svg_file_name, gcode_file_name=EXCLUDED.gcode_file_name, screenshot_file_name=EXCLUDED.screenshot_file_name,
            svg_content_sha256=EXCLUDED.svg_content_sha256, gcode_content_sha256=EXCLUDED.gcode_content_sha256, screenshot_content_sha256=EXCLUDED.screenshot_content_sha256,
            source_set_fingerprint=EXCLUDED.source_set_fingerprint, parser_version=EXCLUDED.parser_version, layout_fingerprint=EXCLUDED.layout_fingerprint,
            parsed_snapshot_json=EXCLUDED.parsed_snapshot_json, cut_layout_json=EXCLUDED.cut_layout_json, warnings_json=EXCLUDED.warnings_json,
            eligibility_status=EXCLUDED.eligibility_status, expires_at=EXCLUDED.expires_at, updated_at=now()
          RETURNING *
        `, [text(scan, 'scan_id'), candidate.sourceChatId, candidate.sourceMessageId, candidate.sourceThreadId ?? null, candidate.sourceCreatedAt ?? null, candidate.sourceUpdatedAt ?? null, candidate.workday,
          candidate.svgMessageId, candidate.gcodeMessageId ?? null, candidate.screenshotMessageId ?? null, candidate.svgFileName, candidate.gcodeFileName ?? null, candidate.screenshotFileName ?? null,
          candidate.svgContentSha256, candidate.gcodeContentSha256 ?? null, candidate.screenshotContentSha256 ?? null, candidate.sourceSetFingerprint, candidate.parserVersion,
          candidate.layoutFingerprint ?? null, JSON.stringify(candidate.parsedSnapshot), JSON.stringify(candidate.cutLayout ?? null), JSON.stringify(candidate.warnings ?? []), candidate.eligibilityStatus]);
        const row = requiredRow(result.rows[0], 'candidate batch');
        await this.refreshMatches(tx, row);
        accepted += 1;
      }
      await tx.query(`UPDATE cnc_telegram_import_scans SET days_scanned=GREATEST(days_scanned,$2), messages_scanned=GREATEST(messages_scanned,$3), truncated=truncated OR $4, candidates_found=(SELECT count(*) FROM cnc_telegram_import_candidates WHERE scan_id=$1), warnings_count=(SELECT count(*) FROM cnc_telegram_import_candidates WHERE scan_id=$1 AND jsonb_array_length(warnings_json)>0), lease_expires_at=GREATEST(lease_expires_at, now()+interval '${LEASE_MINUTES} minutes'), updated_at=now() WHERE scan_id=$1`, [text(scan, 'scan_id'), input.batch.daysScanned ?? 0, input.batch.messagesScanned ?? 0, input.batch.truncated ?? false]);
      return { accepted };
    });
  }

  async completeScan(input: { currentUser: CurrentUser; scanId: string; lease: CncTelegramWorkerSessionLeaseContext; scanTaskLease: CncTelegramImportScanCompleteDto; requestId: string }): Promise<CncTelegramImportScanDto> {
    return this.finishScan(input, 'ready', input.scanTaskLease, input.requestId);
  }

  async failScan(input: { currentUser: CurrentUser; scanId: string; lease: CncTelegramWorkerSessionLeaseContext; failure: CncTelegramImportScanFailureDto; requestId: string }): Promise<CncTelegramImportScanDto> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      const row = await this.lockScanLease(tx, input.scanId, input.failure.itemLeaseToken, input.failure.itemLeaseGeneration, input.failure.itemLeaseOwner, input.lease.sourceChatId);
      const updated = await tx.query<Row>(`UPDATE cnc_telegram_import_scans SET status='failed', completed_at=now(), error_code=$2, error_message=$3, lease_token=NULL, lease_expires_at=NULL, worker_instance_id=NULL, updated_at=now() WHERE scan_id=$1 RETURNING *`, [text(row, 'scan_id'), input.failure.errorCode, input.failure.errorMessage]);
      await auditService.record(tx, { event: 'cnc.telegram_import.scan_failed', actorUserId: input.currentUser.id, entityType: 'cnc_telegram_import_scan', entityId: text(row, 'scan_id'), source: 'cnc_telegram_import_worker', requestId: input.requestId, metadata: { errorCode: input.failure.errorCode } });
      return scanDto(requiredRow(updated.rows[0], 'scan failure'));
    });
  }

  async claimImports(input: { currentUser: CurrentUser; lease: CncTelegramWorkerSessionLeaseContext; limit: number }): Promise<CncTelegramImportItemDto[]> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      await this.recoverItems(tx, input.lease.sourceChatId);
      const result = await tx.query<Row>(`
        WITH picked AS (
          SELECT i.import_item_id FROM cnc_telegram_import_items i
          JOIN cnc_telegram_import_requests r USING(import_request_id)
          JOIN cnc_telegram_import_candidates c USING(candidate_id)
          WHERE r.status IN ('pending','processing') AND c.source_chat_id=$1 AND i.attempt_count < $3
            AND (i.status='pending' OR (i.status='processing' AND i.lease_expires_at<=now()))
          ORDER BY i.created_at,i.import_item_id FOR UPDATE SKIP LOCKED LIMIT $2
        )
        UPDATE cnc_telegram_import_items i SET status='processing', lease_token=encode(gen_random_bytes(32),'hex'),
          lease_generation=i.lease_generation+1, lease_expires_at=now()+interval '${LEASE_MINUTES} minutes',
          lease_worker_instance_id=$4::uuid, attempt_count=i.attempt_count+1, updated_at=now()
        FROM picked WHERE i.import_item_id=picked.import_item_id RETURNING i.*
      `, [input.lease.sourceChatId, input.limit, MAX_ATTEMPTS, input.lease.workerInstanceId]);
      for (const row of result.rows) {
        await tx.query("UPDATE cnc_telegram_import_requests SET status='processing' WHERE import_request_id=$1 AND status='pending'", [text(row, 'import_request_id')]);
        await auditService.record(tx, { event: 'cnc.telegram_import.item_claimed', actorUserId: input.currentUser.id, entityType: 'cnc_telegram_import_item', entityId: text(row, 'import_item_id'), source: 'cnc_telegram_import_worker', requestId: `item-claim:${text(row, 'import_item_id')}`, metadata: { workerInstanceId: input.lease.workerInstanceId } });
      }
      return Promise.all(result.rows.map(async (row) => {
        const full = await this.importItemWithSource(tx, text(row, 'import_item_id'));
        return itemDto(full, await this.matches(tx, text(full, 'candidate_id')));
      }));
    });
  }

  async completeImport(input: { currentUser: CurrentUser; importItemId: string; lease: CncTelegramWorkerSessionLeaseContext; completion: CncTelegramImportCompleteDto; requestId: string }): Promise<CncTelegramImportItemDto> {
    const importer = this.explicitImporter;
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      const current = await this.importItemWithSource(tx, input.importItemId);
      if (text(current, 'status') === 'imported') {
        assertTerminalItemLeaseReplay(current, input.completion, input.lease.sourceChatId);
        assertSourceMatches(current, input.completion);
        return itemDto(current);
      }
      const item = await this.lockItemLease(tx, input.importItemId, input.completion.itemLeaseToken, input.completion.itemLeaseGeneration, input.completion.itemLeaseOwner, input.lease.sourceChatId);
      assertSourceMatches(item, input.completion);
      const candidate = await this.refreshMatches(tx, item);
      const currentMatches = await this.matches(tx, text(candidate, 'candidate_id'));
      if (number(candidate, 'duplicate_match_version') !== number(item, 'duplicate_match_version') || !sameMatches(currentMatches, parseMatches(json(item, 'duplicate_snapshot_json')))) {
        return itemDto(await this.markConfirmationRequired(tx, item, candidate, currentMatches, input.currentUser, input.requestId));
      }
      if (currentMatches.length > 0 && !bool(item, 'duplicate_acknowledged')) {
        return itemDto(await this.markConfirmationRequired(tx, item, candidate, currentMatches, input.currentUser, input.requestId));
      }
      const requester = await this.requesterActor(tx, text(item, 'requested_by'));
      const layout = toCutLayout(json(item, 'cut_layout_json'));
      const parsedItems = telegramImportItemsFromLayout(layout);
      const selectedOrderIds = await inferTelegramImportSelectedOrderIds(
        tx,
        parsedItems,
      );
      if (selectedOrderIds.length === 0) {
        throw new ApiError(
          422,
          'CNC_TELEGRAM_IMPORT_ORDERS_UNRESOLVED',
          'Telegram SVG details do not identify a unique active ERP order',
        );
      }
      const sourceFiles = input.completion.sourceFiles;
      if (!sourceFiles || sourceFiles.length === 0) throw new ApiError(422, 'CNC_TELEGRAM_SOURCE_FILES_REQUIRED', 'Selected Telegram files must be re-downloaded and verified before import');
      const dto: CncTelegramManualSvgUploadDto = {
        idempotencyKey: `cnc-telegram-import:${text(item, 'import_item_id')}`,
        selectedOrderIds, createMdfMachineFileCard: true,
        matchMode: 'order_details', validationMode: 'strict', svgContentHash: text(item, 'svg_content_sha256'),
        cutLayout: layout, items: parsedItems, sourceFiles,
        duplicatePolicy: { kind: 'intentional_copy', approvedByImportItemId: text(item, 'import_item_id') },
      };
      const response = await importer.manualSvgUploadInTransaction(tx, { currentUser: requester, dto, requestId: input.requestId });
      const updated = await tx.query<Row>(`UPDATE cnc_telegram_import_items SET status='imported', packet_id=$2, cut_job_id=$3, cut_result_id=$4, updated_at=now() WHERE import_item_id=$1 RETURNING *`, [text(item, 'import_item_id'), response.packet.packetId, response.cutJobId, response.cutResultId]);
      await updateRequestCounts(tx, text(item, 'import_request_id'));
      await auditService.record(tx, { event: 'cnc.telegram_import.item_imported', actorUserId: requester.id, actorUsername: requester.username, actorRole: requester.role, entityType: 'cnc_telegram_import_item', entityId: text(item, 'import_item_id'), source: 'cnc_telegram_import', requestId: input.requestId, metadata: { technicalWorker: input.currentUser.username, packetId: response.packet.packetId, cutJobId: response.cutJobId } });
      await enqueueImportOutbox(tx, 'cnc.telegram_import.item_imported', text(item, 'import_item_id'), input.requestId, { actorUserId: requester.id, technicalWorkerUserId: input.currentUser.id, packetId: response.packet.packetId, cutJobId: response.cutJobId });
      return itemDto(requiredRow(updated.rows[0], 'import completion'));
    });
  }

  async failImport(input: { currentUser: CurrentUser; importItemId: string; lease: CncTelegramWorkerSessionLeaseContext; failure: CncTelegramImportFailDto; requestId: string }): Promise<CncTelegramImportItemDto> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      const current = await this.importItemWithSource(tx, input.importItemId);
      if (['imported', 'failed'].includes(text(current, 'status'))) {
        assertTerminalItemLeaseReplay(current, input.failure, input.lease.sourceChatId);
        return itemDto(current);
      }
      const item = await this.lockItemLease(tx, input.importItemId, input.failure.itemLeaseToken, input.failure.itemLeaseGeneration, input.failure.itemLeaseOwner, input.lease.sourceChatId);
      const updated = await tx.query<Row>(`UPDATE cnc_telegram_import_items SET status='failed', error_code=$2, error_message=$3, updated_at=now() WHERE import_item_id=$1 RETURNING *`, [text(item, 'import_item_id'), input.failure.errorCode, input.failure.errorMessage]);
      await updateRequestCounts(tx, text(item, 'import_request_id'));
      await auditService.record(tx, { event: 'cnc.telegram_import.item_failed', actorUserId: input.currentUser.id, entityType: 'cnc_telegram_import_item', entityId: text(item, 'import_item_id'), source: 'cnc_telegram_import_worker', requestId: input.requestId, metadata: { errorCode: input.failure.errorCode } });
      return itemDto(requiredRow(updated.rows[0], 'import failure'));
    });
  }

  private async createRequest(tx: TransactionClient, input: { currentUser: CurrentUser; scanId: string; candidateIds: string[]; repeatOfImportRequestId?: string | null; requestId: string; idempotencyKey: string }): Promise<CncTelegramImportRequestDto> {
    if (new Set(input.candidateIds).size !== input.candidateIds.length) throw new ApiError(422, 'INVALID_CNC_TELEGRAM_CANDIDATES', 'Candidate selection must not contain duplicates');
    const scan = await this.owned(tx, 'cnc_telegram_import_scans', 'scan_id', input.scanId, input.currentUser);
    if (text(scan, 'status') !== 'ready') throw new ApiError(409, 'CNC_TELEGRAM_SCAN_NOT_READY', 'Scan is not ready');
    const candidates = await tx.query<Row>('SELECT * FROM cnc_telegram_import_candidates WHERE scan_id=$1 AND candidate_id=ANY($2::uuid[]) FOR UPDATE', [text(scan, 'scan_id'), input.candidateIds]);
    if (candidates.rowCount !== input.candidateIds.length || candidates.rows.some((row) => text(row, 'eligibility_status') !== 'valid' || new Date(text(row, 'expires_at')).getTime() <= Date.now())) throw new ApiError(422, 'INVALID_CNC_TELEGRAM_CANDIDATES', 'Selection contains an expired or ineligible candidate');
    for (const candidate of candidates.rows) await this.refreshMatches(tx, candidate);
    const selectionHash = digest(JSON.stringify([text(scan, 'scan_id'), input.currentUser.id, [...input.candidateIds].sort(), input.repeatOfImportRequestId ?? null]));
    const requestHash = digest(JSON.stringify({ selectionHash, actor: input.currentUser.id, repeat: input.repeatOfImportRequestId ?? null }));
    const prior = await tx.query<Row>('SELECT * FROM cnc_telegram_import_requests WHERE requested_by=$1 AND idempotency_key=$2 FOR UPDATE', [input.currentUser.id, input.idempotencyKey]);
    if (prior.rows[0]) {
      if (text(prior.rows[0], 'request_hash') !== requestHash) throw idempotencyConflict();
      return this.loadRequest(tx, prior.rows[0]);
    }
    if (!input.repeatOfImportRequestId) {
      const terminal = await tx.query<Row>(`SELECT import_request_id FROM cnc_telegram_import_requests WHERE scan_id=$1 AND requested_by=$2 AND selection_hash=$3 AND status IN ('completed','partial','failed') LIMIT 1`, [text(scan, 'scan_id'), input.currentUser.id, selectionHash]);
      if (terminal.rows[0]) throw new ApiError(409, 'CNC_TELEGRAM_REPEAT_REQUIRED', 'An explicit repeat relation is required for an already imported selection');
    }
    const req = await tx.query<Row>(`INSERT INTO cnc_telegram_import_requests (scan_id,requested_by,request_id,idempotency_key,request_hash,selection_hash,repeat_of_import_request_id,status,selected_count,duplicate_match_version) VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,(SELECT COALESCE(MAX(duplicate_match_version),1) FROM cnc_telegram_import_candidates WHERE candidate_id=ANY($9::uuid[]))) RETURNING *`, [text(scan, 'scan_id'), input.currentUser.id, input.requestId, input.idempotencyKey, requestHash, selectionHash, input.repeatOfImportRequestId ?? null, input.candidateIds.length, input.candidateIds]);
    const request = requiredRow(req.rows[0], 'request creation');
    for (const candidate of candidates.rows) {
      const matches = await this.matches(tx, text(candidate, 'candidate_id'));
      await tx.query(`INSERT INTO cnc_telegram_import_items (import_request_id,candidate_id,duplicate_acknowledged,duplicate_match_version,duplicate_snapshot_json,status,source_set_fingerprint) VALUES ($1,$2,false,$3,$4::jsonb,'pending',$5)`, [text(request, 'import_request_id'), text(candidate, 'candidate_id'), number(candidate, 'duplicate_match_version'), JSON.stringify(matches), text(candidate, 'source_set_fingerprint')]);
    }
    await auditService.record(tx, { event: 'cnc.telegram_import.selection_prepared', actorUserId: input.currentUser.id, actorUsername: input.currentUser.username, actorRole: input.currentUser.role, entityType: 'cnc_telegram_import_request', entityId: text(request, 'import_request_id'), source: 'cnc_telegram_import', requestId: input.requestId, metadata: { selectionHash, candidateCount: input.candidateIds.length, repeatOfImportRequestId: input.repeatOfImportRequestId ?? null } });
    return this.loadRequest(tx, request);
  }

  private async loadRequest(tx: TransactionClient, request: Row): Promise<CncTelegramImportRequestDto> {
    const items = await tx.query<Row>('SELECT * FROM cnc_telegram_import_items WHERE import_request_id=$1 ORDER BY created_at, import_item_id', [text(request, 'import_request_id')]);
    const itemDtos = await Promise.all(items.rows.map(async (row) => itemDto(row, await this.matches(tx, text(row, 'candidate_id')))));
    const candidates = await Promise.all(items.rows.map(async (row) => {
      const candidate = await tx.query<Row>('SELECT * FROM cnc_telegram_import_candidates WHERE candidate_id=$1', [text(row, 'candidate_id')]);
      return candidate.rows[0] ? candidateDto(candidate.rows[0], await this.matches(tx, text(row, 'candidate_id'))) : null;
    }));
    const normalizedCandidates = candidates.filter((candidate): candidate is CncTelegramImportCandidateDto => candidate !== null);
    const duplicateCount = itemDtos.filter((item) => item.matches.length > 0).length;
    return { ...requestDto(request), items: itemDtos, candidates: normalizedCandidates, refreshedCandidates: normalizedCandidates, duplicateCount };
  }

  private async owned(tx: TransactionClient, table: 'cnc_telegram_import_scans' | 'cnc_telegram_import_requests', key: string, id: string, user: CurrentUser): Promise<Row> {
    const ownerClause = canManageAll(user) ? `${key}=$1` : `${key}=$1 AND requested_by=$2`;
    const params = canManageAll(user) ? [id] : [id, user.id];
    const result = await tx.query<Row>(`SELECT * FROM ${table} WHERE ${ownerClause} FOR SHARE`, params);
    if (!result.rows[0]) throw new ApiError(404, 'CNC_TELEGRAM_IMPORT_NOT_FOUND', 'Import resource not found');
    return result.rows[0];
  }

  private async requestCandidateIds(tx: TransactionClient, requestId: string): Promise<string[]> {
    const result = await tx.query<Row>('SELECT candidate_id FROM cnc_telegram_import_items WHERE import_request_id=$1 ORDER BY created_at,candidate_id', [requestId]);
    return result.rows.map((row) => text(row, 'candidate_id'));
  }

  private async lockScanLease(tx: TransactionClient, scanId: string, token: string, generation: number, owner: string, chat: string): Promise<Row> {
    const result = await tx.query<Row>(`SELECT * FROM cnc_telegram_import_scans WHERE scan_id=$1 AND source_chat_id=$2 AND lease_token=$3 AND lease_generation=$4 AND worker_instance_id=$5::uuid AND lease_expires_at>now() FOR UPDATE`, [scanId, chat, token, generation, owner]);
    if (!result.rows[0]) throw new ApiError(409, 'CNC_TELEGRAM_SCAN_LEASE_STALE', 'Scan lease is stale or expired');
    return result.rows[0];
  }

  private async importItemWithSource(tx: TransactionClient, itemId: string): Promise<Row> {
    const result = await tx.query<Row>(`SELECT i.*,r.requested_by,r.import_request_id,r.scan_id,
      c.source_chat_id,c.source_message_id,c.source_thread_id,c.source_created_at,c.source_updated_at,c.workday,
      c.svg_message_id,c.gcode_message_id,c.screenshot_message_id,c.svg_file_name,c.gcode_file_name,c.screenshot_file_name,
      c.svg_content_sha256,c.gcode_content_sha256,c.screenshot_content_sha256,c.source_set_fingerprint,c.parser_version,
      c.layout_fingerprint,c.parsed_snapshot_json,c.cut_layout_json,c.warnings_json,c.eligibility_status,
      c.duplicate_match_version AS candidate_duplicate_match_version
      FROM cnc_telegram_import_items i JOIN cnc_telegram_import_requests r USING(import_request_id)
      JOIN cnc_telegram_import_candidates c USING(candidate_id) WHERE i.import_item_id=$1`, [itemId]);
    if (!result.rows[0]) throw new ApiError(404, 'CNC_TELEGRAM_IMPORT_NOT_FOUND', 'Import item not found');
    return result.rows[0];
  }

  private async lockItemLease(tx: TransactionClient, itemId: string, token: string, generation: number, owner: string, chat: string): Promise<Row> {
    const result = await tx.query<Row>(`SELECT i.*,r.requested_by,r.import_request_id,r.scan_id,
      c.source_chat_id,c.source_message_id,c.source_thread_id,c.source_created_at,c.source_updated_at,c.workday,
      c.svg_message_id,c.gcode_message_id,c.screenshot_message_id,c.svg_file_name,c.gcode_file_name,c.screenshot_file_name,
      c.svg_content_sha256,c.gcode_content_sha256,c.screenshot_content_sha256,c.source_set_fingerprint,c.parser_version,
      c.layout_fingerprint,c.parsed_snapshot_json,c.cut_layout_json,c.warnings_json,c.eligibility_status,
      c.duplicate_match_version AS candidate_duplicate_match_version
      FROM cnc_telegram_import_items i JOIN cnc_telegram_import_requests r USING(import_request_id)
      JOIN cnc_telegram_import_candidates c USING(candidate_id)
      WHERE i.import_item_id=$1 AND c.source_chat_id=$2 AND i.lease_token=$3 AND i.lease_generation=$4
        AND i.lease_worker_instance_id=$5::uuid AND i.lease_expires_at>now() FOR UPDATE`, [itemId, chat, token, generation, owner]);
    if (!result.rows[0]) throw new ApiError(409, 'CNC_TELEGRAM_ITEM_LEASE_STALE', 'Item lease is stale or expired');
    return result.rows[0];
  }

  private async requesterActor(tx: TransactionClient, userId: string): Promise<CurrentUser> {
    const result = await tx.query<Row>('SELECT u.user_id,u.username,u.role_id,r.role_code FROM users u JOIN roles r ON r.role_id=u.role_id WHERE u.user_id=$1', [userId]);
    const row = requiredRow(result.rows[0], 'requester actor');
    const role = mapRoleIdToRole(number(row, 'role_id')) ?? safeRole(text(row, 'role_code'));
    return { id: text(row, 'user_id'), username: text(row, 'username'), role, roleId: number(row, 'role_id'), permissions: getPermissionsForRole(role) };
  }

  private async refreshMatches(tx: TransactionClient, candidate: Row): Promise<Row> {
    const candidateId = text(candidate, 'candidate_id');
    const before = await this.matches(tx, candidateId);
    await tx.query('DELETE FROM cnc_telegram_import_candidate_matches WHERE candidate_id=$1', [candidateId]);
    await tx.query(`INSERT INTO cnc_telegram_import_candidate_matches (candidate_id,match_kind,packet_id,cut_job_id,cut_result_id) SELECT $1,'same_telegram_source',p.packet_id,p.svg_cut_job_id,p.svg_cut_result_id FROM cnc_telegram_packets p WHERE p.source_chat_id=$2 AND p.source_message_id=$3 AND (p.packet_id IS NOT NULL)`, [candidateId, text(candidate, 'source_chat_id'), number(candidate, 'source_message_id')]);
    await tx.query(`INSERT INTO cnc_telegram_import_candidate_matches (candidate_id,match_kind,packet_id,cut_job_id,cut_result_id) SELECT $1,'sent_by_erp_manual_upload',p.packet_id,p.svg_cut_job_id,p.svg_cut_result_id FROM cnc_manual_svg_telegram_send_requests s JOIN cnc_telegram_packets p ON p.packet_id=s.packet_id JOIN LATERAL jsonb_array_elements_text(s.sent_message_ids_json) sent(message_id) ON sent.message_id=$2 WHERE s.sent_chat_id=$3 AND s.status='sent'`, [candidateId, String(number(candidate, 'source_message_id')), text(candidate, 'source_chat_id')]);
    await tx.query(`INSERT INTO cnc_telegram_import_candidate_matches (candidate_id,match_kind,packet_id,cut_job_id,cut_result_id) SELECT $1,'exact_svg_content',p.packet_id,p.svg_cut_job_id,p.svg_cut_result_id FROM cnc_manual_svg_upload_files f JOIN cnc_telegram_packets p ON p.packet_id=f.packet_id WHERE f.file_kind='svg' AND f.content_sha256=$2`, [candidateId, text(candidate, 'svg_content_sha256')]);
    if (nullableText(candidate, 'layout_fingerprint')) {
      await tx.query(`INSERT INTO cnc_telegram_import_candidate_matches (candidate_id,match_kind,packet_id,cut_job_id,cut_result_id) SELECT $1,'same_layout',p.packet_id,p.svg_cut_job_id,p.svg_cut_result_id FROM cnc_telegram_packets p WHERE p.layout_fingerprint=$2`, [candidateId, text(candidate, 'layout_fingerprint')]);
    }
    const after = await this.matches(tx, candidateId);
    const changed = !sameMatches(before, after);
    if (changed) {
      await tx.query('UPDATE cnc_telegram_import_candidates SET duplicate_match_version=duplicate_match_version+1, updated_at=now() WHERE candidate_id=$1', [candidateId]);
      const result = await tx.query<Row>('SELECT * FROM cnc_telegram_import_candidates WHERE candidate_id=$1 FOR UPDATE', [candidateId]);
      return requiredRow(result.rows[0], 'candidate refresh');
    }
    return candidate;
  }

  private async matches(tx: TransactionClient, candidateId: string): Promise<CncTelegramImportMatchDto[]> {
    const result = await tx.query<Row>('SELECT match_kind,packet_id,cut_job_id,cut_result_id FROM cnc_telegram_import_candidate_matches WHERE candidate_id=$1 ORDER BY match_kind,match_id', [candidateId]);
    return result.rows.map((row) => ({ kind: text(row, 'match_kind') as CncTelegramImportMatchDto['kind'], packetId: nullableText(row, 'packet_id'), cutJobId: nullableNumber(row, 'cut_job_id'), cutResultId: nullableNumber(row, 'cut_result_id') }));
  }

  private async markConfirmationRequired(tx: TransactionClient, item: Row, candidate: Row, matches: CncTelegramImportMatchDto[], actor: CurrentUser, requestId: string): Promise<Row> {
    const result = await tx.query<Row>(`UPDATE cnc_telegram_import_items SET status='confirmation_required', duplicate_match_version=$2, duplicate_snapshot_json=$3::jsonb, lease_token=NULL, lease_expires_at=NULL, lease_worker_instance_id=NULL, updated_at=now() WHERE import_item_id=$1 RETURNING *`, [text(item, 'import_item_id'), number(candidate, 'duplicate_match_version'), JSON.stringify(matches)]);
    await tx.query("UPDATE cnc_telegram_import_requests SET status='draft' WHERE import_request_id=$1 AND status='processing'", [text(item, 'import_request_id')]);
    await auditService.record(tx, { event: 'cnc.telegram_import.confirmation_required', actorUserId: actor.id, entityType: 'cnc_telegram_import_item', entityId: text(item, 'import_item_id'), source: 'cnc.telegram_import_worker', requestId, metadata: { reason: 'duplicate_matches_changed' } });
    return { ...item, ...requiredRow(result.rows[0], 'confirmation required') };
  }

  private async recoverScans(tx: TransactionClient, chat: string): Promise<void> {
    await tx.query(`UPDATE cnc_telegram_import_scans SET status='failed', error_code='MAX_ATTEMPTS_EXCEEDED', error_message='Worker lease expired too many times', completed_at=now(), lease_token=NULL, lease_expires_at=NULL, worker_instance_id=NULL, updated_at=now() WHERE source_chat_id=$1 AND status='processing' AND lease_expires_at<=now() AND attempt_count >= $2`, [chat, MAX_ATTEMPTS]);
    await tx.query(`UPDATE cnc_telegram_import_scans SET status='pending', lease_token=NULL, lease_expires_at=NULL, worker_instance_id=NULL, updated_at=now() WHERE source_chat_id=$1 AND status='processing' AND lease_expires_at<=now() AND attempt_count < $2`, [chat, MAX_ATTEMPTS]);
  }

  private async recoverItems(tx: TransactionClient, chat: string): Promise<void> {
    const failed = await tx.query<Row>(`UPDATE cnc_telegram_import_items i SET status='failed', error_code='MAX_ATTEMPTS_EXCEEDED', error_message='Worker lease expired too many times', lease_token=NULL, lease_expires_at=NULL, lease_worker_instance_id=NULL, updated_at=now() FROM cnc_telegram_import_candidates c WHERE c.candidate_id=i.candidate_id AND c.source_chat_id=$1 AND i.status='processing' AND i.lease_expires_at<=now() AND i.attempt_count >= $2 RETURNING i.import_request_id`, [chat, MAX_ATTEMPTS]);
    for (const requestId of new Set(failed.rows.map((row) => text(row, 'import_request_id')))) {
      await updateRequestCounts(tx, requestId);
    }
    await tx.query(`UPDATE cnc_telegram_import_items i SET status='pending', lease_token=NULL, lease_expires_at=NULL, lease_worker_instance_id=NULL, updated_at=now() FROM cnc_telegram_import_candidates c WHERE c.candidate_id=i.candidate_id AND c.source_chat_id=$1 AND i.status='processing' AND i.lease_expires_at<=now() AND i.attempt_count < $2`, [chat, MAX_ATTEMPTS]);
  }

  private async finishScan(input: { currentUser: CurrentUser; scanId: string; lease: CncTelegramWorkerSessionLeaseContext; scanTaskLease: CncTelegramImportScanCompleteDto; requestId: string }, status: 'ready', complete: CncTelegramImportScanCompleteDto, requestId: string): Promise<CncTelegramImportScanDto> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      const row = await this.lockScanLease(tx, input.scanId, complete.itemLeaseToken, complete.itemLeaseGeneration, complete.itemLeaseOwner, input.lease.sourceChatId);
      const updated = await tx.query<Row>(`UPDATE cnc_telegram_import_scans SET status=$2, completed_at=now(), days_scanned=GREATEST(days_scanned,$3), messages_scanned=GREATEST(messages_scanned,$4), truncated=truncated OR $5, lease_token=NULL, lease_expires_at=NULL, worker_instance_id=NULL, updated_at=now() WHERE scan_id=$1 RETURNING *`, [text(row, 'scan_id'), status, complete.daysScanned ?? 0, complete.messagesScanned ?? 0, complete.truncated ?? false]);
      await auditService.record(tx, { event: 'cnc.telegram_import.scan_completed', actorUserId: input.currentUser.id, entityType: 'cnc_telegram_import_scan', entityId: text(row, 'scan_id'), source: 'cnc.telegram_import_worker', requestId, metadata: { candidatesFound: number(row, 'candidates_found') } });
      return scanDto(requiredRow(updated.rows[0], 'scan completion'));
    });
  }
}

function dateRangeDays(from: string, to: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ApiError(422, 'INVALID_CNC_TELEGRAM_IMPORT_RANGE', 'Dates must use YYYY-MM-DD');
  const start = Date.parse(`${from}T00:00:00Z`); const end = Date.parse(`${to}T00:00:00Z`);
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || days < 1 || days > 31) throw new ApiError(422, 'INVALID_CNC_TELEGRAM_IMPORT_RANGE', 'Date range must contain 1..31 days');
  return days;
}
function canManageAll(user: CurrentUser): boolean { return user.permissions.includes('cnc.telegram_import.manage_all'); }
function idempotencyConflict(): ApiError { return new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key has a different request'); }
function requiredRow(row: Row | undefined, context: string): Row { if (!row) throw new Error(`Missing row after ${context}`); return row; }
function text(row: Row, key: string): string { const value = row[key]; return typeof value === 'string' ? value : String(value ?? ''); }
function dateOnly(row: Row, key: string): string {
  const value = row[key];
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new ApiError(422, 'INVALID_CNC_TELEGRAM_IMPORT_RANGE', 'Dates must use YYYY-MM-DD');
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return text(row, key).slice(0, 10);
}
function nullableText(row: Row, key: string): string | null { const value = row[key]; return value === null || value === undefined ? null : text(row, key); }
function number(row: Row, key: string): number { const value = row[key]; const parsed = typeof value === 'number' ? value : Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function nullableNumber(row: Row, key: string): number | null { const value = row[key]; return value === null || value === undefined ? null : number(row, key); }
function bool(row: Row, key: string): boolean { return row[key] === true || row[key] === 'true'; }
function json(row: Row, key: string): unknown { return row[key] ?? null; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function numberArray(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isInteger(item)) : []; }
function parseMatches(value: unknown): CncTelegramImportMatchDto[] { return Array.isArray(value) ? value.filter((item): item is CncTelegramImportMatchDto => Boolean(item && typeof item === 'object' && 'kind' in item)) : []; }
function sameMatches(left: CncTelegramImportMatchDto[], right: CncTelegramImportMatchDto[]): boolean { const key = (item: CncTelegramImportMatchDto) => `${item.kind}|${item.packetId ?? ''}|${item.cutJobId ?? ''}|${item.cutResultId ?? ''}`; return left.map(key).sort().join(',') === right.map(key).sort().join(','); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function scanDto(row: Row): CncTelegramImportScanDto { const from = dateOnly(row, 'date_from'); const to = dateOnly(row, 'date_to'); const daysProcessed = number(row, 'days_scanned'); const messagesScanned = number(row, 'messages_scanned'); const candidatesFound = number(row, 'candidates_found'); const warningsCount = number(row, 'warnings_count'); const truncated = bool(row, 'truncated'); return { scanId: text(row, 'scan_id'), sourceChatId: text(row, 'source_chat_id'), dateFrom: from, dateTo: to, businessTimezone: text(row, 'business_timezone'), status: text(row, 'status') as CncTelegramImportScanDto['status'], requestedAt: iso(row, 'created_at'), finishedAt: nullableIso(row, 'completed_at'), progress: { daysTotal: dateRangeDays(from, to), daysProcessed, messagesTotal: 5000, messagesProcessed: messagesScanned, candidatesTotal: candidatesFound, warningsTotal: warningsCount, truncated }, error: nullableText(row, 'error_message'), itemLeaseToken: nullableText(row, 'lease_token') ?? undefined, itemLeaseGeneration: number(row, 'lease_generation') || undefined, itemLeaseOwner: nullableText(row, 'worker_instance_id') ?? undefined, daysProcessed, messagesScanned, candidatesFound, warningsCount, truncated }; }
function candidateDto(row: Row, matches: CncTelegramImportMatchDto[]): CncTelegramImportCandidateDto { return { candidateId: text(row, 'candidate_id'), scanId: text(row, 'scan_id'), sourceChatId: text(row, 'source_chat_id'), sourceMessageId: number(row, 'source_message_id'), sourceThreadId: nullableNumber(row, 'source_thread_id'), sourceCreatedAt: nullableIso(row, 'source_created_at') ?? new Date(0).toISOString(), sourceUpdatedAt: nullableIso(row, 'source_updated_at'), workday: dateOnly(row, 'workday'), svgMessageId: nullableNumber(row, 'svg_message_id'), gcodeMessageId: nullableNumber(row, 'gcode_message_id'), screenshotMessageId: nullableNumber(row, 'screenshot_message_id'), svgFileName: text(row, 'svg_file_name'), gcodeFileName: nullableText(row, 'gcode_file_name'), screenshotFileName: nullableText(row, 'screenshot_file_name'), svgContentSha256: text(row, 'svg_content_sha256'), gcodeContentSha256: nullableText(row, 'gcode_content_sha256'), screenshotContentSha256: nullableText(row, 'screenshot_content_sha256'), sourceSetFingerprint: text(row, 'source_set_fingerprint'), parserVersion: text(row, 'parser_version'), layoutFingerprint: nullableText(row, 'layout_fingerprint'), parsedSnapshot: object(json(row, 'parsed_snapshot_json')), cutLayout: objectOrNull(json(row, 'cut_layout_json')), parserWarnings: arrayStrings(json(row, 'warnings_json')), sourceStatus: matches.length > 0 ? 'similar' : 'new', eligibility: text(row, 'eligibility_status') === 'valid' ? 'eligible' : 'ineligible', eligibilityReason: text(row, 'eligibility_status') === 'valid' ? null : text(row, 'eligibility_status'), duplicateMatchVersion: number(row, 'duplicate_match_version'), matches }; }
function requestDto(row: Row): CncTelegramImportRequestDto { return { importRequestId: text(row, 'import_request_id'), scanId: text(row, 'scan_id'), requestedBy: text(row, 'requested_by'), status: text(row, 'status') as CncTelegramImportRequestDto['status'], confirmationId: text(row, 'confirmation_id'), repeatOfImportRequestId: nullableText(row, 'repeat_of_import_request_id'), totalCount: number(row, 'selected_count'), importedCount: number(row, 'imported_count'), failedCount: number(row, 'failed_count'), items: [], error: nullableText(row, 'error_message'), selectionHash: text(row, 'selection_hash'), duplicateMatchVersion: number(row, 'duplicate_match_version') }; }
function itemDto(row: Row, matches: CncTelegramImportMatchDto[] = parseMatches(json(row, 'duplicate_snapshot_json'))): CncTelegramImportItemDto { const candidate = typeof row['svg_file_name'] === 'string' ? candidateDto({ ...row, duplicate_match_version: row['candidate_duplicate_match_version'] ?? row['duplicate_match_version'] }, matches) : undefined; return { importItemId: text(row, 'import_item_id'), candidateId: text(row, 'candidate_id'), status: text(row, 'status') as CncTelegramImportItemDto['status'], duplicateAcknowledged: bool(row, 'duplicate_acknowledged'), duplicateMatchVersion: number(row, 'duplicate_match_version'), duplicateSnapshot: matches, matches, packetId: nullableText(row, 'packet_id'), cutJobId: nullableNumber(row, 'cut_job_id'), cutResultId: nullableNumber(row, 'cut_result_id'), errorCode: nullableText(row, 'error_code'), errorMessage: nullableText(row, 'error_message'), itemLeaseToken: nullableText(row, 'lease_token') ?? undefined, itemLeaseGeneration: number(row, 'lease_generation'), itemLeaseOwner: nullableText(row, 'lease_worker_instance_id') ?? undefined, candidate }; }
function iso(row: Row, key: string): string { return new Date(text(row, key)).toISOString(); }
function nullableIso(row: Row, key: string): string | null { const value = row[key]; return value === null || value === undefined ? null : new Date(String(value)).toISOString(); }
function arrayStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []; }
function objectOrNull(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function toCutLayout(value: unknown): CncTelegramManualSvgUploadDto['cutLayout'] { const source = object(value); const sheetValue = objectOrNull(source.sheet); return { status: source.status === 'invalid' ? 'invalid' : 'valid', reasons: arrayStrings(source.reasons), sheet: sheetValue && typeof sheetValue.widthMm === 'number' && typeof sheetValue.heightMm === 'number' ? { widthMm: sheetValue.widthMm, heightMm: sheetValue.heightMm } : null, items: Array.isArray(source.items) ? source.items.filter((entry): entry is CncTelegramManualSvgUploadDto['cutLayout']['items'][number] => Boolean(entry && typeof entry === 'object')) : [] }; }

export function telegramImportItemsFromLayout(
  layout: CncTelegramManualSvgUploadDto['cutLayout'],
): CncTelegramStructuredIngestDto['items'] {
  return layout.items.map((item, index) => {
    const orderName = typeof item.orderName === 'string' ? item.orderName.trim() : '';
    const detailNumber = positiveInteger(item.detailNumber);
    const widthMm = positiveFinite(item.widthMm);
    const heightMm = positiveFinite(item.heightMm);
    const quantity = positiveInteger(item.quantity) ?? 1;
    if (!orderName || detailNumber === null || widthMm === null || heightMm === null) {
      throw new ApiError(
        422,
        'CNC_TELEGRAM_IMPORT_LAYOUT_INVALID',
        `Telegram SVG item ${index + 1} has incomplete order/detail/size identity`,
      );
    }
    return {
      sourceItemKey: [orderName, detailNumber, widthMm, heightMm, item.sourceElementId ?? index].join(':'),
      orderName,
      detailNumber,
      widthMm,
      heightMm,
      quantity,
      source: 'vector' as const,
      confidence: typeof item.confidence === 'number' && Number.isFinite(item.confidence)
        ? Math.max(0, Math.min(1, item.confidence))
        : 0.99,
      matchOrderId: null,
      matchDetailId: null,
      matchStatus: 'unmatched' as const,
      reviewNote: null,
    };
  });
}

export async function inferTelegramImportSelectedOrderIds(
  tx: TransactionClient,
  items: CncTelegramStructuredIngestDto['items'],
): Promise<number[]> {
  const orderKeys = [...new Set(items
    .map((item) => item.orderName.trim().toLowerCase())
    .filter(Boolean))];
  if (orderKeys.length === 0) return [];
  const result = await tx.query<{ order_id: string | number }>(`
    SELECT MIN(o.order_id)::bigint AS order_id
    FROM orders o
    WHERE lower(trim(o.order_name)) = ANY($1::text[])
      AND o.delete_flag = false
    GROUP BY lower(trim(o.order_name))
    HAVING COUNT(*) = 1
    ORDER BY MIN(o.order_id)
  `, [orderKeys]);
  if (result.rows.length !== orderKeys.length) return [];
  const orderIds = result.rows.map((row) => Number(row.order_id));
  if (
    orderIds.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    new Set(orderIds).size !== orderIds.length
  ) return [];
  return orderIds;
}

function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeRole(value: string): UserRole { return ['superadmin','admin','top_manager','manager','operator','worker','packer','viewer'].includes(value) ? value as UserRole : 'worker'; }
export function assertTerminalItemLeaseReplay(row: Row, replay: { itemLeaseToken: string; itemLeaseGeneration: number; itemLeaseOwner: string }, sourceChatId: string): void {
  if (
    text(row, 'source_chat_id') !== sourceChatId ||
    text(row, 'lease_token') !== replay.itemLeaseToken ||
    number(row, 'lease_generation') !== replay.itemLeaseGeneration ||
    text(row, 'lease_worker_instance_id') !== replay.itemLeaseOwner
  ) throw new ApiError(409, 'CNC_TELEGRAM_ITEM_LEASE_STALE', 'Terminal import replay does not match the original item lease');
}
function assertSourceMatches(row: Row, completion: CncTelegramImportCompleteDto): void { const source = completion.source; const checks: Array<[unknown, unknown]> = [[source.sourceChatId, text(row, 'source_chat_id')], [source.sourceMessageId, number(row, 'source_message_id')], [source.svgMessageId ?? null, nullableNumber(row, 'svg_message_id')], [source.gcodeMessageId ?? null, nullableNumber(row, 'gcode_message_id')], [source.screenshotMessageId ?? null, nullableNumber(row, 'screenshot_message_id')], [source.svgFileName, text(row, 'svg_file_name')], [source.gcodeFileName ?? null, nullableText(row, 'gcode_file_name')], [source.screenshotFileName ?? null, nullableText(row, 'screenshot_file_name')], [source.svgContentSha256, text(row, 'svg_content_sha256')], [source.gcodeContentSha256 ?? null, nullableText(row, 'gcode_content_sha256')], [source.screenshotContentSha256 ?? null, nullableText(row, 'screenshot_content_sha256')], [completion.sourceSetFingerprint, text(row, 'source_set_fingerprint')]]; if (checks.some(([left, right]) => left !== right)) throw new ApiError(409, 'CNC_TELEGRAM_SOURCE_CHANGED', 'Candidate source no longer matches the persisted source set'); }
async function updateRequestCounts(tx: TransactionClient, requestId: string): Promise<void> { await tx.query(`UPDATE cnc_telegram_import_requests r SET imported_count=(SELECT count(*) FROM cnc_telegram_import_items WHERE import_request_id=r.import_request_id AND status='imported'), failed_count=(SELECT count(*) FROM cnc_telegram_import_items WHERE import_request_id=r.import_request_id AND status='failed'), status=CASE WHEN (SELECT count(*) FROM cnc_telegram_import_items WHERE import_request_id=r.import_request_id AND status IN ('pending','processing','confirmation_required','unknown'))=0 THEN CASE WHEN (SELECT count(*) FROM cnc_telegram_import_items WHERE import_request_id=r.import_request_id AND status='imported')=r.selected_count THEN 'completed' ELSE 'partial' END ELSE 'processing' END, completed_at=CASE WHEN (SELECT count(*) FROM cnc_telegram_import_items WHERE import_request_id=r.import_request_id AND status IN ('pending','processing','confirmation_required','unknown'))=0 THEN COALESCE(completed_at,now()) ELSE completed_at END WHERE r.import_request_id=$1`, [requestId]); }
async function enqueueImportOutbox(tx: TransactionClient, eventType: string, aggregateId: string, requestId: string, payload: Record<string, unknown>): Promise<void> { await tx.query(`INSERT INTO outbox_events (event_type,aggregate_type,aggregate_id,payload_json,idempotency_key) VALUES ($1,'cnc_telegram_import',$2,$3::jsonb,$4) ON CONFLICT (idempotency_key) DO NOTHING`, [eventType, aggregateId, JSON.stringify({ ...payload, requestId }), `${eventType}:${aggregateId}:${requestId}`]); }
