import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  CUT_RENDER_STYLES_SETTING_KEY,
  CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
  resolveCutRenderStyle,
  resolveCutRenderStyleFromSetting,
  cutRenderNormalizeLabelLines,
  cutRenderPieceSizeLine,
  type CutRenderStyleRule,
} from '../../../shared/cut-render-style';
import { freecutItemId, type FreecutPlacement, type SheetPlacementsJson } from '../../cut/application/cut-freecut-mapping';
import { formatCutJobNumber, formatCutNumber } from '../../cut/application/cut-numbering';
import { allocateCutJobSourceDisplayNumber } from '../../cut/adapters/cut-job-display-number';
import type {
  CutGroupDto,
  CutJobDto,
  CutJobItemDto,
  CutJobTotals,
  CutSheetRenderSnapshotDto,
} from '../../cut/dto/cut.dto';
import {
  buildBathProfileSheetSvg,
  buildSheetSvg,
  composePieceLabelLines,
  createOrderFillResolver,
} from '../../cut/render/sheet-svg';
import {
  RENDER_PRESETS,
  enhanceRawSvgScreenshotContrast,
  renderRawSvgPng,
  renderSheetPng,
} from '../../cut/render/sheet-png';
import type {
  CncTelegramDeniedAuditPort,
  CncTelegramRepositoryPort,
  ConfigureCncAutoCutStatusCommand,
  CreateManualSvgCommentPresetCommand,
  IngestCncTelegramPacketCommand,
  ListManualSvgCommentPresetsCommand,
  ListCncTelegramOrderCuttingSequencesCommand,
  ListCncTelegramTodayCommand,
  ManualSvgUploadCommand,
  RecordCncTelegramDeniedAuditCommand,
} from '../application/cnc-telegram.types';
import type {
  CncAutoCutStatusConfigureResponseDto,
  CncTelegramBathCardDto,
  CncTelegramBathItemDto,
  CncTelegramBathSheetDto,
  CncTelegramBazisCutSetCardDto,
  CncTelegramBazisCutSetItemDto,
  CncTelegramCutLayoutDto,
  CncTelegramCutLayoutItemDto,
  CncTelegramDowelingLinkDto,
  CncTelegramIngestResponseDto,
  CncTelegramItemSource,
  CncTelegramManualSvgCommentPresetDto,
  CncTelegramManualSvgUploadFileDto,
  CncTelegramManualSvgUploadDto,
  CncTelegramManualSvgUploadResponseDto,
  CncTelegramMatchStatus,
  CncTelegramOrderCuttingSequenceDto,
  CncTelegramOrderCuttingSequencesResponseDto,
  CncTelegramPacketDto,
  CncTelegramPacketCutSheetDto,
  CncTelegramPacketItemDto,
  CncTelegramSkippedDuplicateSourceFileDto,
  CncTelegramSourceFileIdentityDto,
  CncTelegramStructuredIngestDto,
  CncTelegramTodayColumnDto,
  CncTelegramTodayResponseDto,
  CncTelegramToolDto,
} from '../dto/cnc-telegram.dto';
import {
  evaluateMdfBoardColumnAutomation,
  evaluateMdfOrderMachineFilesPresentAutomation,
  type MdfBoardColumnAutomationInput,
} from '../../status-automation/application/status-automation-runtime';
import {
  persistTelegramItemEvidence,
  projectTelegramLabelMap,
} from './cnc-telegram-label-map-projector';

const SOURCE = 'backend-cnc-telegram-command';
const COMMAND_NAME = 'cnc.telegram_packet.ingest';
const MANUAL_SVG_SOURCE = 'backend-manual-svg-upload-command';
const MANUAL_SVG_COMMAND_NAME = 'cnc.manual_svg_upload';
const MANUAL_SVG_CHAT_ID = 'erp-manual-svg-upload';
const MANUAL_SVG_EVENT = 'cnc.manual_svg_upload.created';
const MANUAL_SVG_COMPLETED_EVENT = 'cnc.manual_svg_upload.mdf_card_created';
const MANUAL_SVG_FILE_UPLOADED_EVENT = 'cnc.manual_svg_upload.file_uploaded';
const MANUAL_SVG_TELEGRAM_SEND_REQUESTED_EVENT = 'cnc.manual_svg_upload.telegram_send_requested';
const MANUAL_SVG_PRESET_COMMAND_NAME = 'cnc.manual_svg_comment_preset.create';
const MANUAL_SVG_PRESET_CREATE_EVENT = 'cnc.manual_svg_comment_preset.created';
const CNC_AUTO_CUT_STATUS_CONFIGURE_COMMAND = 'cnc.telegram_packet.auto_cut_status.configure';
const CNC_AUTO_CUT_STATUS_SETTING_KEY = 'status_automation.cnc_mark_cut_details';
const CNC_AUTO_CUT_STATUS_EVENT = 'cnc.telegram_packet.auto_cut_status_applied';
const CNC_AUTO_CUT_STATUS_CONFIGURE_EVENT = 'cnc.telegram_packet.auto_cut_status_configured';
const IGNORED_ANALYSIS_WARNINGS = new Set([
  'RapidOCR found text, but no detail rows with order and size',
]);

interface PacketJoinedRow extends QueryResultRow {
  packet_id: string;
  external_packet_key: string;
  cutting_sequence_no: string | number | null;
  source_chat_id: string;
  source_message_id: string | number | null;
  source_thread_id: string | number | null;
  source_version: string | number;
  source_created_at: string | Date | null;
  source_updated_at: string | Date | null;
  workday: string | Date;
  machine: string | null;
  program_name: string | null;
  material_name: string;
  sheet_image_storage_key: string | null;
  sheet_image_content_type: string | null;
  sheet_image_size_bytes: string | number | null;
  parse_status: CncTelegramPacketDto['parseStatus'];
  completion_status: CncTelegramPacketDto['completionStatus'];
  thumbs_up: boolean;
  completed_at: string | Date | null;
  rework: boolean;
  comments_json: unknown;
  tools_json: unknown;
  doweling_links_json: unknown;
  analysis_warnings_json: unknown;
  ocr_engine: string | null;
  parser_version: string;
  cut_layout_json: unknown;
  svg_cut_job_id: string | number | null;
  svg_cut_job_display_number: string | number | null;
  svg_cut_result_id: string | number | null;
  svg_cut_result_no: string | number | null;
  svg_cut_import_status: 'none' | 'skipped' | 'needs_review' | 'imported' | null;
  svg_cut_import_note: string | null;
  svg_cut_sheets_json: unknown;
  updated_at: string | Date;
  packet_item_id: string | null;
  source_item_key: string | null;
  order_name: string | null;
  item_order_id: string | number | null;
  order_delete_flag: boolean | null;
  detail_number: string | number | null;
  width_mm: string | number | null;
  height_mm: string | number | null;
  quantity: string | number | null;
  item_source: CncTelegramItemSource | null;
  confidence: string | number | null;
  match_order_id: string | number | null;
  match_detail_id: string | number | null;
  match_status: CncTelegramMatchStatus | null;
  review_note: string | null;
  laminated_or_later: boolean | null;
  all_linked_order_details_packed_or_later: boolean | null;
}

interface PacketReplayRow extends QueryResultRow {
  packet_id: string;
  source_version: string | number;
  payload_hash: string;
  cutting_sequence_no: string | number | null;
  completion_status: CncTelegramPacketDto['completionStatus'];
  thumbs_up: boolean;
}

interface CncAutoCutSettingRow extends QueryResultRow {
  is_active: boolean;
  value_json: unknown;
}

interface CncAutoCutStatusRow extends QueryResultRow {
  production_status_id: string | number;
  production_status_name: string;
  production_status_code: string | null;
  sort_order: string | number;
}

interface CncAutoCutTargetRow extends QueryResultRow {
  order_id: string | number;
  detail_id: string | number;
}

interface CncAutoCutOrderRow extends QueryResultRow {
  order_id: string | number;
  order_name: string;
  client_id: string | number | null;
  version: string | number;
  production_status_id: string | number | null;
  production_status_from_details_enabled: boolean;
}

interface CncAutoCutDetailRow extends QueryResultRow {
  order_id: string | number;
  detail_id: string | number;
  production_status_id: string | number | null;
}

interface CncAutoCutCurrentStatusRow extends QueryResultRow {
  production_status_id: string | number;
  sort_order: string | number | null;
}

interface CncAutoCutBackfillCandidateRow extends QueryResultRow {
  completed_packet_count: string | number;
  matched_detail_ids: unknown;
  matched_order_ids: unknown;
}

interface CncAutoCutBackfillCommentRow extends QueryResultRow {
  comments_json: unknown;
  items_json: unknown;
}

interface CncAutoCutApplyResult {
  changedOrderIds: number[];
  changedDetailIds: number[];
  changedDetailIdsByOrder: Map<number, number[]>;
  bumpedOrders: CncAutoCutOrderRow[];
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  response_json:
    | CncTelegramIngestResponseDto
    | CncTelegramManualSvgUploadResponseDto
    | CncTelegramManualSvgCommentPresetDto
    | CncAutoCutStatusConfigureResponseDto
    | string
    | null;
  status: 'processing' | 'completed' | 'failed';
}

interface CurrentDateRow extends QueryResultRow {
  workday: string | Date;
}

interface ManualSvgCommentPresetRow extends QueryResultRow {
  preset_id: string | number;
  label: string;
  comment_text: string;
  category: CncTelegramManualSvgCommentPresetDto['category'];
  is_active: boolean;
  sort_order: string | number;
  version: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface BathJoinedRow extends QueryResultRow {
  cut_result_id: string | number;
  cut_job_id: string | number;
  source_display_number: string | number | null;
  result_no: string | number;
  revision_no: string | number;
  result_created_at: string | Date;
  cut_job_name: string | null;
  order_id: string | number;
  order_detail_id: string | number;
  order_name: string | null;
  detail_number: string | number | null;
  width_mm: string | number | null;
  height_mm: string | number | null;
  completed_quantity: string | number | null;
  laminated_or_later: boolean | null;
  packed_or_later: boolean | null;
  cut_group_id: string | number;
  variant: 'auto' | 'manual';
  sheet_index: string | number;
  sheet_ordinal: string | number;
  sheet_width_mm: string | number | null;
  sheet_height_mm: string | number | null;
}

interface BathColumnAutomationRow extends QueryResultRow {
  order_id: string | number;
  order_detail_id: string | number;
  quantity: string | number;
  completed_quantity: string | number | null;
  laminated_or_later: boolean | null;
}

interface BazisCutSetJoinedRow extends QueryResultRow {
  bazis_cut_set_id: string | number;
  name: string;
  created_at: string | Date;
  sort_order: string | number;
  source_order_detail_id: string | number | null;
  source_order_id: string | number | null;
  source_order_name: string | null;
  source_order_deleted: boolean | null;
  detail_number: string | number | null;
  width_mm: string | number | null;
  height_mm: string | number | null;
  material_name: string | null;
  quantity: string | number;
  packed_or_later: boolean | null;
}

interface OrderCuttingSequenceRow extends QueryResultRow {
  packet_id: string;
  external_packet_key: string;
  cutting_sequence_no: string | number;
  source_message_id: string | number | null;
  workday: string | Date;
  program_name: string | null;
  material_name: string;
  completion_status: CncTelegramPacketDto['completionStatus'];
  source_created_at: string | Date | null;
  item_quantity_total: string | number | null;
}

interface ManualSvgCommentPresetRow extends QueryResultRow {
  preset_id: string | number;
  label: string;
  comment_text: string;
  category: CncTelegramManualSvgCommentPresetDto['category'];
  is_active: boolean;
  sort_order: string | number;
  version: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface DetailMatchRow extends QueryResultRow {
  order_key: string;
  order_id: string | number;
  detail_id: string | number;
  detail_number: string | number | null;
  width: string | number | null;
  height: string | number | null;
}

type IngestItemInput = CncTelegramStructuredIngestDto['items'][number];

interface ManualSvgOrderScopeDetailRow extends QueryResultRow {
  order_id: string | number;
  order_name: string | null;
  detail_id: string | number;
  detail_number: string | number | null;
  width: string | number | null;
  height: string | number | null;
  quantity: string | number | null;
}

interface ManualSvgSelectedOrderRow extends QueryResultRow {
  order_id: string | number;
  order_name: string | null;
}

interface ManualSvgSelectedOrder {
  orderId: number;
  orderName: string | null;
}

interface ManualSvgOrderScopeDetail {
  orderId: number;
  orderName: string | null;
  detailId: number;
  detailNumber: number | null;
  width: number | null;
  height: number | null;
  quantity: number;
}

interface ManualSvgOrderScopeProblem {
  kind: 'unmatched' | 'outside_scope';
  severity: 'error';
  key: string;
  title: string;
  reason: string;
  orderName: string;
  detailNumber: number | null;
  widthMm: number | null;
  heightMm: number | null;
  quantity: number;
}

interface ManualSvgItemGroup {
  key: string;
  orderName: string;
  detailNumber: number | null;
  widthMm: number | null;
  heightMm: number | null;
  quantity: number;
  matchOrderIds: number[];
  matchDetailIds: number[];
  hasUnmatched: boolean;
}

interface DetailMatch {
  orderKey: string;
  orderId: number;
  detailId: number;
  detailNumber: number | null;
  width: number | null;
  height: number | null;
}

interface ManualSvgDecodedUploadFile {
  kind: CncTelegramManualSvgUploadFileDto['kind'];
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  raw: Buffer;
  generated: boolean;
}

interface ManualSvgStoredFile {
  fileId: string;
  kind: CncTelegramManualSvgUploadFileDto['kind'];
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  generated: boolean;
  expiresAt: string;
}

interface ManualSvgFilePersistenceResult {
  storedFileCount: number;
  telegramSendRequestId: string | null;
  telegramSendStatus: 'pending' | 'processing' | 'sent' | 'failed' | 'unknown' | null;
}

export class PgCncTelegramRepository
  implements CncTelegramRepositoryPort, CncTelegramDeniedAuditPort
{
  constructor(private readonly database: DatabaseService) {}

  async listToday(command: ListCncTelegramTodayCommand): Promise<CncTelegramTodayResponseDto> {
    const workday =
      command.workday ??
      command.workdayTo ??
      await currentDatabaseWorkday(this.database);
    const workdayFrom = command.workdayFrom ?? workday;
    const workdayTo = command.workdayTo ?? workday;
    const rows = await this.database.query<PacketJoinedRow>(
      packetSelectSql(`
        p.workday BETWEEN $1::date AND $2::date
        AND p.mdf_board_hidden_at IS NULL
        AND (
          p.source_chat_id IS DISTINCT FROM $3
          OR EXISTS (
            SELECT 1
            FROM outbox_events manual_svg_mdf_card
            WHERE manual_svg_mdf_card.idempotency_key =
              'cnc-manual-svg:' || p.packet_id::text || ':source-' || p.source_version::text || ':mdf-card-created'
          )
        )
      `),
      [workdayFrom, workdayTo, MANUAL_SVG_CHAT_ID],
    );
    const packets = mapPacketRows(rows.rows);
    const baths = await loadBathCards(this.database, workdayFrom, workdayTo);
    const bazisCutSets = await loadPeriodBazisCutSetCards(
      this.database,
      workdayFrom,
      workdayTo,
    );
    return {
      workday: workdayTo,
      generatedAt: new Date().toISOString(),
      columns: buildTodayColumns(packets, baths, bazisCutSets),
    };
  }

  async listOrderCuttingSequences(
    command: ListCncTelegramOrderCuttingSequencesCommand,
  ): Promise<CncTelegramOrderCuttingSequencesResponseDto> {
    const result = await this.database.query<OrderCuttingSequenceRow>(
      `
      WITH unique_order_keys AS (
        SELECT
          lower(trim(o.order_name)) AS order_key,
          MIN(o.order_id)::bigint AS order_id
        FROM orders o
        WHERE o.delete_flag = false
          AND NULLIF(trim(o.order_name), '') IS NOT NULL
        GROUP BY lower(trim(o.order_name))
        HAVING COUNT(*) = 1
      )
      SELECT
        p.packet_id,
        p.external_packet_key,
        p.cutting_sequence_no,
        p.source_message_id,
        p.workday,
        p.program_name,
        p.material_name,
        p.completion_status,
        p.source_created_at,
        SUM(GREATEST(i.quantity, 0))::integer AS item_quantity_total
      FROM cnc_telegram_packets p
      JOIN cnc_telegram_packet_items i ON i.packet_id = p.packet_id
      LEFT JOIN unique_order_keys order_key
        ON order_key.order_key = lower(trim(i.order_name))
      WHERE p.cutting_sequence_no IS NOT NULL
        AND COALESCE(i.match_order_id, order_key.order_id) = $1::bigint
      GROUP BY
        p.packet_id,
        p.external_packet_key,
        p.cutting_sequence_no,
        p.source_message_id,
        p.workday,
        p.program_name,
        p.material_name,
        p.completion_status,
        p.source_created_at
      ORDER BY p.cutting_sequence_no DESC, p.source_created_at DESC NULLS LAST, p.packet_id
      `,
      [command.orderId],
    );
    return {
      orderId: command.orderId,
      sequences: result.rows.map(mapOrderCuttingSequenceRow),
    };
  }

  async ingest(command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = command.requestId || 'cnc-telegram-ingest';
      const incomingPayloadHash = hashPayload(command.dto);
      const replayResponse = await reconcileIdempotency(tx, {
        dto: command.dto,
        currentUserId: command.currentUser.id,
        payloadHash: incomingPayloadHash,
      });
      if (replayResponse) return replayResponse;

      let payloadHash = incomingPayloadHash;
      let effectiveCommand = command;
      const exactExisting = await loadPacketReplayByExternalKey(tx, command.dto.externalPacketKey);
      const existing = exactExisting ?? await findRelatedSvgPacketAlias(tx, command.dto);

      if (existing && command.dto.svgImportMode?.refreshImported === true) {
        const refreshSourceVersion = Math.max(
          command.dto.source.version,
          Number(existing.source_version) + 1,
        );
        effectiveCommand = withPacketReplaySourceVersion(command, refreshSourceVersion, existing);
        payloadHash = hashPayload(effectiveCommand.dto);
      }

      if (!exactExisting && existing && command.dto.svgImportMode?.refreshImported !== true) {
        const existingSourceVersion = Number(existing.source_version);
        const replayCommand = withPacketReplaySourceVersion(command, existingSourceVersion, existing);
        const replayPayloadHash = hashPayload(replayCommand.dto);
        if (replayPayloadHash === existing.payload_hash) {
          effectiveCommand = replayCommand;
          payloadHash = replayPayloadHash;
        } else if (command.dto.source.version <= existingSourceVersion) {
          effectiveCommand = withPacketReplaySourceVersion(command, existingSourceVersion + 1, existing);
          payloadHash = hashPayload(effectiveCommand.dto);
        } else {
          effectiveCommand = withPacketReplaySourceVersion(command, command.dto.source.version, existing);
        }
      }

      if (existing && effectiveCommand.dto.source.version < Number(existing.source_version)) {
        const skippedExistingSourceFile = await skipExistingTelegramSvgCutJobForSourceFile(
          tx,
          existing.packet_id,
          effectiveCommand.dto,
        );
        if (!skippedExistingSourceFile) {
          await ensureCuttingSequenceNo(tx, existing.packet_id, effectiveCommand.dto, Number(command.currentUser.id));
        }
        const packet = await loadPacket(tx, existing.packet_id);
        const response: CncTelegramIngestResponseDto = {
          packet,
          requestId,
          applied: false,
          ignoredStaleSourceVersion: true,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

      if (
        existing &&
        effectiveCommand.dto.source.version === Number(existing.source_version) &&
        existing.payload_hash !== payloadHash
      ) {
        await failIdempotency(tx, effectiveCommand.dto.idempotencyKey);
        throw new ApiError(
          409,
          'SOURCE_VERSION_CONFLICT',
          'Telegram source version already exists with different parsed payload',
          {
            externalPacketKey: effectiveCommand.dto.externalPacketKey,
            sourceVersion: effectiveCommand.dto.source.version,
          },
        );
      }

      await lockSvgSourceFileIfPresent(tx, effectiveCommand.dto);
      const skippedDuplicateSourceFileResponse = await skippedExistingTelegramSvgSourceFileResponse(
        tx,
        effectiveCommand.dto,
        requestId,
        existing?.packet_id ?? null,
      );
      if (skippedDuplicateSourceFileResponse) {
        await completeIdempotency(tx, command.dto.idempotencyKey, skippedDuplicateSourceFileResponse);
        return skippedDuplicateSourceFileResponse;
      }

      if (
        existing &&
        effectiveCommand.dto.source.version === Number(existing.source_version) &&
        existing.payload_hash === payloadHash
      ) {
        const matchedDto = await resolveItemMatches(tx, effectiveCommand.dto);
        const resolvedDto = aggregateMatchedItems(matchedDto);
        await assertMatchedDetailsBelongToOrders(tx, matchedDto);
        await persistTelegramItemEvidence(tx, {
          packetId: existing.packet_id,
          sourceVersion: effectiveCommand.dto.source.version,
          payloadHash,
          dto: matchedDto,
          source: 'authoritative_replay',
          context: {
            actorUserId: command.currentUser.id,
            actorUsername: command.currentUser.username,
            actorRole: command.currentUser.role,
            requestId,
          },
        });
        await ensureStoredCutLayout(tx, existing.packet_id, effectiveCommand.dto.cutLayout ?? null);
        const svgImportOptions = svgImportOptionsFromDto(effectiveCommand.dto);
        const skippedExistingSourceFile = svgImportOptions.refreshImported
          ? false
          : await skipExistingTelegramSvgCutJobForSourceFile(tx, existing.packet_id, resolvedDto);
        if (!skippedExistingSourceFile) {
          await ensureCuttingSequenceNo(tx, existing.packet_id, resolvedDto, Number(command.currentUser.id));
          await syncSvgCutImport(tx, existing.packet_id, resolvedDto, matchedDto, effectiveCommand.currentUser.id, svgImportOptions);
        }
        await projectTelegramLabelMap(tx, {
          packetId: existing.packet_id,
          source: 'ingest',
          context: {
            actorUserId: command.currentUser.id,
            actorUsername: command.currentUser.username,
            actorRole: command.currentUser.role,
            requestId,
          },
        });
        const packet = await loadPacket(tx, existing.packet_id);
        const response: CncTelegramIngestResponseDto = {
          packet,
          requestId,
          applied: false,
          ignoredStaleSourceVersion: false,
        };
        await completeIdempotency(tx, command.dto.idempotencyKey, response);
        return response;
      }

      const matchedDto = await resolveItemMatches(tx, effectiveCommand.dto);
      const resolvedDto = aggregateMatchedItems(matchedDto);
      const resolvedCommand = resolvedDto === effectiveCommand.dto ? effectiveCommand : { ...effectiveCommand, dto: resolvedDto };
      await assertMatchedDetailsBelongToOrders(tx, matchedDto);

      const packetId = existing?.packet_id ?? await insertPacket(tx, resolvedCommand, payloadHash);
      if (existing) {
        await updatePacket(tx, packetId, resolvedCommand, payloadHash);
      }
      await persistTelegramItemEvidence(tx, {
        packetId,
        sourceVersion: effectiveCommand.dto.source.version,
        payloadHash,
        dto: matchedDto,
        source: 'ingest',
        context: {
          actorUserId: command.currentUser.id,
          actorUsername: command.currentUser.username,
          actorRole: command.currentUser.role,
          requestId,
        },
      });
      await replaceItems(tx, packetId, resolvedDto);
      const svgImportOptions = svgImportOptionsFromDto(effectiveCommand.dto);
      const skippedExistingSourceFile = svgImportOptions.refreshImported
        ? false
        : await skipExistingTelegramSvgCutJobForSourceFile(tx, packetId, resolvedDto);
      if (!skippedExistingSourceFile) {
        await ensureCuttingSequenceNo(tx, packetId, resolvedDto, Number(command.currentUser.id));
        await syncSvgCutImport(tx, packetId, resolvedDto, matchedDto, command.currentUser.id, svgImportOptions);
      }
      await projectTelegramLabelMap(tx, {
        packetId,
        source: 'ingest',
        context: {
          actorUserId: command.currentUser.id,
          actorUsername: command.currentUser.username,
          actorRole: command.currentUser.role,
          requestId,
        },
      });

      const packet = await loadPacket(tx, packetId);
      const auditId = await writeIngestAudit(tx, {
        command: resolvedCommand,
        packet,
        requestId,
        previousSourceVersion: existing ? Number(existing.source_version) : null,
      });
      // A newer revision of an already-completed packet can add matches, quantities, or
      // a verified whole-order comment. Reconcile every completed revision; updates are idempotent.
      if (packetIsCompleted(packet)) {
        await applyCompletedPacketAutoCutStatus(tx, {
          command: resolvedCommand,
          packet,
          requestId,
          packetAuditId: auditId,
        });
        await evaluateMdfBoardColumnAutomation(tx, {
          eventType: 'mdf.board.completed',
          orderIds: packet.items.map((item) => item.orderId ?? item.matchOrderId),
          actor: command.currentUser,
          requestId,
          sourceIdempotencyKey: `cnc-telegram-packet:${packet.packetId}:source-${packet.sourceVersion}:mdf-board-completed`,
        });
      }
      await evaluateMdfBoardBathColumnAutomationForPacket(tx, {
        packet,
        actor: command.currentUser,
        requestId,
      });
      if (packetColumnKey(packet) === 'parsed') {
        await evaluateMdfOrderMachineFilesPresentAutomation(tx, {
          orderIds: packet.items.map((item) => item.orderId),
          actor: command.currentUser,
          requestId,
          sourceIdempotencyKey: `cnc-telegram-packet:${packet.packetId}:source-${packet.sourceVersion}:machine-files`,
        });
      }
      await enqueuePacketEvents(tx, resolvedCommand, packet, requestId, auditId);

      const response: CncTelegramIngestResponseDto = {
        packet,
        requestId,
        auditId,
        applied: true,
        ignoredStaleSourceVersion: false,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  async manualSvgUpload(command: ManualSvgUploadCommand): Promise<CncTelegramManualSvgUploadResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = command.requestId || 'cnc-manual-svg-upload';
      const dto = buildManualSvgStructuredDto(command.dto);
      await lockSvgSourceFileIfPresent(tx, dto);
      const payloadHash = hashPayload(manualSvgSourcePayloadDto(dto));
      const replayResponse = await reconcileManualSvgUploadIdempotency(tx, {
        command,
        dto,
        payloadHash,
      });
      if (replayResponse) return replayResponse;

      const replay = await tx.query<PacketReplayRow>(
        `
        SELECT packet_id, source_version, payload_hash, cutting_sequence_no, completion_status, thumbs_up
        FROM cnc_telegram_packets
        WHERE external_packet_key = $1
        FOR UPDATE
        `,
        [dto.externalPacketKey],
      );
      const existing = replay.rows[0] ?? null;

      if (existing && dto.source.version < Number(existing.source_version)) {
        const packet = await loadPacket(tx, existing.packet_id);
        const response = manualSvgResponse({
          packet,
          requestId,
          applied: false,
          ignoredStaleSourceVersion: true,
        }, false);
        await completeIdempotency(tx, dto.idempotencyKey, response);
        return response;
      }

      if (
        existing &&
        dto.source.version === Number(existing.source_version) &&
        existing.payload_hash !== payloadHash
      ) {
        await failIdempotency(tx, dto.idempotencyKey);
        throw new ApiError(
          409,
          'MANUAL_SVG_SOURCE_CONFLICT',
          'Manual SVG upload key already exists with different parsed payload',
          { externalPacketKey: dto.externalPacketKey },
        );
      }

      if (
        existing &&
        dto.source.version === Number(existing.source_version) &&
        existing.payload_hash === payloadHash
      ) {
        const prepared = await prepareManualSvgUploadDto(tx, dto, command.dto);
        const { resolvedDto, matchSourceDto } = prepared;
        await ensureStoredCutLayout(tx, existing.packet_id, dto.cutLayout ?? null);
        await ensureCuttingSequenceNo(tx, existing.packet_id, resolvedDto, Number(command.currentUser.id));
        await syncSvgCutImport(tx, existing.packet_id, resolvedDto, matchSourceDto, command.currentUser.id, {
          requestedCutJobId: command.dto.requestedCutJobId ?? null,
          matchMode: command.dto.matchMode,
          validationMode: command.dto.validationMode,
          selectedOrderIds: command.dto.selectedOrderIds,
        });
        await projectTelegramLabelMap(tx, {
          packetId: existing.packet_id,
          source: 'ingest',
          context: {
            actorUserId: command.currentUser.id,
            actorUsername: command.currentUser.username,
            actorRole: command.currentUser.role,
            requestId,
          },
        });
        const packet = await loadPacket(tx, existing.packet_id);
        let mdfCardCreatedAuditId: string | undefined;
        let mdfCardCreatedNow = false;
        if (command.dto.createMdfMachineFileCard) {
          assertManualSvgMachineFileCardReady(packet);
          if (!await manualSvgMdfCardEventExists(tx, packet)) {
            mdfCardCreatedAuditId = await writeManualSvgMdfCardAudit(tx, {
              command,
              beforePacket: null,
              packet,
              requestId,
              externalPacketKey: dto.externalPacketKey,
            });
            await enqueueManualSvgMdfCardEvent(tx, {
              command,
              packet,
              requestId,
              auditId: mdfCardCreatedAuditId,
              externalPacketKey: dto.externalPacketKey,
            });
            mdfCardCreatedNow = true;
          }
        }
        const filePersistence = await persistManualSvgUploadFiles(tx, {
          command,
          packet,
          requestId,
          externalPacketKey: dto.externalPacketKey,
        });
        await evaluateMdfBoardBathColumnAutomationForPacket(tx, {
          packet,
          actor: command.currentUser,
          requestId,
        });
        if (command.dto.createMdfMachineFileCard && packetColumnKey(packet) === 'parsed') {
          await evaluateMdfOrderMachineFilesPresentAutomation(tx, {
            orderIds: packet.items.map((item) => item.orderId),
            actor: command.currentUser,
            requestId,
            sourceIdempotencyKey: `cnc-manual-svg:${packet.packetId}:source-${packet.sourceVersion}:machine-files`,
          });
        }
        const response = manualSvgResponse({
          packet,
          requestId,
          auditId: mdfCardCreatedAuditId,
          applied: false,
          ignoredStaleSourceVersion: false,
        }, mdfCardCreatedNow, filePersistence);
        await completeIdempotency(tx, dto.idempotencyKey, response);
        return response;
      }

      const prepared = await prepareManualSvgUploadDto(tx, dto, command.dto);
      const { resolvedDto, matchSourceDto } = prepared;
      const resolvedCommand: IngestCncTelegramPacketCommand = {
        currentUser: command.currentUser,
        dto: resolvedDto,
        requestId,
      };

      const packetId = await insertPacket(tx, resolvedCommand, payloadHash);
      await replaceItems(tx, packetId, resolvedDto);
      await ensureCuttingSequenceNo(tx, packetId, resolvedDto, Number(command.currentUser.id));
      await syncSvgCutImport(tx, packetId, resolvedDto, matchSourceDto, command.currentUser.id, {
        requestedCutJobId: command.dto.requestedCutJobId ?? null,
        matchMode: command.dto.matchMode,
        validationMode: command.dto.validationMode,
        selectedOrderIds: command.dto.selectedOrderIds,
      });
      await projectTelegramLabelMap(tx, {
        packetId,
        source: 'ingest',
        context: {
          actorUserId: command.currentUser.id,
          actorUsername: command.currentUser.username,
          actorRole: command.currentUser.role,
          requestId,
        },
      });

      let mdfCardAuditId: string | undefined;
      let mdfCardCreatedNow = false;
      const packet = await loadPacket(tx, packetId);
      if (command.dto.createMdfMachineFileCard) {
        assertManualSvgMachineFileCardReady(packet);
      }
      const auditId = await writeManualSvgCreatedAudit(tx, {
        command,
        packet,
        requestId,
        externalPacketKey: dto.externalPacketKey,
      });
      if (command.dto.createMdfMachineFileCard) {
        mdfCardAuditId = await writeManualSvgMdfCardAudit(tx, {
          command,
          beforePacket: null,
          packet,
          requestId,
          externalPacketKey: dto.externalPacketKey,
        });
        mdfCardCreatedNow = true;
      }
      await enqueueManualSvgCreatedEvent(tx, {
        command,
        packet,
        requestId,
        auditId,
        externalPacketKey: dto.externalPacketKey,
      });
      if (mdfCardCreatedNow) {
        await enqueueManualSvgMdfCardEvent(tx, {
          command,
          packet,
          requestId,
          auditId: mdfCardAuditId ?? auditId,
          externalPacketKey: dto.externalPacketKey,
        });
      }
      const filePersistence = await persistManualSvgUploadFiles(tx, {
        command,
        packet,
        requestId,
        externalPacketKey: dto.externalPacketKey,
      });
      await evaluateMdfBoardBathColumnAutomationForPacket(tx, {
        packet,
        actor: command.currentUser,
        requestId,
      });
      if (command.dto.createMdfMachineFileCard && packetColumnKey(packet) === 'parsed') {
        await evaluateMdfOrderMachineFilesPresentAutomation(tx, {
          orderIds: packet.items.map((item) => item.orderId),
          actor: command.currentUser,
          requestId,
          sourceIdempotencyKey: `cnc-manual-svg:${packet.packetId}:source-${packet.sourceVersion}:machine-files`,
        });
      }

      const response = manualSvgResponse({
        packet,
        requestId,
        auditId,
        applied: true,
        ignoredStaleSourceVersion: false,
      }, mdfCardCreatedNow, filePersistence);
      await completeIdempotency(tx, dto.idempotencyKey, response);
      return response;
    });
  }

  async listManualSvgCommentPresets(
    _command: ListManualSvgCommentPresetsCommand,
  ): Promise<CncTelegramManualSvgCommentPresetDto[]> {
    const result = await this.database.query<ManualSvgCommentPresetRow>(
      `
      SELECT preset_id, label, comment_text, category, is_active, sort_order,
             version, created_at, updated_at
      FROM cnc_manual_svg_comment_presets
      WHERE is_active = true
      ORDER BY category, sort_order, label, preset_id
      `,
    );
    return result.rows.map(mapManualSvgCommentPreset);
  }

  async createManualSvgCommentPreset(
    command: CreateManualSvgCommentPresetCommand,
  ): Promise<CncTelegramManualSvgCommentPresetDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = command.requestId || 'cnc-manual-svg-comment-preset-create';
      const input = {
        label: normalizeRequired(command.dto.label),
        commentText: normalizeRequired(command.dto.commentText),
        category: command.dto.category ?? 'custom',
        sortOrder: command.dto.sortOrder ?? 500,
      };
      const requestHash = hashRequest({
        actorUserId: command.currentUser.id,
        commandName: MANUAL_SVG_PRESET_COMMAND_NAME,
        label: input.label,
        commentText: input.commentText,
        category: input.category,
        sortOrder: input.sortOrder,
      });
      const replay = await reconcileManualSvgPresetIdempotency(tx, {
        idempotencyKey: command.idempotencyKey,
        currentUserId: command.currentUser.id,
        entityId: input.commentText.toLowerCase(),
        requestHash,
      });
      if (replay) return replay;

      const inserted = await tx.query<ManualSvgCommentPresetRow>(
        `
        INSERT INTO cnc_manual_svg_comment_presets (
          label, comment_text, category, sort_order, created_by, updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT DO NOTHING
        RETURNING preset_id, label, comment_text, category, is_active, sort_order,
                  version, created_at, updated_at
        `,
        [
          input.label,
          input.commentText,
          input.category,
          input.sortOrder,
          toNullableNumber(command.currentUser.id),
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        await failIdempotency(tx, command.idempotencyKey);
        throw new ApiError(
          409,
          'MANUAL_SVG_COMMENT_PRESET_DUPLICATE',
          'Manual SVG comment preset already exists',
          { commentText: input.commentText },
        );
      }

      const preset = mapManualSvgCommentPreset(row);
      const presetSnapshot = manualSvgPresetSnapshot(preset);
      const auditId = await auditService.record(tx, {
        event: MANUAL_SVG_PRESET_CREATE_EVENT,
        entityType: 'cnc_manual_svg_comment_preset',
        entityId: preset.presetId,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username ?? null,
        actorRole: command.currentUser.role ?? null,
        requestId,
        source: MANUAL_SVG_SOURCE,
        before: null,
        after: presetSnapshot,
        diff: { created: true },
        metadata: {
          source: MANUAL_SVG_SOURCE,
          action: 'manual_svg_comment_preset_create',
          category: preset.category,
          requestId,
        },
      });
      await enqueueOutbox(tx, {
        eventType: MANUAL_SVG_PRESET_CREATE_EVENT,
        aggregateType: 'cnc_manual_svg_comment_preset',
        aggregateId: String(preset.presetId),
        idempotencyKey: `${MANUAL_SVG_PRESET_CREATE_EVENT}:${preset.presetId}:v${preset.version}`,
        payload: {
          eventType: MANUAL_SVG_PRESET_CREATE_EVENT,
          actorUserId: command.currentUser.id,
          requestId,
          auditId,
          presetId: preset.presetId,
          category: preset.category,
        },
      });
      await completeIdempotency(tx, command.idempotencyKey, preset);
      return preset;
    });
  }

  async configureAutoCutStatus(
    command: ConfigureCncAutoCutStatusCommand,
  ): Promise<CncAutoCutStatusConfigureResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = command.requestId || 'cnc-auto-cut-status-configure';
      const replay = await reconcileCncAutoCutStatusConfigureIdempotency(tx, command);
      if (replay) return replay;

      await lockCncAutoCutStatus(tx);
      const previousSettingEnabled = await cncAutoCutStatusEnabled(tx);
      const targetStatus = command.enabled
        ? await loadCncAutoCutProductionStatus(tx)
        : null;
      if (command.enabled && !targetStatus) {
        throw new ApiError(
          409,
          'CNC_AUTO_CUT_STATUS_NOT_FOUND',
          'Активный производственный статус «Распилен» не найден',
        );
      }

      await saveCncAutoCutStatusSetting(tx, command.enabled, Number(command.currentUser.id));

      let completedPacketCount = 0;
      let matchedDetailIds: number[] = [];
      let matchedOrderIds: number[] = [];
      let wholeOrderIds: number[] = [];
      let applied = emptyCncAutoCutApplyResult();
      if (command.enabled && targetStatus) {
        const candidates = await loadCncAutoCutBackfillCandidates(tx);
        completedPacketCount = candidates.completedPacketCount;
        matchedDetailIds = candidates.matchedDetailIds;
        matchedOrderIds = candidates.matchedOrderIds;
        wholeOrderIds = candidates.wholeOrderIds;
        applied = await applyCncAutoCutStatusCandidates(tx, {
          matchedDetailIds,
          matchedOrderIds,
          wholeOrderIds,
          targetStatus,
        });
      }

      const auditId = await writeCncAutoCutStatusConfigureAudit(tx, {
        command,
        requestId,
        previousSettingEnabled,
        targetStatus,
        completedPacketCount,
        matchedDetailIds,
        wholeOrderIds,
        applied,
      });
      await enqueueCncAutoCutStatusConfigureEvent(tx, {
        command,
        requestId,
        auditId,
        completedPacketCount,
        matchedDetailIds,
        wholeOrderIds,
        applied,
      });

      const counts = cncAutoCutStatusConfigureCounts({
        completedPacketCount,
        matchedDetailIds,
        wholeOrderIds,
        applied,
      });
      const response: CncAutoCutStatusConfigureResponseDto = {
        settingEnabled: command.enabled,
        requestId,
        auditId,
        ...counts,
      };
      await completeIdempotency(tx, command.idempotencyKey, response);
      return response;
    });
  }

  async recordIngestDenied(command: RecordCncTelegramDeniedAuditCommand): Promise<void> {
    const entityType = command.event === 'cnc.manual_svg_comment_preset.create_denied'
      ? 'cnc_manual_svg_comment_preset'
      : command.event === 'cnc.manual_svg_upload.denied'
        ? 'cnc_manual_svg_upload'
        : 'cnc_telegram_packet';
    await auditService.recordDenied(this.database, {
      event: command.event,
      entityType,
      entityId: command.externalPacketKey ?? 'unknown',
      actorUserId: command.currentUser.id,
      actorUsername: command.currentUser.username ?? null,
      actorRole: command.currentUser.role ?? null,
      requestId: command.requestId ?? 'cnc-telegram-ingest-denied',
      source: command.event.startsWith('cnc.manual_svg') ? MANUAL_SVG_SOURCE : SOURCE,
      reason: command.reason,
      requiredPermissions: command.requiredPermissions,
      metadata: {
        externalPacketKey: command.externalPacketKey ?? null,
      },
    });
  }

  async recordAutoCutStatusConfigureDenied(
    command: RecordCncTelegramDeniedAuditCommand,
  ): Promise<void> {
    await auditService.recordDenied(this.database, {
      event: command.event,
      entityType: 'app_setting',
      entityId: CNC_AUTO_CUT_STATUS_SETTING_KEY,
      actorUserId: command.currentUser.id,
      actorUsername: command.currentUser.username ?? null,
      actorRole: command.currentUser.role ?? null,
      requestId: command.requestId ?? 'cnc-auto-cut-status-configure-denied',
      source: SOURCE,
      reason: command.reason,
      requiredPermissions: command.requiredPermissions,
      metadata: { settingKey: CNC_AUTO_CUT_STATUS_SETTING_KEY },
    });
  }

  async recordWorkerAuditWriteDenied(command: RecordCncTelegramDeniedAuditCommand): Promise<void> {
    await auditService.recordDenied(this.database, {
      event: command.event,
      entityType: 'cnc_telegram_worker_audit',
      entityId: 'batch',
      actorUserId: command.currentUser.id,
      actorUsername: command.currentUser.username ?? null,
      actorRole: command.currentUser.role ?? null,
      requestId: command.requestId ?? 'cnc-telegram-worker-audit-write-denied',
      source: SOURCE,
      reason: command.reason,
      requiredPermissions: command.requiredPermissions,
      metadata: {},
    });
  }
}

function buildManualSvgStructuredDto(
  dto: ManualSvgUploadCommand['dto'],
): CncTelegramStructuredIngestDto {
  return {
    idempotencyKey: dto.idempotencyKey,
    externalPacketKey: manualSvgExternalPacketKey(dto),
    source: {
      chatId: MANUAL_SVG_CHAT_ID,
      version: 1,
    },
    workday: dto.workday,
    machine: normalizeOptional(dto.machine) ?? 'manual-svg-upload',
    programName: normalizeOptional(dto.programName) ?? `SVG ${dto.svgContentHash.slice(0, 12)}`,
    materialName: normalizeOptional(dto.materialName) ?? 'МДФ 16мм',
    parseStatus: 'parsed',
    completionStatus: 'pending',
    thumbsUp: false,
    rework: dto.rework === true,
    comments: dto.comments ?? [],
    tools: dto.tools ?? [],
    analysisWarnings: manualSvgAnalysisWarnings(dto),
    ocrEngine: null,
    parserVersion: normalizeOptional(dto.parserVersion) ?? 'erp-manual-svg-upload-v1',
    sourceFiles: manualSvgUploadSourceFileIdentities(dto.sourceFiles ?? []),
    cutLayout: dto.cutLayout,
    items: dto.items.map((item) => ({
      ...item,
      matchOrderId: null,
      matchDetailId: null,
      matchStatus: 'unmatched' as const,
      reviewNote: null,
    })),
  };
}

function manualSvgAnalysisWarnings(dto: ManualSvgUploadCommand['dto']): string[] {
  const warnings: string[] = [];
  if (dto.matchMode === 'informational') {
    warnings.push('Информативный SVG: размеры взяты из файла, сверка с деталями ERP отключена');
  }
  if (dto.validationMode === 'lenient') {
    warnings.push('Нестрогий режим SVG: ошибки валидации не блокировали создание раскроя');
    if (dto.cutLayout.reasons.length > 0) {
      warnings.push(truncateText(`Ошибки SVG: ${dto.cutLayout.reasons.join('; ')}`, 500));
    }
  }
  return warnings;
}

function manualSvgExternalPacketKey(dto: ManualSvgUploadCommand['dto']): string {
  const identityHash = sha256Json({
    kind: 'erp-manual-svg-upload-v1',
    matchMode: dto.matchMode,
    validationMode: dto.validationMode,
    selectedOrderIds: [...dto.selectedOrderIds].sort((a, b) => a - b),
    requestedCutJobId: dto.requestedCutJobId ?? null,
    svgContentHash: dto.svgContentHash.toLowerCase(),
    workday: dto.workday ?? null,
    machine: normalizeOptional(dto.machine),
    programName: normalizeOptional(dto.programName),
    materialName: normalizeOptional(dto.materialName),
    rework: dto.rework === true,
    comments: dto.comments ?? [],
    tools: dto.tools ?? [],
    parserVersion: normalizeOptional(dto.parserVersion),
    cutLayout: dto.cutLayout,
    items: dto.items,
  });
  return `erp-svg-upload:${identityHash}`;
}

function manualSvgSourcePayloadDto(dto: CncTelegramStructuredIngestDto): CncTelegramStructuredIngestDto {
  const { sourceFiles: _sourceFiles, ...payloadDto } = dto;
  return {
    ...payloadDto,
    completionStatus: 'pending',
    thumbsUp: false,
  };
}

function manualSvgUploadSourceFileIdentities(
  files: CncTelegramManualSvgUploadFileDto[],
): CncTelegramSourceFileIdentityDto[] {
  return files
    .map((file) => ({
      kind: file.kind,
      fileName: sanitizeManualSvgFileName(file.fileName),
      contentType: normalizeOptional(file.contentType),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256.toLowerCase(),
    }))
    .filter((file) =>
      (file.kind === 'svg' || file.kind === 'gcode' || file.kind === 'screenshot') &&
      normalizeOptional(file.fileName) !== null &&
      /^[a-f0-9]{64}$/.test(file.sha256) &&
      Number.isInteger(file.sizeBytes) &&
      file.sizeBytes > 0
    );
}

async function prepareManualSvgUploadDto(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
  manualDto: CncTelegramManualSvgUploadDto,
): Promise<{
  resolvedDto: CncTelegramStructuredIngestDto;
  matchSourceDto: CncTelegramStructuredIngestDto;
}> {
  if (manualDto.matchMode === 'informational') {
    const selectedOrders = await assertManualSvgSelectedOrdersExist(tx, manualDto.selectedOrderIds);
    const informationalDto = buildInformationalManualSvgDto(dto, selectedOrders);
    return { resolvedDto: informationalDto, matchSourceDto: informationalDto };
  }

  const matchedDto = await resolveItemMatches(tx, dto, {
    orderIds: manualDto.selectedOrderIds,
    tolerantSizeMm: 8,
  });
  if (manualDto.validationMode === 'lenient') {
    await assertManualSvgSelectedOrdersExist(tx, manualDto.selectedOrderIds);
    return { resolvedDto: matchedDto, matchSourceDto: matchedDto };
  }
  await assertManualSvgOrderScope(tx, manualDto.selectedOrderIds, matchedDto);
  const resolvedDto = aggregateMatchedItems(matchedDto);
  await assertMatchedDetailsBelongToOrders(tx, resolvedDto);
  return { resolvedDto, matchSourceDto: matchedDto };
}

function buildInformationalManualSvgDto(
  dto: CncTelegramStructuredIngestDto,
  selectedOrders: ManualSvgSelectedOrder[],
): CncTelegramStructuredIngestDto {
  const orders = selectedOrders.length > 0 ? selectedOrders : [{ orderId: 0, orderName: null }];
  return {
    ...dto,
    items: dto.items.map((item, index) => {
      const order = informationalOrderForItem(item, index, orders);
      return {
        ...item,
        orderName: informationalOrderNameForItem(item, order),
        matchOrderId: order.orderId > 0 ? order.orderId : null,
        matchDetailId: null,
        matchStatus: 'needs_review',
        reviewNote: 'Информативный SVG: связь с деталями ERP не требуется',
      };
    }),
  };
}

function informationalOrderForItem(
  item: IngestItemInput,
  index: number,
  selectedOrders: ManualSvgSelectedOrder[],
): ManualSvgSelectedOrder {
  const itemOrderKey = normalizeOrderKey(item.orderName);
  const exact = itemOrderKey
    ? selectedOrders.find((order) => (
        normalizeOrderKey(order.orderName) === itemOrderKey ||
        String(order.orderId) === item.orderName.trim()
      ))
    : null;
  return exact ?? selectedOrders[index % selectedOrders.length] ?? selectedOrders[0]!;
}

function informationalOrderNameForItem(
  item: IngestItemInput,
  order: ManualSvgSelectedOrder,
): string {
  const current = normalizeOptional(item.orderName);
  if (current && current !== 'SVG' && !current.includes('+')) {
    const currentKey = normalizeOrderKey(current);
    if (
      currentKey &&
      (currentKey === normalizeOrderKey(order.orderName) || current.trim() === String(order.orderId))
    ) {
      return current;
    }
  }
  return normalizeOptional(order.orderName) ?? String(order.orderId);
}

async function assertManualSvgOrderScope(
  tx: TransactionClient,
  selectedOrderIds: number[],
  dto: CncTelegramStructuredIngestDto,
): Promise<void> {
  await assertManualSvgSelectedOrdersExist(tx, selectedOrderIds);

  const selectedDetails = await loadManualSvgSelectedOrderDetails(tx, selectedOrderIds);
  const problems = buildManualSvgOrderScopeProblems(selectedOrderIds, dto.items, selectedDetails);
  const unmatched = problems.filter((problem) => problem.kind === 'unmatched');
  if (unmatched.length > 0) {
    throw new ApiError(
      422,
      'MANUAL_SVG_UNMATCHED_DETAILS',
      'Не все детали SVG найдены в выбранных заказах',
      {
        problems: unmatched.slice(0, 50),
      },
    );
  }

  const outsideScope = problems.filter((problem) => problem.kind === 'outside_scope');
  if (outsideScope.length > 0) {
    throw new ApiError(
      422,
      'MANUAL_SVG_ORDER_SCOPE_MISMATCH',
      'В SVG есть детали из заказов, которые не выбраны',
      {
        selectedOrderIds,
        problems: outsideScope.slice(0, 50),
      },
    );
  }
}

async function assertManualSvgSelectedOrdersExist(
  tx: TransactionClient,
  selectedOrderIds: number[],
): Promise<ManualSvgSelectedOrder[]> {
  const orderRows = await tx.query<ManualSvgSelectedOrderRow>(
    `
    SELECT order_id, order_name
    FROM orders
    WHERE order_id = ANY($1::bigint[])
      AND delete_flag = false
    `,
    [selectedOrderIds],
  );
  const existing = new Set(orderRows.rows.map((row) => toNumber(row.order_id)));
  const missing = selectedOrderIds.filter((orderId) => !existing.has(orderId));
  if (missing.length > 0) {
    throw new ApiError(
      422,
      'MANUAL_SVG_SELECTED_ORDER_NOT_FOUND',
      'Selected SVG upload orders do not exist or are deleted',
      { orderIds: missing },
    );
  }

  const byId = new Map(orderRows.rows.map((row) => [toNumber(row.order_id), row.order_name]));
  return selectedOrderIds.map((orderId) => ({
    orderId,
    orderName: byId.get(orderId) ?? null,
  }));
}

async function inferTelegramSvgSelectedOrderIds(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
  layout: CncTelegramCutLayoutDto,
): Promise<number[]> {
  const matchedIds = uniqueValues(
    dto.items
      .map((item) => item.matchStatus === 'matched' ? toPositiveInteger(item.matchOrderId) : null)
      .filter(isPositiveNumber),
  );
  if (matchedIds.length > 0) return matchedIds;

  const orderKeys = uniqueValues(
    [
      ...dto.items.map((item) => normalizeOrderKey(item.orderName)),
      ...(layout.items ?? []).map((item) => normalizeOrderKey(item.orderName)),
    ].filter((value): value is string => Boolean(value)),
  );
  if (orderKeys.length === 0) return [];

  const result = await tx.query<{ order_id: string | number }>(
    `
    SELECT MIN(o.order_id)::bigint AS order_id
    FROM orders o
    WHERE lower(trim(o.order_name)) = ANY($1::text[])
      AND o.delete_flag = false
    GROUP BY lower(trim(o.order_name))
    HAVING COUNT(*) = 1
    ORDER BY MIN(o.order_id)
    `,
    [orderKeys],
  );
  return uniqueValues(result.rows.map((row) => toNumber(row.order_id)).filter(isPositiveNumber));
}

async function loadManualSvgSelectedOrderDetails(
  tx: TransactionClient,
  selectedOrderIds: number[],
): Promise<ManualSvgOrderScopeDetail[]> {
  if (selectedOrderIds.length === 0) return [];
  const result = await tx.query<ManualSvgOrderScopeDetailRow>(
    `
    SELECT
      o.order_id,
      o.order_name,
      od.detail_id,
      od.detail_number,
      od.width,
      od.height,
      od.quantity
    FROM orders o
    JOIN order_details od ON od.order_id = o.order_id
    WHERE o.order_id = ANY($1::bigint[])
      AND o.delete_flag = false
      AND od.delete_flag = false
    ORDER BY o.order_id, od.detail_number NULLS LAST, od.detail_id
    `,
    [selectedOrderIds],
  );
  return result.rows.flatMap((row) => {
    const orderId = toPositiveInteger(row.order_id);
    const detailId = toPositiveInteger(row.detail_id);
    if (orderId === null || detailId === null) return [];
    return [{
      orderId,
      orderName: row.order_name,
      detailId,
      detailNumber: toNullablePositiveInteger(row.detail_number),
      width: toNullableFiniteNumber(row.width),
      height: toNullableFiniteNumber(row.height),
      quantity: Math.max(0, Math.floor(toNullableFiniteNumber(row.quantity) ?? 0)),
    }];
  });
}

function buildManualSvgOrderScopeProblems(
  selectedOrderIds: number[],
  items: CncTelegramStructuredIngestDto['items'],
  selectedDetails: ManualSvgOrderScopeDetail[],
): ManualSvgOrderScopeProblem[] {
  const allowedOrderIds = new Set(selectedOrderIds);
  const detailsByOrderKey = new Map<string, ManualSvgOrderScopeDetail[]>();
  for (const detail of selectedDetails) {
    const key = normalizeOrderKey(detail.orderName);
    if (!key) continue;
    const bucket = detailsByOrderKey.get(key) ?? [];
    bucket.push(detail);
    detailsByOrderKey.set(key, bucket);
  }

  const problems: ManualSvgOrderScopeProblem[] = [];
  for (const group of groupManualSvgItems(items)) {
    const outsideOrderIds = group.matchOrderIds.filter((orderId) => !allowedOrderIds.has(orderId));
    if (outsideOrderIds.length > 0) {
      problems.push(manualSvgOrderScopeProblem(
        'outside_scope',
        group,
        `Деталь найдена в заказе #${outsideOrderIds[0]}, но этот заказ не выбран для загрузки`,
      ));
      continue;
    }
    const matchedInside = group.matchOrderIds.some((orderId) => allowedOrderIds.has(orderId))
      && group.matchDetailIds.length > 0
      && !group.hasUnmatched;
    if (matchedInside) continue;

    const orderKey = normalizeOrderKey(group.orderName);
    const sameOrder = orderKey ? detailsByOrderKey.get(orderKey) ?? [] : [];
    if (sameOrder.length === 0) {
      problems.push(manualSvgOrderScopeProblem(
        'unmatched',
        group,
        `Заказ ${group.orderName || '(пусто)'} не найден среди выбранных заказов, удален или номер заказа в SVG отличается от ERP`,
      ));
      continue;
    }
    if (group.detailNumber === null) {
      problems.push(manualSvgOrderScopeProblem(
        'unmatched',
        group,
        `В SVG не найден номер детали. В заказе есть детали: ${manualSvgDetailNumbersPreview(sameOrder)}`,
      ));
      continue;
    }

    const sameDetailNumber = sameOrder.filter((detail) => detail.detailNumber === group.detailNumber);
    if (sameDetailNumber.length === 0) {
      problems.push(manualSvgOrderScopeProblem(
        'unmatched',
        group,
        `В заказе ${group.orderName} нет детали #${group.detailNumber}. Есть детали: ${manualSvgDetailNumbersPreview(sameOrder)}`,
      ));
      continue;
    }
    if (group.widthMm === null || group.heightMm === null) {
      problems.push(manualSvgOrderScopeProblem(
        'unmatched',
        group,
        `В SVG не найден размер детали. В ERP для #${group.detailNumber}: ${manualSvgDetailSizesPreview(sameDetailNumber)}`,
      ));
      continue;
    }

    const sameSize = sameDetailNumber.filter((detail) => manualSvgDetailSizeMatches(group, detail));
    if (sameSize.length === 0) {
      problems.push(manualSvgOrderScopeProblem(
        'unmatched',
        group,
        `Размер в SVG ${formatMmPair(group.widthMm, group.heightMm)} не совпал с ERP. В ERP: ${manualSvgDetailSizesPreview(sameDetailNumber)}`,
      ));
      continue;
    }
    const availableQuantity = sameSize.reduce((sum, detail) => sum + detail.quantity, 0);
    if (group.quantity > availableQuantity) {
      problems.push(manualSvgOrderScopeProblem(
        'unmatched',
        group,
        `Количество в SVG ${group.quantity}, в выбранных заказах доступно ${availableQuantity}`,
      ));
      continue;
    }
    if (sameSize.length > 1 || group.hasUnmatched) {
      problems.push(manualSvgOrderScopeProblem(
        'unmatched',
        group,
        `Найдено несколько возможных деталей в ERP: ${manualSvgDetailIdsPreview(sameSize)}. Нужно уточнить номер/размер в заказе или SVG`,
      ));
    }
  }
  return problems;
}

function groupManualSvgItems(items: CncTelegramStructuredIngestDto['items']): ManualSvgItemGroup[] {
  const groups = new Map<string, ManualSvgItemGroup>();
  for (const item of items) {
    const key = [
      normalizeOrderKey(item.orderName) ?? '',
      item.detailNumber ?? '',
      manualSvgDimensionKey(item.widthMm),
      manualSvgDimensionKey(item.heightMm),
    ].join(':');
    const existing = groups.get(key);
    const group = existing ?? {
      key,
      orderName: item.orderName,
      detailNumber: item.detailNumber ?? null,
      widthMm: item.widthMm ?? null,
      heightMm: item.heightMm ?? null,
      quantity: 0,
      matchOrderIds: [],
      matchDetailIds: [],
      hasUnmatched: false,
    };
    group.quantity += Math.max(1, item.quantity ?? 1);
    if (isPositiveNumber(item.matchOrderId) && !group.matchOrderIds.includes(item.matchOrderId)) {
      group.matchOrderIds.push(item.matchOrderId);
    }
    if (isPositiveNumber(item.matchDetailId) && !group.matchDetailIds.includes(item.matchDetailId)) {
      group.matchDetailIds.push(item.matchDetailId);
    }
    if (
      item.matchStatus !== 'matched' ||
      !isPositiveNumber(item.matchOrderId) ||
      !isPositiveNumber(item.matchDetailId)
    ) {
      group.hasUnmatched = true;
    }
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function manualSvgOrderScopeProblem(
  kind: ManualSvgOrderScopeProblem['kind'],
  group: ManualSvgItemGroup,
  reason: string,
): ManualSvgOrderScopeProblem {
  return {
    kind,
    severity: 'error',
    key: `${group.key}:${kind}`,
    title: manualSvgItemGroupTitle(group),
    reason,
    orderName: group.orderName,
    detailNumber: group.detailNumber,
    widthMm: group.widthMm,
    heightMm: group.heightMm,
    quantity: group.quantity,
  };
}

function manualSvgItemGroupTitle(group: ManualSvgItemGroup): string {
  const detail = group.detailNumber === null ? 'деталь без номера' : `деталь #${group.detailNumber}`;
  const size = group.widthMm !== null && group.heightMm !== null
    ? ` ${formatMmPair(group.widthMm, group.heightMm)}`
    : '';
  const quantity = group.quantity > 1 ? `, ${group.quantity} шт.` : '';
  return `${group.orderName || 'без заказа'} ${detail}${size}${quantity}`;
}

function manualSvgDetailNumbersPreview(details: ManualSvgOrderScopeDetail[]): string {
  const values = uniqueValues(details.map((detail) => detail.detailNumber)).filter(isPositiveNumber);
  return values.length > 0 ? values.slice(0, 20).map((value) => `#${value}`).join(', ') : 'нет номеров деталей';
}

function manualSvgDetailSizesPreview(details: ManualSvgOrderScopeDetail[]): string {
  const values = uniqueValues(details.map((detail) => (
    detail.width !== null && detail.height !== null
      ? `${formatMmPair(detail.width, detail.height)}${detail.quantity > 1 ? `, ${detail.quantity} шт.` : ''}`
      : 'размер не заполнен'
  )));
  return values.slice(0, 12).join(', ');
}

function manualSvgDetailIdsPreview(details: ManualSvgOrderScopeDetail[]): string {
  return details.slice(0, 12).map((detail) => `#${detail.detailId}`).join(', ');
}

function manualSvgDetailSizeMatches(
  group: Pick<ManualSvgItemGroup, 'widthMm' | 'heightMm'>,
  detail: ManualSvgOrderScopeDetail,
): boolean {
  if (group.widthMm === null || group.heightMm === null || detail.width === null || detail.height === null) {
    return false;
  }
  return closeEnoughSize(group.widthMm, group.heightMm, detail.width, detail.height, 8)
    || closeEnoughSize(group.widthMm, group.heightMm, detail.height, detail.width, 8);
}

function manualSvgDimensionKey(value: number | null | undefined): string {
  return value === null || value === undefined ? 'null' : String(round3(value));
}

function formatMmPair(width: number, height: number): string {
  return `${formatMm(width)}x${formatMm(height)} мм`;
}

function formatMm(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round3(value));
}

function manualSvgResponse(
  response: CncTelegramIngestResponseDto,
  createdMdfMachineFileCard: boolean,
  files: ManualSvgFilePersistenceResult = {
    storedFileCount: 0,
    telegramSendRequestId: null,
    telegramSendStatus: null,
  },
): CncTelegramManualSvgUploadResponseDto {
  const cutJobId = response.packet.svgCutJobId ?? null;
  const cutResultId = response.packet.svgCutResultId ?? null;
  return {
    ...response,
    cutJobId,
    cutJobDisplayNumber: response.packet.svgCutJobDisplayNumber ?? null,
    cutResultId,
    cutJobPath: cutJobId ? `/cut?job=${cutJobId}` : null,
    createdMdfMachineFileCard,
    storedFileCount: files.storedFileCount,
    telegramSendRequestId: files.telegramSendRequestId,
    telegramSendStatus: files.telegramSendStatus,
  };
}

function manualSvgHasImportedCut(packet: CncTelegramPacketDto): boolean {
  return packet.svgCutImportStatus === 'imported' &&
    packet.svgCutJobId != null &&
    manualSvgCutJobDisplayNumber(packet) !== null;
}

function manualSvgCutJobDisplayNumber(packet: CncTelegramPacketDto): string | null {
  return normalizeOptional(packet.svgCutJobDisplayNumber ?? null);
}

function assertManualSvgMachineFileCardReady(packet: CncTelegramPacketDto): void {
  if (manualSvgHasImportedCut(packet)) return;
  throw new ApiError(
    422,
    'MANUAL_SVG_CUT_IMPORT_NOT_READY',
    'Manual SVG upload must import into a cut job before creating an MDF machine-file card',
    {
      packetId: packet.packetId,
      svgCutImportStatus: packet.svgCutImportStatus,
      svgCutImportNote: packet.svgCutImportNote,
      svgCutJobId: packet.svgCutJobId ?? null,
      svgCutJobDisplayNumber: packet.svgCutJobDisplayNumber ?? null,
    },
  );
}

function assertManualSvgTelegramCutJobReady(packet: CncTelegramPacketDto): void {
  if (manualSvgHasImportedCut(packet)) return;
  throw new ApiError(
    422,
    'MANUAL_SVG_TELEGRAM_CUT_JOB_REQUIRED',
    'Перед отправкой в Telegram SVG должен быть разобран и привязан к реальному заданию на раскрой с номером',
    {
      packetId: packet.packetId,
      svgCutImportStatus: packet.svgCutImportStatus,
      svgCutImportNote: packet.svgCutImportNote,
      svgCutJobId: packet.svgCutJobId ?? null,
      svgCutJobDisplayNumber: packet.svgCutJobDisplayNumber ?? null,
    },
  );
}

async function manualSvgMdfCardEventExists(
  tx: TransactionClient,
  packet: CncTelegramPacketDto,
): Promise<boolean> {
  const result = await tx.query<{ exists: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM outbox_events
      WHERE idempotency_key = $1
    ) AS "exists"
    `,
    [manualSvgMdfCardEventKey(packet)],
  );
  return result.rows[0]?.exists === true;
}

function manualSvgMdfCardEventKey(packet: CncTelegramPacketDto): string {
  return `cnc-manual-svg:${packet.packetId}:source-${packet.sourceVersion}:mdf-card-created`;
}

async function persistManualSvgUploadFiles(
  tx: TransactionClient,
  input: {
    command: ManualSvgUploadCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    externalPacketKey: string;
  },
): Promise<ManualSvgFilePersistenceResult> {
  const renderStyle = await loadManualSvgUploadRenderStyle(tx);
  const decodedFiles = prepareManualSvgUploadFiles(input.command.dto, renderStyle);
  if (decodedFiles.length === 0) {
    if (input.command.dto.telegramSend?.enabled) {
      throw new ApiError(422, 'MANUAL_SVG_TELEGRAM_FILES_REQUIRED', 'Для отправки в Telegram нужен SVG-файл');
    }
    return { storedFileCount: 0, telegramSendRequestId: null, telegramSendStatus: null };
  }

  const stored: ManualSvgStoredFile[] = [];
  const activeTelegramSend = await lockActiveManualSvgTelegramSend(tx, input.packet.packetId);
  if (activeTelegramSend?.status === 'processing') {
    throw new ApiError(
      409,
      'MANUAL_SVG_TELEGRAM_SEND_IN_PROGRESS',
      'Предыдущая отправка файлов раскроя в Telegram ещё выполняется',
      { packetId: input.packet.packetId, requestId: activeTelegramSend.requestId },
    );
  }
  for (const file of decodedFiles) {
    const row = await tx.query<{ file_id: string; expires_at: string | Date }>(
      `INSERT INTO cnc_manual_svg_upload_files (
         packet_id, file_kind, original_file_name, content_type, content_sha256,
         size_bytes, content_bytes, generated, created_by
       )
       VALUES ($1::uuid, $2, $3, $4, $5, $6::bigint, $7, $8, $9)
       ON CONFLICT (packet_id, file_kind) DO UPDATE
       SET original_file_name=EXCLUDED.original_file_name,
           content_type=EXCLUDED.content_type,
           content_sha256=EXCLUDED.content_sha256,
           size_bytes=EXCLUDED.size_bytes,
           content_bytes=EXCLUDED.content_bytes,
           generated=EXCLUDED.generated,
           created_by=EXCLUDED.created_by,
           updated_at=now(),
           expires_at=now() + interval '30 days'
       RETURNING file_id, expires_at`,
      [
        input.packet.packetId,
        file.kind,
        file.fileName,
        file.contentType,
        file.sha256,
        file.sizeBytes,
        file.raw,
        file.generated,
        Number(input.command.currentUser.id),
      ],
    );
    const fileId = row.rows[0]?.file_id;
    const expiresAt = row.rows[0]?.expires_at;
    if (!fileId || !expiresAt) throw new Error('manual SVG upload file insert returned no row');
    const storedFile: ManualSvgStoredFile = {
      fileId,
      kind: file.kind,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      generated: file.generated,
      expiresAt: toIso(expiresAt),
    };
    stored.push(storedFile);
    await tx.query('DELETE FROM cnc_manual_svg_upload_file_orders WHERE file_id=$1::uuid', [fileId]);
    await linkManualSvgFileOrders(tx, fileId, input.command.dto.selectedOrderIds);
    await writeManualSvgFileUploadedAudit(tx, {
      ...input,
      file: storedFile,
    });
  }

  const send = await enqueueManualSvgTelegramSendRequest(tx, {
    ...input,
    files: stored,
  });
  return {
    storedFileCount: stored.length,
    telegramSendRequestId: send?.requestId ?? null,
    telegramSendStatus: send?.status ?? null,
  };
}

async function lockActiveManualSvgTelegramSend(
  tx: TransactionClient,
  packetId: string,
): Promise<{ requestId: string; status: ManualSvgFilePersistenceResult['telegramSendStatus'] } | null> {
  const active = await tx.query<{ request_id: string; status: ManualSvgFilePersistenceResult['telegramSendStatus'] }>(
    `SELECT request_id, status
     FROM cnc_manual_svg_telegram_send_requests
     WHERE packet_id=$1::uuid
       AND status IN ('pending', 'processing')
     ORDER BY requested_at DESC, request_id DESC
     LIMIT 1
     FOR UPDATE`,
    [packetId],
  );
  const row = active.rows[0];
  return row ? { requestId: row.request_id, status: row.status } : null;
}

function prepareManualSvgUploadFiles(
  dto: CncTelegramManualSvgUploadDto,
  renderStyle: CutRenderStyleRule,
): ManualSvgDecodedUploadFile[] {
  const files = (dto.sourceFiles ?? []).map(decodeManualSvgUploadFile);
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.kind)) {
      throw new ApiError(422, 'MANUAL_SVG_DUPLICATE_FILE_KIND', 'Нельзя загрузить несколько файлов одного типа', {
        kind: file.kind,
      });
    }
    seen.add(file.kind);
  }
  const svg = files.find((file) => file.kind === 'svg');
  if (svg && !files.some((file) => file.kind === 'screenshot')) {
    const screenshot = renderManualSvgScreenshot(dto, svg, renderStyle);
    files.push(screenshot);
  }
  return files.sort((left, right) => manualSvgFileKindOrder(left.kind) - manualSvgFileKindOrder(right.kind));
}

function decodeManualSvgUploadFile(file: CncTelegramManualSvgUploadFileDto): ManualSvgDecodedUploadFile {
  const raw = Buffer.from(file.base64Content, 'base64');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (raw.length !== file.sizeBytes || sha256 !== file.sha256.toLowerCase()) {
    throw new ApiError(422, 'MANUAL_SVG_FILE_CONTENT_MISMATCH', 'Содержимое файла не совпадает с размером или SHA-256', {
      kind: file.kind,
      fileName: file.fileName,
    });
  }
  assertManualSvgDecodedFileSafe(file.kind, file.fileName, file.contentType, raw);
  return {
    kind: file.kind,
    fileName: sanitizeManualSvgFileName(file.fileName),
    contentType: file.contentType.trim(),
    sizeBytes: raw.length,
    sha256,
    raw,
    generated: false,
  };
}

function assertManualSvgDecodedFileSafe(
  kind: CncTelegramManualSvgUploadFileDto['kind'],
  fileName: string,
  contentType: string,
  raw: Buffer,
): void {
  if (kind === 'svg') {
    const text = raw.toString('utf8');
    if (!/<svg[\s>]/i.test(text)) {
      throw new ApiError(422, 'MANUAL_SVG_FILE_INVALID', 'Загруженный SVG-файл не содержит SVG-разметку', { fileName });
    }
    if (/<script\b|<foreignObject\b|(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|file:|data:)/i.test(text)) {
      throw new ApiError(422, 'MANUAL_SVG_FILE_UNSAFE', 'SVG содержит внешние ссылки или активное содержимое', { fileName });
    }
  }
  if (kind === 'screenshot' && !imageMagicMatchesContentType(raw, contentType)) {
    throw new ApiError(422, 'MANUAL_SVG_SCREENSHOT_INVALID', 'Формат изображения не совпадает с типом файла', { fileName });
  }
}

function imageMagicMatchesContentType(raw: Buffer, contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  if (normalized === 'image/png') {
    return raw.length > 8 &&
      raw[0] === 0x89 &&
      raw[1] === 0x50 &&
      raw[2] === 0x4e &&
      raw[3] === 0x47;
  }
  if (normalized === 'image/jpeg') {
    return raw.length > 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff;
  }
  if (normalized === 'image/webp') {
    return raw.length > 12 && raw.subarray(0, 4).toString('ascii') === 'RIFF' && raw.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function renderManualSvgScreenshot(
  dto: CncTelegramManualSvgUploadDto,
  svg: ManualSvgDecodedUploadFile,
  renderStyle: CutRenderStyleRule,
): ManualSvgDecodedUploadFile {
  const styledSvg = buildManualSvgScreenshotSvg(dto, renderStyle);
  const png = styledSvg && dto.cutLayout.sheet
    ? enhanceRawSvgScreenshotContrast(
        renderSheetPng({
          svg: styledSvg,
          targetPx: RENDER_PRESETS.screen,
          sheetWidthMm: dto.cutLayout.sheet.widthMm,
          sheetHeightMm: dto.cutLayout.sheet.heightMm,
        }),
        dto.generatedScreenshot?.contrast,
      )
    : renderRawSvgPng({
        svg: svg.raw.toString('utf8'),
        targetPx: RENDER_PRESETS.screen,
        sheetWidthMm: dto.cutLayout.sheet?.widthMm ?? null,
        sheetHeightMm: dto.cutLayout.sheet?.heightMm ?? null,
        contrast: dto.generatedScreenshot?.contrast,
        renderStyle,
      });
  const sha256 = createHash('sha256').update(png).digest('hex');
  return {
    kind: 'screenshot',
    fileName: `${manualSvgFileBaseName(svg.fileName)}.png`,
    contentType: 'image/png',
    sizeBytes: png.length,
    sha256,
    raw: png,
    generated: true,
  };
}

function buildManualSvgScreenshotSvg(
  dto: CncTelegramManualSvgUploadDto,
  renderStyle: CutRenderStyleRule,
): string | null {
  const sheet = dto.cutLayout.sheet;
  if (!sheet || dto.cutLayout.items.length === 0) return null;
  const sourceByKey = new Map(dto.items.map((item) => [item.sourceItemKey, item]));
  const nextInstance = new Map<string, number>();
  const pieces: SheetPlacementsJson['pieces'] = dto.cutLayout.items.map((item, index) => {
    const sourceItem = sourceByKey.get(manualSvgLayoutSourceKey(item, index));
    const detailId = sourceItem?.matchDetailId ?? null;
    const itemId = detailId ? freecutItemId(detailId) : `manual-svg-${index + 1}`;
    const instance = (nextInstance.get(itemId) ?? 0) + 1;
    nextInstance.set(itemId, instance);
    const orderId = sourceItem?.matchOrderId ?? parseManualSvgNumericOrderName(item.orderName);
    return {
      item_id: itemId,
      instance,
      x_mm: round3(item.xMm),
      y_mm: round3(item.yMm),
      width_mm: round3(item.placedWidthMm),
      height_mm: round3(item.placedHeightMm),
      rotated: item.rotated === true,
      source_svg: sourceSvgPlacementFragment(item),
      label: {
        orderId,
        orderName: item.orderName,
        detailId,
        detailNumber: sourceItem?.detailNumber ?? item.detailNumber,
        widthMm: sourceItem?.widthMm ?? item.widthMm,
        heightMm: sourceItem?.heightMm ?? item.heightMm,
        materialName: dto.materialName ?? null,
        visualLines: item.visualLabel?.rawLines ?? null,
      },
    };
  });
  const placements: SheetPlacementsJson = {
    trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
    sheet_width_mm: sheet.widthMm,
    sheet_height_mm: sheet.heightMm,
    pieces,
  };
  const quantities = new Map<string, number>();
  for (const piece of pieces) quantities.set(piece.item_id, (quantities.get(piece.item_id) ?? 0) + 1);
  const fillForOrder = createOrderFillResolver(
    pieces.map((piece) => (piece as { label?: { orderId: number | null } }).label?.orderId ?? null)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value)),
    renderStyle,
  );
  return buildSheetSvg({
    sheet: placements,
    fillFor: (piece) => fillForOrder((piece as { label?: { orderId: number | null } }).label?.orderId ?? null),
    labelFor: (piece) => {
      const label = (piece as {
        label?: {
          orderId: number | null;
          orderName?: string | null;
          detailId?: number | null;
          detailNumber?: number | null;
          widthMm?: number | null;
          heightMm?: number | null;
          materialName?: string | null;
          visualLines?: string[] | null;
        };
      }).label;
      const visualLines = manualSvgVisualLabelLines(
        label?.visualLines ?? null,
        label?.widthMm ?? null,
        label?.heightMm ?? null,
      );
      if (visualLines.length > 0) return visualLines;
      return composePieceLabelLines({
        orderId: label?.orderId ?? null,
        orderName: label?.orderName ?? null,
        detailId: label?.detailId ?? null,
        detailNumber: label?.detailNumber ?? null,
        widthMm: label?.widthMm ?? null,
        heightMm: label?.heightMm ?? null,
        itemId: piece.item_id,
        instance: piece.instance,
        qty: quantities.get(piece.item_id) ?? 1,
        materialName: label?.materialName ?? null,
      });
    },
    renderStyle,
  });
}

function manualSvgVisualLabelLines(
  rawLines: readonly string[] | null | undefined,
  widthMm: number | null,
  heightMm: number | null,
): string[] {
  const lines = cutRenderNormalizeLabelLines(rawLines ?? []);
  if (lines.length === 0) return [];
  if (lines.length >= 3) return lines;
  return [...lines, cutRenderPieceSizeLine(widthMm, heightMm)];
}

async function loadManualSvgUploadRenderStyle(client: DatabaseClient): Promise<CutRenderStyleRule> {
  try {
    const result = await client.query<{ value: unknown | null }>(
      `SELECT value FROM cut_settings WHERE key = $1 LIMIT 1`,
      [CUT_RENDER_STYLES_SETTING_KEY],
    );
    return resolveCutRenderStyleFromSetting(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW, result.rows[0]?.value ?? null);
  } catch {
    return resolveCutRenderStyle(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW);
  }
}

function manualSvgLayoutSourceKey(item: CncTelegramCutLayoutItemDto, index: number): string {
  return [
    item.orderName,
    item.detailNumber,
    item.widthMm,
    item.heightMm,
    item.sourceElementId ?? index,
  ].join(':');
}

function parseManualSvgNumericOrderName(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function linkManualSvgFileOrders(
  tx: TransactionClient,
  fileId: string,
  selectedOrderIds: number[],
): Promise<void> {
  for (const orderId of selectedOrderIds) {
    await tx.query(
      `INSERT INTO cnc_manual_svg_upload_file_orders (file_id, order_id)
       VALUES ($1::uuid, $2::bigint)
       ON CONFLICT DO NOTHING`,
      [fileId, orderId],
    );
  }
}

async function writeManualSvgFileUploadedAudit(
  tx: TransactionClient,
  input: {
    command: ManualSvgUploadCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    externalPacketKey: string;
    file: ManualSvgStoredFile;
  },
): Promise<string> {
  const selectedOrderIds = input.command.dto.selectedOrderIds;
  return auditService.record(tx, {
    event: MANUAL_SVG_FILE_UPLOADED_EVENT,
    entityType: 'cnc_manual_svg_upload_file',
    entityId: input.file.fileId,
    actorUserId: input.command.currentUser.id,
    actorUsername: input.command.currentUser.username ?? null,
    actorRole: input.command.currentUser.role ?? null,
    requestId: input.requestId,
    source: MANUAL_SVG_SOURCE,
    relatedOrderId: selectedOrderIds.length === 1 ? selectedOrderIds[0] : undefined,
    before: null,
    after: manualSvgStoredFileAuditSnapshot(input),
    diff: {
      uploaded: true,
      fileKind: input.file.kind,
      generated: input.file.generated,
    },
    metadata: {
      source: MANUAL_SVG_SOURCE,
      action: 'manual_svg_file_upload',
      fileId: input.file.fileId,
      manualSvgStage: 'source_file_stored',
      stageStatus: 'succeeded',
      fileKind: input.file.kind,
      fileName: input.file.fileName,
      contentType: input.file.contentType,
      sizeBytes: input.file.sizeBytes,
      sha256: input.file.sha256,
      generated: input.file.generated,
      generatedScreenshotContrast: input.file.kind === 'screenshot' && input.file.generated
        ? input.command.dto.generatedScreenshot?.contrast ?? null
        : null,
      expiresAt: input.file.expiresAt,
      packetId: input.packet.packetId,
      externalPacketKey: input.externalPacketKey,
      sourceVersion: input.packet.sourceVersion,
      svgContentHash: input.command.dto.svgContentHash.toLowerCase(),
      sourceFiles: manualSvgSourceFileRequestSnapshot(input.command.dto.sourceFiles ?? []),
      selectedOrderIds,
      parseStatus: input.packet.parseStatus,
      cutLayoutStatus: input.packet.cutLayout?.status ?? null,
      svgCutImportStatus: input.packet.svgCutImportStatus ?? 'none',
      svgCutImportNote: input.packet.svgCutImportNote ?? null,
      cuttingSequenceNo: input.packet.cuttingSequenceNo,
      cutJobId: input.packet.svgCutJobId ?? null,
      cutJobDisplayNumber: input.packet.svgCutJobDisplayNumber ?? null,
      cutResultId: input.packet.svgCutResultId ?? null,
      telegramSendEnabled: input.command.dto.telegramSend?.enabled === true,
    },
    relatedEntities: [
      ...selectedOrderIds.map((orderId) => ({ entityType: 'order', entityId: orderId })),
      ...(input.packet.svgCutJobId ? [{ entityType: 'cut_job', entityId: input.packet.svgCutJobId }] : []),
      ...(input.packet.svgCutResultId ? [{ entityType: 'cut_result', entityId: input.packet.svgCutResultId }] : []),
    ],
  });
}

function manualSvgStoredFileAuditSnapshot(input: {
  packet: CncTelegramPacketDto;
  file: ManualSvgStoredFile;
}): Record<string, unknown> {
  return {
    fileId: input.file.fileId,
    packetId: input.packet.packetId,
    fileKind: input.file.kind,
    fileName: input.file.fileName,
    contentType: input.file.contentType,
    sizeBytes: input.file.sizeBytes,
    sha256: input.file.sha256,
    generated: input.file.generated,
    expiresAt: input.file.expiresAt,
    cutJobId: input.packet.svgCutJobId ?? null,
    cutJobDisplayNumber: input.packet.svgCutJobDisplayNumber ?? null,
    cutResultId: input.packet.svgCutResultId ?? null,
  };
}

async function enqueueManualSvgTelegramSendRequest(
  tx: TransactionClient,
  input: {
    command: ManualSvgUploadCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    externalPacketKey: string;
    files: ManualSvgStoredFile[];
  },
): Promise<{ requestId: string; status: ManualSvgFilePersistenceResult['telegramSendStatus'] } | null> {
  if (input.command.dto.telegramSend?.enabled !== true) return null;
  if (input.files.length === 0) {
    throw new ApiError(422, 'MANUAL_SVG_TELEGRAM_FILES_REQUIRED', 'Для отправки в Telegram нужны файлы');
  }
  assertManualSvgTelegramCutJobReady(input.packet);
  if (!await manualSvgMdfCardEventExists(tx, input.packet)) {
    throw new ApiError(
      422,
      'MANUAL_SVG_TELEGRAM_MDF_CARD_REQUIRED',
      'Перед отправкой SVG в Telegram должна быть создана карточка файла станка на Доске МДФ',
      {
        packetId: input.packet.packetId,
        svgCutJobId: input.packet.svgCutJobId ?? null,
        svgCutJobDisplayNumber: input.packet.svgCutJobDisplayNumber ?? null,
      },
    );
  }

  const active = await tx.query<{ request_id: string; status: ManualSvgFilePersistenceResult['telegramSendStatus'] }>(
    `SELECT request_id, status
     FROM cnc_manual_svg_telegram_send_requests
     WHERE packet_id=$1::uuid
       AND status IN ('pending', 'processing')
     ORDER BY requested_at DESC, request_id DESC
     LIMIT 1
     FOR UPDATE`,
    [input.packet.packetId],
  );
  if (active.rows[0]) {
    if (active.rows[0].status === 'pending') {
      await refreshPendingManualSvgTelegramSendRequest(tx, active.rows[0].request_id, input);
      await replaceManualSvgTelegramSendRequestFiles(tx, active.rows[0].request_id, input.files);
      await writeManualSvgTelegramSendRequestedAudit(tx, {
        ...input,
        telegramSendRequestId: active.rows[0].request_id,
        requestAction: 'updated_pending',
      });
    }
    return { requestId: active.rows[0].request_id, status: active.rows[0].status };
  }

  const sendKey = `cnc-manual-svg-telegram:${input.packet.packetId}:${input.command.dto.idempotencyKey}`;
  const inserted = await tx.query<{ request_id: string; status: ManualSvgFilePersistenceResult['telegramSendStatus']; inserted: boolean }>(
    `WITH inserted AS (
       INSERT INTO cnc_manual_svg_telegram_send_requests (
         packet_id, send_idempotency_key, requested_by, message_text
       )
       VALUES ($1::uuid, $2, $3::bigint, $4)
       ON CONFLICT (send_idempotency_key) DO NOTHING
       RETURNING request_id, status, true AS inserted
     ), existing AS (
       SELECT request_id, status, false AS inserted
       FROM cnc_manual_svg_telegram_send_requests
       WHERE send_idempotency_key=$2
         AND NOT EXISTS (SELECT 1 FROM inserted)
     )
     SELECT request_id, status, inserted FROM inserted
     UNION ALL
     SELECT request_id, status, inserted FROM existing`,
    [
      input.packet.packetId,
      sendKey,
      Number(input.command.currentUser.id),
      manualSvgTelegramMessage(input.command.dto),
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('manual SVG Telegram send request insert returned no row');
  if (row.status === 'pending') {
    await replaceManualSvgTelegramSendRequestFiles(tx, row.request_id, input.files);
  }
  if (row.inserted) {
    await writeManualSvgTelegramSendRequestedAudit(tx, {
      ...input,
      telegramSendRequestId: row.request_id,
      requestAction: 'created',
    });
  }
  return { requestId: row.request_id, status: row.status };
}

async function refreshPendingManualSvgTelegramSendRequest(
  tx: TransactionClient,
  requestId: string,
  input: {
    command: ManualSvgUploadCommand;
  },
): Promise<void> {
  await tx.query(
    `UPDATE cnc_manual_svg_telegram_send_requests
     SET message_text=$2,
         requested_by=$3::bigint,
         requested_at=now(),
         updated_at=now()
     WHERE request_id=$1::uuid
       AND status='pending'`,
    [
      requestId,
      manualSvgTelegramMessage(input.command.dto),
      Number(input.command.currentUser.id),
    ],
  );
}

async function replaceManualSvgTelegramSendRequestFiles(
  tx: TransactionClient,
  requestId: string,
  files: ManualSvgStoredFile[],
): Promise<void> {
  await tx.query('DELETE FROM cnc_manual_svg_telegram_send_request_files WHERE request_id=$1::uuid', [requestId]);
  for (const file of files) {
    await tx.query(
      `INSERT INTO cnc_manual_svg_telegram_send_request_files (request_id, file_id, send_order)
       VALUES ($1::uuid, $2::uuid, $3::integer)
       ON CONFLICT DO NOTHING`,
      [requestId, file.fileId, manualSvgFileKindOrder(file.kind)],
    );
  }
}

async function writeManualSvgTelegramSendRequestedAudit(
  tx: TransactionClient,
  input: {
    command: ManualSvgUploadCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    externalPacketKey: string;
    files: ManualSvgStoredFile[];
    telegramSendRequestId: string;
    requestAction: 'created' | 'updated_pending';
  },
): Promise<string> {
  const selectedOrderIds = input.command.dto.selectedOrderIds;
  const files = input.files.map((file) => ({
    fileId: file.fileId,
    kind: file.kind,
    fileName: file.fileName,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    generated: file.generated,
  }));
  const message = manualSvgTelegramMessage(input.command.dto);
  return auditService.record(tx, {
    event: MANUAL_SVG_TELEGRAM_SEND_REQUESTED_EVENT,
    entityType: 'cnc_manual_svg_telegram_send_request',
    entityId: input.telegramSendRequestId,
    actorUserId: input.command.currentUser.id,
    actorUsername: input.command.currentUser.username ?? null,
    actorRole: input.command.currentUser.role ?? null,
    requestId: input.requestId,
    source: MANUAL_SVG_SOURCE,
    relatedOrderId: selectedOrderIds.length === 1 ? selectedOrderIds[0] : undefined,
    before: input.requestAction === 'updated_pending' ? { status: 'pending' } : null,
    after: { status: 'pending', message, fileCount: files.length, files },
    diff: input.requestAction === 'updated_pending'
      ? { pendingRequest: { from: 'previous_files_or_comment', to: 'latest_upload_files_and_comment' } }
      : { status: { from: null, to: 'pending' } },
    metadata: {
      requestAction: input.requestAction,
      manualSvgStage: 'telegram_send_requested',
      stageStatus: 'pending',
      packetId: input.packet.packetId,
      externalPacketKey: input.externalPacketKey,
      sourceVersion: input.packet.sourceVersion,
      telegramSendRequestId: input.telegramSendRequestId,
      message,
      fileCount: files.length,
      files,
      selectedOrderIds,
      mdfMachineFileCardEventKey: manualSvgMdfCardEventKey(input.packet),
      parseStatus: input.packet.parseStatus,
      cutLayoutStatus: input.packet.cutLayout?.status ?? null,
      svgCutImportStatus: input.packet.svgCutImportStatus ?? 'none',
      svgCutImportNote: input.packet.svgCutImportNote ?? null,
      cuttingSequenceNo: input.packet.cuttingSequenceNo,
      cutJobId: input.packet.svgCutJobId ?? null,
      cutJobDisplayNumber: input.packet.svgCutJobDisplayNumber ?? null,
      cutResultId: input.packet.svgCutResultId ?? null,
    },
    relatedEntities: [
      ...selectedOrderIds.map((orderId) => ({ entityType: 'order', entityId: orderId })),
      ...(input.packet.svgCutJobId ? [{ entityType: 'cut_job', entityId: input.packet.svgCutJobId }] : []),
      ...(input.packet.svgCutResultId ? [{ entityType: 'cut_result', entityId: input.packet.svgCutResultId }] : []),
    ],
  });
}

function manualSvgTelegramMessage(dto: CncTelegramManualSvgUploadDto): string {
  const custom = dto.telegramSend?.message?.trim();
  if (custom) return custom.slice(0, 4096);
  return (dto.comments ?? []).join(' ').trim().slice(0, 4096);
}

function sanitizeManualSvgFileName(value: string): string {
  const trimmed = value.trim().replace(/[/\\\0\r\n\t]/g, '_');
  return trimmed.length > 0 ? trimmed.slice(0, 240) : 'manual-svg-upload-file';
}

function manualSvgFileBaseName(fileName: string): string {
  const sanitized = sanitizeManualSvgFileName(fileName);
  const dot = sanitized.lastIndexOf('.');
  return (dot > 0 ? sanitized.slice(0, dot) : sanitized).slice(0, 220) || 'manual-svg-upload';
}

function manualSvgFileKindOrder(kind: CncTelegramManualSvgUploadFileDto['kind']): number {
  if (kind === 'svg') return 1;
  if (kind === 'gcode') return 2;
  return 3;
}

async function writeManualSvgCreatedAudit(
  tx: TransactionClient,
  input: {
    command: ManualSvgUploadCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    externalPacketKey: string;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: MANUAL_SVG_EVENT,
    entityType: 'cnc_telegram_packet',
    entityId: input.packet.packetId,
    actorUserId: input.command.currentUser.id,
    actorUsername: input.command.currentUser.username ?? null,
    actorRole: input.command.currentUser.role ?? null,
    requestId: input.requestId,
    source: MANUAL_SVG_SOURCE,
    before: null,
    after: packetAuditSnapshot(input.packet),
    diff: {
      created: true,
      itemCount: input.packet.itemCount,
      itemQuantityTotal: input.packet.itemQuantityTotal,
      svgCutImportStatus: input.packet.svgCutImportStatus ?? 'none',
    },
    metadata: manualSvgEventMetadata(input, 'manual_svg_upload'),
    relatedEntities: manualSvgRelatedEntities(input.packet),
  });
}

async function writeManualSvgMdfCardAudit(
  tx: TransactionClient,
  input: {
    command: ManualSvgUploadCommand;
    beforePacket: CncTelegramPacketDto | null;
    packet: CncTelegramPacketDto;
    requestId: string;
    externalPacketKey: string;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: MANUAL_SVG_COMPLETED_EVENT,
    entityType: 'cnc_telegram_packet',
    entityId: input.packet.packetId,
    actorUserId: input.command.currentUser.id,
    actorUsername: input.command.currentUser.username ?? null,
    actorRole: input.command.currentUser.role ?? null,
    requestId: input.requestId,
    source: MANUAL_SVG_SOURCE,
    before: input.beforePacket ? packetAuditSnapshot(input.beforePacket) : null,
    after: packetAuditSnapshot(input.packet),
    diff: {
      mdfMachineFileCardCreated: true,
      completionStatus: input.packet.completionStatus,
      thumbsUp: input.packet.thumbsUp,
      svgCutImportStatus: input.packet.svgCutImportStatus ?? 'none',
    },
    metadata: manualSvgEventMetadata(input, 'manual_svg_mdf_card_create'),
    relatedEntities: manualSvgRelatedEntities(input.packet),
  });
}

async function enqueueManualSvgCreatedEvent(
  tx: TransactionClient,
  input: {
    command: ManualSvgUploadCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    auditId: string;
    externalPacketKey: string;
  },
): Promise<void> {
  await enqueueOutbox(tx, {
    eventType: MANUAL_SVG_EVENT,
    aggregateType: 'cnc_telegram_packet',
    aggregateId: input.packet.packetId,
    idempotencyKey: `cnc-manual-svg:${input.packet.packetId}:source-${input.packet.sourceVersion}:created`,
    payload: manualSvgOutboxPayload(input, MANUAL_SVG_EVENT),
  });
}

async function enqueueManualSvgMdfCardEvent(
  tx: TransactionClient,
  input: {
    command: ManualSvgUploadCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    auditId: string;
    externalPacketKey: string;
  },
): Promise<void> {
  await enqueueOutbox(tx, {
    eventType: MANUAL_SVG_COMPLETED_EVENT,
    aggregateType: 'cnc_telegram_packet',
    aggregateId: input.packet.packetId,
    idempotencyKey: manualSvgMdfCardEventKey(input.packet),
    payload: manualSvgOutboxPayload(input, MANUAL_SVG_COMPLETED_EVENT),
  });
}

function manualSvgOutboxPayload(
  input: {
    command: ManualSvgUploadCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    auditId: string;
    externalPacketKey: string;
  },
  eventType: string,
): Record<string, unknown> {
  return {
    eventType,
    actorUserId: input.command.currentUser.id,
    requestId: input.requestId,
    auditId: input.auditId,
    packetId: input.packet.packetId,
    externalPacketKey: input.externalPacketKey,
    svgContentHash: input.command.dto.svgContentHash.toLowerCase(),
    selectedOrderIds: input.command.dto.selectedOrderIds,
    createMdfMachineFileCard: input.command.dto.createMdfMachineFileCard,
    matchMode: input.command.dto.matchMode,
    validationMode: input.command.dto.validationMode,
    cutJobId: input.packet.svgCutJobId ?? null,
    cutJobDisplayNumber: input.packet.svgCutJobDisplayNumber ?? null,
    cutResultId: input.packet.svgCutResultId ?? null,
    svgCutImportStatus: input.packet.svgCutImportStatus ?? 'none',
    svgCutImportNote: input.packet.svgCutImportNote ?? null,
    sourceFiles: manualSvgSourceFileRequestSnapshot(input.command.dto.sourceFiles ?? []),
    sourceChatId: input.packet.sourceChatId,
    sourceVersion: input.packet.sourceVersion,
    workday: input.packet.workday,
    machine: input.packet.machine,
    programName: input.packet.programName,
    materialName: input.packet.materialName,
    parseStatus: input.packet.parseStatus,
    completionStatus: input.packet.completionStatus,
    rework: input.packet.rework,
    itemCount: input.packet.itemCount,
    itemQuantityTotal: input.packet.itemQuantityTotal,
    commentsCount: input.packet.comments.length,
    idempotencyKey: input.command.dto.idempotencyKey,
  };
}

function manualSvgRelatedEntities(packet: CncTelegramPacketDto): Array<{ entityType: string; entityId: number }> {
  const matchedOrderIds = Array.from(
    new Set(packet.items.map((item) => item.matchOrderId).filter(isPositiveNumber)),
  );
  return [
    ...matchedOrderIds.map((orderId) => ({ entityType: 'order', entityId: orderId })),
    ...(packet.svgCutJobId ? [{ entityType: 'cut_job', entityId: packet.svgCutJobId }] : []),
    ...(packet.svgCutResultId ? [{ entityType: 'cut_result', entityId: packet.svgCutResultId }] : []),
  ];
}

function manualSvgEventMetadata(
  input: {
    command: ManualSvgUploadCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    externalPacketKey: string;
  },
  action: 'manual_svg_upload' | 'manual_svg_mdf_card_create',
): Record<string, unknown> {
  return {
    source: MANUAL_SVG_SOURCE,
    action,
    manualSvgStage: action === 'manual_svg_upload' ? 'parsed_cut_job_created' : 'mdf_machine_file_card_created',
    stageStatus: 'succeeded',
    externalPacketKey: input.externalPacketKey,
    packetId: input.packet.packetId,
    sourceVersion: input.packet.sourceVersion,
    svgContentHash: input.command.dto.svgContentHash.toLowerCase(),
    sourceFiles: manualSvgSourceFileRequestSnapshot(input.command.dto.sourceFiles ?? []),
    selectedOrderIds: input.command.dto.selectedOrderIds,
    createMdfMachineFileCard: input.command.dto.createMdfMachineFileCard,
    matchMode: input.command.dto.matchMode,
    validationMode: input.command.dto.validationMode,
    machine: input.packet.machine,
    programName: input.packet.programName,
    materialName: input.packet.materialName,
    rework: input.packet.rework,
    cuttingSequenceNo: input.packet.cuttingSequenceNo,
    itemCount: input.packet.itemCount,
    itemQuantityTotal: input.packet.itemQuantityTotal,
    commentsCount: input.packet.comments.length,
    parserVersion: input.packet.parserVersion,
    parseStatus: input.packet.parseStatus,
    cutLayoutStatus: input.packet.cutLayout?.status ?? null,
    cutLayoutReasons: input.packet.cutLayout?.reasons ?? [],
    svgCutJobId: input.packet.svgCutJobId ?? null,
    svgCutJobDisplayNumber: input.packet.svgCutJobDisplayNumber ?? null,
    svgCutResultId: input.packet.svgCutResultId ?? null,
    svgCutImportStatus: input.packet.svgCutImportStatus ?? 'none',
    svgCutImportNote: input.packet.svgCutImportNote ?? null,
    requestId: input.requestId,
  };
}

function mapManualSvgCommentPreset(row: ManualSvgCommentPresetRow): CncTelegramManualSvgCommentPresetDto {
  return {
    presetId: toNumber(row.preset_id),
    label: row.label,
    commentText: row.comment_text,
    category: row.category,
    isActive: row.is_active === true,
    sortOrder: toNumber(row.sort_order),
    version: toNumber(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function manualSvgPresetSnapshot(preset: CncTelegramManualSvgCommentPresetDto): Record<string, unknown> {
  return {
    presetId: preset.presetId,
    label: preset.label,
    commentText: preset.commentText,
    category: preset.category,
    isActive: preset.isActive,
    sortOrder: preset.sortOrder,
    version: preset.version,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  };
}

function packetSelectSql(whereSql: string): string {
  return `
    SELECT
      p.packet_id,
      p.external_packet_key,
      p.cutting_sequence_no,
      p.source_chat_id,
      p.source_message_id,
      p.source_thread_id,
      p.source_version,
      p.source_created_at,
      p.source_updated_at,
      p.workday,
      p.machine,
      p.program_name,
      p.material_name,
      p.sheet_image_storage_key,
      p.sheet_image_content_type,
      p.sheet_image_size_bytes,
      p.parse_status,
      p.completion_status,
      p.thumbs_up,
      p.completed_at,
      p.rework,
      p.comments_json,
      p.tools_json,
      p.doweling_links_json,
      p.analysis_warnings_json,
      p.ocr_engine,
      p.parser_version,
      p.cut_layout_json,
      p.svg_cut_job_id,
      svg_job.source_display_number AS svg_cut_job_display_number,
      p.svg_cut_result_id,
      svg_result.result_no AS svg_cut_result_no,
      p.svg_cut_import_status,
      p.svg_cut_import_note,
      (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'cutGroupId', sheet_summary.cut_group_id,
            'sheetIndex', sheet_summary.sheet_index,
            'sheetNumber', sheet_summary.sheet_ordinal,
            'variant', sheet_summary.variant,
            'detailIds', sheet_summary.detail_ids
          )
          ORDER BY sheet_summary.sheet_ordinal, sheet_summary.cut_group_id, sheet_summary.sheet_index
        ), '[]'::jsonb)
        FROM (
          SELECT
            sheet.cut_group_id,
            sheet.sheet_index,
            sheet.sheet_ordinal,
            sheet.variant,
            COALESCE(jsonb_agg(
              placement.order_detail_id
              ORDER BY placement.order_id, placement.order_detail_id, placement.instance
            ) FILTER (WHERE placement.order_detail_id IS NOT NULL), '[]'::jsonb) AS detail_ids
          FROM cut_result_placement placement
          JOIN cut_result_sheet_map sheet
            ON sheet.cut_result_sheet_map_id = placement.cut_result_sheet_map_id
           AND sheet.is_effective = true
          WHERE placement.cut_result_id = p.svg_cut_result_id
          GROUP BY sheet.cut_group_id, sheet.sheet_index, sheet.sheet_ordinal, sheet.variant
        ) sheet_summary
      ) AS svg_cut_sheets_json,
      p.updated_at,
      i.packet_item_id,
      i.source_item_key,
      i.order_name,
      COALESCE(i.match_order_id, item_order.order_id) AS item_order_id,
      COALESCE(matched_order.delete_flag, false) AS order_delete_flag,
      i.detail_number,
      i.width_mm,
      i.height_mm,
      i.quantity,
      i.source AS item_source,
      i.confidence,
      i.match_order_id,
      i.match_detail_id,
      matched_detail.quantity AS match_detail_quantity,
      i.match_status,
      i.review_note,
      CASE
        WHEN i.match_status = 'matched'
          AND matched_detail.detail_id IS NOT NULL
          AND detail_status.sort_order IS NOT NULL
          AND laminated_status.sort_order IS NOT NULL
          THEN detail_status.sort_order >= laminated_status.sort_order
        ELSE false
      END AS laminated_or_later,
      linked_order.order_id IS NOT NULL
        AND linked_order.delete_flag = false
        AND COALESCE(linked_order_status.all_details_packed_or_later, false)
        AS all_linked_order_details_packed_or_later
    FROM cnc_telegram_packets p
    LEFT JOIN cut_job svg_job
      ON svg_job.cut_job_id = p.svg_cut_job_id
    LEFT JOIN cut_result svg_result
      ON svg_result.cut_job_id = p.svg_cut_job_id
     AND svg_result.cut_result_id = p.svg_cut_result_id
    LEFT JOIN cnc_telegram_packet_items i ON i.packet_id = p.packet_id
    LEFT JOIN (
      SELECT
        lower(trim(o.order_name)) AS order_key,
        MIN(o.order_id)::bigint AS order_id
      FROM orders o
      WHERE o.delete_flag = false
        AND NULLIF(trim(o.order_name), '') IS NOT NULL
      GROUP BY lower(trim(o.order_name))
      HAVING COUNT(*) = 1
    ) item_order
      ON item_order.order_key = lower(trim(i.order_name))
    LEFT JOIN orders matched_order ON matched_order.order_id = i.match_order_id
    LEFT JOIN orders linked_order
      ON linked_order.order_id = COALESCE(i.match_order_id, item_order.order_id)
    LEFT JOIN order_details matched_detail
      ON matched_detail.detail_id = i.match_detail_id
     AND matched_detail.delete_flag = false
    LEFT JOIN production_statuses detail_status
      ON detail_status.production_status_id = matched_detail.production_status_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(COALESCE(ps.production_status_code, ''))) = 'laminated'
        ),
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(ps.production_status_name)) = 'закатан'
        )
      ) AS sort_order
      FROM production_statuses ps
    ) laminated_status ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(COALESCE(ps.production_status_code, ''))) = 'packed'
        ),
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(ps.production_status_name)) = 'упакован'
        )
      ) AS sort_order
      FROM production_statuses ps
    ) packed_status ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(linked_detail.detail_id) > 0
          AND BOOL_AND(
            linked_detail_status.sort_order IS NOT NULL
            AND packed_status.sort_order IS NOT NULL
            AND linked_detail_status.sort_order >= packed_status.sort_order
          ) AS all_details_packed_or_later
      FROM order_details linked_detail
      LEFT JOIN production_statuses linked_detail_status
        ON linked_detail_status.production_status_id = linked_detail.production_status_id
      WHERE linked_detail.order_id = linked_order.order_id
        AND linked_detail.delete_flag = false
    ) linked_order_status ON true
    WHERE ${whereSql}
    ORDER BY p.updated_at DESC, p.packet_id, i.order_name ASC NULLS LAST, i.detail_number ASC NULLS LAST
  `;
}

async function loadPacket(tx: TransactionClient, packetId: string): Promise<CncTelegramPacketDto> {
  const rows = await tx.query<PacketJoinedRow>(
    packetSelectSql('p.packet_id = $1::uuid'),
    [packetId],
  );
  const packet = mapPacketRows(rows.rows)[0];
  if (!packet) {
    throw new ApiError(500, 'CNC_TELEGRAM_PACKET_NOT_FOUND', 'CNC packet was not found after write', {
      packetId,
    });
  }
  return packet;
}

async function loadPacketReplayByExternalKey(
  tx: TransactionClient,
  externalPacketKey: string,
): Promise<PacketReplayRow | null> {
  const replay = await tx.query<PacketReplayRow>(
    `
    SELECT packet_id, source_version, payload_hash, cutting_sequence_no, completion_status, thumbs_up
    FROM cnc_telegram_packets
    WHERE external_packet_key = $1
    FOR UPDATE
    `,
    [externalPacketKey],
  );
  return replay.rows[0] ?? null;
}

async function findRelatedSvgPacketAlias(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
): Promise<PacketReplayRow | null> {
  const layout = dto.cutLayout ?? null;
  const sheetImageStorageKey = normalizeOptional(dto.sheetImage?.storageKey);
  const programBaseName = telegramProgramBaseName(dto.programName);
  const materialName = normalizeOptional(dto.materialName) ?? 'МДФ 16мм';
  const sourceInstant = dto.source.createdAt ?? dto.source.updatedAt ?? null;
  const itemSignature = telegramPacketItemSignature(dto);
  if (
    layout?.status !== 'valid' ||
    !sheetImageStorageKey ||
    !dto.workday ||
    !programBaseName ||
    !itemSignature
  ) {
    return null;
  }

  const replay = await tx.query<PacketReplayRow>(
    `
    /* cnc_telegram_svg_packet_alias */
    SELECT
      packet.packet_id,
      packet.source_version,
      packet.payload_hash,
      packet.cutting_sequence_no,
      packet.completion_status,
      packet.thumbs_up
    FROM cnc_telegram_packets packet
    JOIN LATERAL (
      SELECT string_agg(part.item_signature, ',' ORDER BY part.item_signature) AS item_signature
      FROM (
        SELECT
          lower(trim(COALESCE(item.order_name, ''))) || ':' ||
            COALESCE(item.detail_number::text, '') || ':' ||
            COALESCE(trim(trailing '.' from trim(trailing '0' from item.width_mm::text)), '') || ':' ||
            COALESCE(trim(trailing '.' from trim(trailing '0' from item.height_mm::text)), '') || ':' ||
            item.quantity::text AS item_signature
        FROM cnc_telegram_packet_items item
        WHERE item.packet_id = packet.packet_id
      ) part
    ) packet_items ON TRUE
    WHERE packet.external_packet_key <> $1
      AND packet.source_chat_id = $2
      AND packet.workday = $3::date
      AND regexp_replace(lower(trim(COALESCE(packet.program_name, ''))), '\\.[^.]+$', '') = $4
      AND lower(trim(COALESCE(packet.material_name, 'МДФ 16мм'))) = lower(trim($5))
      AND packet.cut_layout_json = $6::jsonb
      AND packet.cut_layout_json->>'status' = 'valid'
      AND packet.svg_cut_import_status = 'imported'
      AND packet.svg_cut_job_id IS NOT NULL
      AND packet.cutting_sequence_no IS NOT NULL
      AND packet_items.item_signature = $9
      AND (
        packet.sheet_image_storage_key = $7
        OR packet.sheet_image_storage_key IS NULL
      )
    ORDER BY
      CASE WHEN packet.sheet_image_storage_key = $7 THEN 0 ELSE 1 END,
      CASE
        WHEN $8::timestamptz IS NOT NULL
         AND ABS(EXTRACT(EPOCH FROM (
           COALESCE(packet.source_created_at, packet.source_updated_at, packet.created_at) - $8::timestamptz
         ))) <= 600
        THEN 0 ELSE 1
      END,
      CASE
        WHEN $8::timestamptz IS NULL THEN NULL
        ELSE ABS(EXTRACT(EPOCH FROM (
          COALESCE(packet.source_created_at, packet.source_updated_at, packet.created_at) - $8::timestamptz
        )))
      END ASC NULLS LAST,
      packet.cutting_sequence_no ASC,
      packet.source_created_at ASC NULLS LAST,
      packet.packet_id ASC
    LIMIT 1
    FOR UPDATE
    `,
    [
      dto.externalPacketKey,
      dto.source.chatId,
      dto.workday,
      programBaseName,
      materialName,
      JSON.stringify(layout),
      sheetImageStorageKey,
      sourceInstant,
      itemSignature,
    ],
  );
  return replay.rows[0] ?? null;
}

function telegramProgramBaseName(programName: string | null | undefined): string | null {
  const normalized = normalizeOptional(programName)?.toLowerCase();
  if (!normalized) return null;
  return normalized.replace(/\.[^.]+$/, '');
}

function telegramPacketItemSignature(dto: CncTelegramStructuredIngestDto): string | null {
  const parts = dto.items.map((item) => [
    normalizeOptional(item.orderName)?.toLowerCase() ?? '',
    item.detailNumber == null ? '' : String(item.detailNumber),
    item.widthMm == null ? '' : compactNumber(item.widthMm),
    item.heightMm == null ? '' : compactNumber(item.heightMm),
    String(item.quantity),
  ].join(':'));
  if (parts.length === 0) return null;
  return parts.sort().join(',');
}

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, '').replace(/\.$/, '');
}

function withPacketReplaySourceVersion(
  command: IngestCncTelegramPacketCommand,
  sourceVersion: number,
  replay: PacketReplayRow,
): IngestCncTelegramPacketCommand {
  const cuttingSequenceNo = toPositiveInteger(replay.cutting_sequence_no);
  return {
    ...command,
    dto: {
      ...command.dto,
      cuttingSequenceNo: cuttingSequenceNo ?? command.dto.cuttingSequenceNo,
      source: {
        ...command.dto.source,
        version: sourceVersion,
      },
    },
  };
}

async function insertPacket(
  tx: TransactionClient,
  command: IngestCncTelegramPacketCommand,
  payloadHash: string,
): Promise<string> {
  const dto = command.dto;
  const result = await tx.query<{ packet_id: string }>(
    `
    INSERT INTO cnc_telegram_packets (
      external_packet_key,
      source_chat_id,
      source_message_id,
      source_thread_id,
      source_version,
      source_updated_at,
      source_created_at,
      payload_hash,
      workday,
      machine,
      program_name,
      material_name,
      sheet_image_storage_key,
      sheet_image_content_type,
      sheet_image_size_bytes,
      parse_status,
      completion_status,
      thumbs_up,
      completed_at,
      rework,
      comments_json,
      tools_json,
      doweling_links_json,
      analysis_warnings_json,
      ocr_engine,
      parser_version,
      cut_layout_json,
      created_by,
      updated_by
    )
    VALUES (
      $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz,
      $8,
      COALESCE($9::date, CURRENT_DATE),
      $10, $11, COALESCE($12, 'МДФ 16мм'),
      $13, $14, $15::bigint,
      $16, $17, $18, $19::timestamptz, $20,
      $21::jsonb, $22::jsonb, $23::jsonb, $24::jsonb,
      $25, COALESCE($26, 'cnc-telegram-structured-v1'),
      $27::jsonb,
      $28, $28
    )
    RETURNING packet_id
    `,
    packetParams(dto, payloadHash, command.currentUser.id),
  );
  const packetId = result.rows[0]?.packet_id;
  if (!packetId) {
    throw new ApiError(500, 'CNC_TELEGRAM_PACKET_INSERT_FAILED', 'CNC packet insert failed');
  }
  return packetId;
}

async function updatePacket(
  tx: TransactionClient,
  packetId: string,
  command: IngestCncTelegramPacketCommand,
  payloadHash: string,
): Promise<void> {
  const dto = command.dto;
  await tx.query(
    `
    UPDATE cnc_telegram_packets
    SET
      source_chat_id = $2,
      source_message_id = $3,
      source_thread_id = $4,
      source_version = $5,
      source_updated_at = $6::timestamptz,
      source_created_at = COALESCE($7::timestamptz, source_created_at, $6::timestamptz),
      payload_hash = $8,
      workday = COALESCE($9::date, workday),
      machine = $10,
      program_name = $11,
      material_name = COALESCE($12, 'МДФ 16мм'),
      sheet_image_storage_key = $13,
      sheet_image_content_type = $14,
      sheet_image_size_bytes = $15::bigint,
      parse_status = $16,
      completion_status = $17,
      thumbs_up = $18,
      completed_at = $19::timestamptz,
      rework = $20,
      comments_json = $21::jsonb,
      tools_json = $22::jsonb,
      doweling_links_json = $23::jsonb,
      analysis_warnings_json = $24::jsonb,
      ocr_engine = $25,
      parser_version = COALESCE($26, 'cnc-telegram-structured-v1'),
      cut_layout_json = $27::jsonb,
      updated_by = $28,
      updated_at = now()
    WHERE packet_id = $1::uuid
    `,
    [packetId, ...packetParams(dto, payloadHash, command.currentUser.id).slice(1)],
  );
}

function packetParams(
  dto: CncTelegramStructuredIngestDto,
  payloadHash: string,
  actorUserId: string,
): unknown[] {
  return [
    dto.externalPacketKey,
    dto.source.chatId,
    dto.source.messageId ?? null,
    dto.source.threadId ?? null,
    dto.source.version,
    dto.source.updatedAt ?? dto.source.createdAt ?? null,
    dto.source.createdAt ?? dto.source.updatedAt ?? null,
    payloadHash,
    dto.workday ?? null,
    normalizeOptional(dto.machine),
    normalizeOptional(dto.programName),
    normalizeOptional(dto.materialName) ?? 'МДФ 16мм',
    normalizeOptional(dto.sheetImage?.storageKey),
    normalizeOptional(dto.sheetImage?.contentType),
    dto.sheetImage?.sizeBytes ?? null,
    dto.parseStatus ?? deriveParseStatus(dto),
    dto.completionStatus ?? (dto.thumbsUp ? 'completed' : 'pending'),
    dto.thumbsUp === true,
    dto.completedAt ?? (dto.thumbsUp ? dto.source.updatedAt ?? dto.source.createdAt ?? null : null),
    dto.rework === true,
    JSON.stringify(dto.comments ?? []),
    JSON.stringify(dto.tools ?? []),
    JSON.stringify(dto.dowelingLinks ?? []),
    JSON.stringify(analysisWarningsArray(dto.analysisWarnings ?? [])),
    normalizeOptional(dto.ocrEngine),
    normalizeOptional(dto.parserVersion),
    dto.cutLayout ? JSON.stringify(dto.cutLayout) : null,
    Number(actorUserId),
  ];
}

async function replaceItems(
  tx: TransactionClient,
  packetId: string,
  dto: CncTelegramStructuredIngestDto,
): Promise<void> {
  await tx.query('DELETE FROM cnc_telegram_packet_items WHERE packet_id = $1::uuid', [packetId]);
  for (const item of dto.items) {
    await tx.query(
      `
      INSERT INTO cnc_telegram_packet_items (
        packet_id,
        source_item_key,
        order_name,
        detail_number,
        width_mm,
        height_mm,
        quantity,
        source,
        confidence,
        match_order_id,
        match_detail_id,
        match_status,
        review_note
      )
      VALUES (
        $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      )
      `,
      [
        packetId,
        item.sourceItemKey,
        item.orderName,
        item.detailNumber ?? null,
        item.widthMm ?? null,
        item.heightMm ?? null,
        item.quantity,
        item.source,
        item.confidence,
        item.matchOrderId ?? null,
        item.matchDetailId ?? null,
        item.matchStatus ?? 'unmatched',
        normalizeOptional(item.reviewNote),
      ],
    );
  }
}

async function ensureCuttingSequenceNo(
  tx: TransactionClient,
  packetId: string,
  dto: CncTelegramStructuredIngestDto,
  actorUserId: number,
): Promise<void> {
  if (dto.cuttingSequenceNo != null) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['cnc_telegram_cutting_sequence_no']);
    const conflict = await tx.query<{ packet_id: string }>(
      `
      SELECT packet_id
      FROM cnc_telegram_packets
      WHERE cutting_sequence_no = $2::integer
        AND packet_id <> $1::uuid
      LIMIT 1
      `,
      [packetId, dto.cuttingSequenceNo],
    );
    if (conflict.rows[0]) {
      return;
    }
    await tx.query(
      `
      UPDATE cnc_telegram_packets
      SET
        cutting_sequence_no = $2::integer,
        updated_by = $3,
        updated_at = CASE
          WHEN cutting_sequence_no IS DISTINCT FROM $2::integer THEN now()
          ELSE updated_at
        END
      WHERE packet_id = $1::uuid
        AND cutting_sequence_no IS DISTINCT FROM $2::integer
      `,
      [packetId, dto.cuttingSequenceNo, actorUserId],
    );
    return;
  }
  if (!packetNeedsCuttingSequence(dto) && !await packetIntersectsPendingBaths(tx, packetId, dto)) {
    return;
  }
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['cnc_telegram_cutting_sequence_no']);
  await tx.query(
    `
    WITH next_sequence AS (
      SELECT COALESCE(MAX(cutting_sequence_no), 0) + 1 AS cutting_sequence_no
      FROM cnc_telegram_packets
    )
    UPDATE cnc_telegram_packets packet
    SET
      cutting_sequence_no = next_sequence.cutting_sequence_no,
      updated_by = $2,
      updated_at = now()
    FROM next_sequence
    WHERE packet.packet_id = $1::uuid
      AND packet.cutting_sequence_no IS NULL
    `,
    [packetId, actorUserId],
  );
}

function packetNeedsCuttingSequence(dto: CncTelegramStructuredIngestDto): boolean {
  if (dto.cutLayout?.status === 'valid') return true;
  return (dto.completionStatus ?? (dto.thumbsUp ? 'completed' : 'pending')) === 'pending';
}

async function packetIntersectsPendingBaths(
  tx: TransactionClient,
  packetId: string,
  dto: CncTelegramStructuredIngestDto,
): Promise<boolean> {
  const workdayTo = dto.workday ?? await currentDatabaseWorkday(tx);
  const workdayFrom = dateOnlyDaysBefore(workdayTo, 6);
  const baths = await loadBathCards(tx, workdayFrom, workdayTo);
  const pendingBathOrderIds = new Set<number>();
  for (const bath of baths) {
    if (bath.ready) continue;
    for (const item of bath.items) {
      pendingBathOrderIds.add(item.orderId);
    }
  }
  if (pendingBathOrderIds.size === 0) return false;
  const packetOrderIds = await loadPacketOrderIds(tx, packetId);
  return packetOrderIds.some((orderId) => pendingBathOrderIds.has(orderId));
}

async function loadPacketOrderIds(tx: TransactionClient, packetId: string): Promise<number[]> {
  const result = await tx.query<{ order_id: string | number | null }>(
    `
    WITH unique_order_keys AS (
      SELECT
        lower(trim(o.order_name)) AS order_key,
        MIN(o.order_id)::bigint AS order_id
      FROM orders o
      WHERE o.delete_flag = false
        AND NULLIF(trim(o.order_name), '') IS NOT NULL
      GROUP BY lower(trim(o.order_name))
      HAVING COUNT(*) = 1
    )
    SELECT DISTINCT COALESCE(i.match_order_id, order_key.order_id) AS order_id
    FROM cnc_telegram_packet_items i
    LEFT JOIN unique_order_keys order_key
      ON order_key.order_key = lower(trim(i.order_name))
    WHERE i.packet_id = $1::uuid
      AND COALESCE(i.match_order_id, order_key.order_id) IS NOT NULL
    `,
    [packetId],
  );
  return result.rows
    .map((row) => toPositiveInteger(row.order_id))
    .filter((value): value is number => value !== null);
}

async function ensureStoredCutLayout(
  tx: TransactionClient,
  packetId: string,
  layout: CncTelegramCutLayoutDto | null,
): Promise<void> {
  if (!layout) return;
  await tx.query(
    `UPDATE cnc_telegram_packets
     SET cut_layout_json = COALESCE(cut_layout_json, $2::jsonb)
     WHERE packet_id = $1::uuid`,
    [packetId, JSON.stringify(layout)],
  );
}

async function syncSvgCutImport(
  tx: TransactionClient,
  packetId: string,
  dto: CncTelegramStructuredIngestDto,
  matchSourceDto: CncTelegramStructuredIngestDto,
  actorUserId: string,
  options: {
    requestedCutJobId?: number | null;
    matchMode?: CncTelegramManualSvgUploadDto['matchMode'];
    validationMode?: CncTelegramManualSvgUploadDto['validationMode'];
    selectedOrderIds?: number[];
    refreshImported?: boolean;
  } = {},
): Promise<void> {
  const state = await tx.query<{
    svg_cut_job_id: string | number | null;
    svg_cut_result_id: string | number | null;
    svg_cut_import_status: 'none' | 'skipped' | 'needs_review' | 'imported' | null;
    cutting_sequence_no: string | number | null;
  }>(
    `SELECT svg_cut_job_id, svg_cut_result_id, svg_cut_import_status, cutting_sequence_no
     FROM cnc_telegram_packets
     WHERE packet_id = $1::uuid
     FOR UPDATE`,
    [packetId],
  );
  const row = state.rows[0];
  if (!row) return;
  const alreadyImported = row.svg_cut_import_status === 'imported'
    && row.svg_cut_job_id !== null
    && row.svg_cut_result_id !== null;
  if (alreadyImported && options.refreshImported !== true) {
    await syncSvgCutJobSourceDisplayNumber(tx, row.svg_cut_job_id, options.requestedCutJobId ?? row.cutting_sequence_no);
    return;
  }

  const layout = dto.cutLayout ?? matchSourceDto.cutLayout ?? null;
  if (!layout) {
    if (alreadyImported) {
      await setSvgCutImportNote(tx, packetId, 'SVG refresh skipped: packet has no cut layout');
      return;
    }
    await setSvgCutImportState(tx, packetId, 'none', null, null, null);
    return;
  }
  if (options.refreshImported !== true && await skipExistingTelegramSvgCutJobForSourceFile(tx, packetId, dto)) return;
  const lenientValidation = options.validationMode === 'lenient';
  if (layout.status !== 'valid' && !lenientValidation) {
    if (alreadyImported) {
      await setSvgCutImportNote(tx, packetId, `SVG refresh skipped: ${cutLayoutReason(layout, 'SVG layout invalid')}`);
      return;
    }
    await setSvgCutImportState(tx, packetId, 'skipped', cutLayoutReason(layout, 'SVG layout invalid'), null, null);
    return;
  }

  let plan = await buildSvgCutImportPlan(tx, dto, matchSourceDto, layout, {
    matchMode: options.matchMode ?? 'order_details',
    validationMode: options.validationMode ?? 'strict',
    selectedOrderIds: options.selectedOrderIds ?? [],
  });
  if (!plan.ok) {
    if (alreadyImported) {
      await setSvgCutImportNote(tx, packetId, `SVG refresh skipped: ${plan.reason}`);
      return;
    }
    const fallbackPlan = buildTelegramInformationalSvgCutImportPlan(dto, layout, plan.reason);
    if (fallbackPlan.ok) {
      plan = fallbackPlan;
    } else {
      await setSvgCutImportState(tx, packetId, 'needs_review', plan.reason, null, null);
      return;
    }
  }

  const cuttingSequenceNo = toPositiveInteger(row.cutting_sequence_no);
  if (cuttingSequenceNo === null) {
    if (alreadyImported) {
      await setSvgCutImportNote(tx, packetId, 'SVG refresh skipped: packet has no cutting sequence number');
      return;
    }
    await setSvgCutImportState(tx, packetId, 'needs_review', 'SVG Telegram packet has no cutting sequence number', null, null);
    return;
  }

  if (alreadyImported) {
    await syncSvgCutJobSourceDisplayNumber(tx, row.svg_cut_job_id, options.requestedCutJobId ?? row.cutting_sequence_no);
    const refreshed = await refreshImportedSvgCutResult(
      tx,
      packetId,
      dto,
      plan,
      actorUserId,
      toNumber(row.svg_cut_job_id),
      toNumber(row.svg_cut_result_id),
    );
    if (!refreshed.ok) {
      await setSvgCutImportNote(tx, packetId, `SVG refresh skipped: ${refreshed.reason}`);
      return;
    }
    await setSvgCutImportState(tx, packetId, 'imported', 'SVG layout refreshed from Telegram SVG', refreshed.cutJobId, refreshed.cutResultId);
    return;
  }

  let imported: { cutJobId: number; cutResultId: number | null };
  try {
    imported = await createSvgCutJob(
      tx,
      packetId,
      dto,
      layout,
      plan,
      cuttingSequenceNo,
      actorUserId,
      options.requestedCutJobId ?? null,
    );
  } catch (error) {
    if (isReviewableSvgCutImportError(error)) {
      await setSvgCutImportState(tx, packetId, 'needs_review', svgCutImportErrorNote(error), null, null);
      return;
    }
    throw error;
  }
  await setSvgCutImportState(tx, packetId, 'imported', 'SVG layout imported into cut job', imported.cutJobId, imported.cutResultId);
}

function svgImportOptionsFromDto(dto: CncTelegramStructuredIngestDto): {
  validationMode: CncTelegramManualSvgUploadDto['validationMode'];
  refreshImported: boolean;
} {
  return {
    validationMode: dto.svgImportMode?.validationMode ?? 'strict',
    refreshImported: dto.svgImportMode?.refreshImported === true,
  };
}

async function syncSvgCutJobSourceDisplayNumber(
  tx: TransactionClient,
  cutJobId: string | number | null,
  requestedCutJobId: string | number | null,
): Promise<void> {
  const displayNumber = sourceDisplayNumberFromRequestedCutJobId(requestedCutJobId);
  const resolvedCutJobId = toNullableNumber(cutJobId);
  if (resolvedCutJobId === null || displayNumber === null) return;
  await ensureSvgCutJobDisplayNumberAvailable(tx, displayNumber, resolvedCutJobId);
  await tx.query(
    `UPDATE cut_job
     SET source_display_number = $2,
         updated_at = now()
     WHERE cut_job_id = $1
       AND source_display_number IS DISTINCT FROM $2`,
    [resolvedCutJobId, displayNumber],
  );
}

function sourceDisplayNumberFromRequestedCutJobId(value: string | number | null): string | null {
  const requestedCutJobId = toPositiveInteger(value);
  return requestedCutJobId === null ? null : String(requestedCutJobId);
}

async function lockSvgSourceFileIfPresent(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
): Promise<void> {
  const sourceFile = sourceSvgIdentity(dto.sourceFiles ?? []);
  if (!sourceFile) return;
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`cnc-svg-source:${sourceFile.sha256.toLowerCase()}`],
  );
}

async function skippedExistingTelegramSvgSourceFileResponse(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
  requestId: string,
  currentPacketId: string | null,
): Promise<CncTelegramIngestResponseDto | null> {
  if (dto.source.chatId === MANUAL_SVG_CHAT_ID) return null;
  const match = await findExistingSvgCutJobForSourceFile(tx, dto, currentPacketId);
  if (!match) return null;
  const packet = await loadExistingSvgSourceFilePacket(tx, match);
  const skippedDuplicateSourceFile = skippedDuplicateSourceFileDto(match);
  return {
    packet,
    requestId,
    applied: false,
    ignoredStaleSourceVersion: false,
    skippedDuplicateSourceFile,
  };
}

async function loadExistingSvgSourceFilePacket(
  tx: TransactionClient,
  match: ExistingSvgSourceFileCutJob,
): Promise<CncTelegramPacketDto> {
  if (match.packetId) {
    const packet = await loadPacketIfExists(tx, match.packetId);
    if (packet) return packet;
  }
  const result = await tx.query<{ packet_id: string }>(
    `SELECT packet_id
     FROM cnc_telegram_packets
     WHERE svg_cut_job_id = $1::bigint
     ORDER BY updated_at DESC, packet_id
     LIMIT 1`,
    [match.cutJobId],
  );
  const packetId = result.rows[0]?.packet_id;
  if (packetId) return loadPacket(tx, packetId);
  throw new ApiError(
    409,
    'CNC_TELEGRAM_SVG_SOURCE_FILE_ALREADY_IMPORTED',
    'SVG-файл уже есть в задании на раскрой; новый Telegram packet не создан',
    { skippedDuplicateSourceFile: skippedDuplicateSourceFileDto(match) },
  );
}

async function loadPacketIfExists(
  tx: TransactionClient,
  packetId: string,
): Promise<CncTelegramPacketDto | null> {
  const rows = await tx.query<PacketJoinedRow>(
    packetSelectSql('p.packet_id = $1::uuid'),
    [packetId],
  );
  return mapPacketRows(rows.rows)[0] ?? null;
}

function skippedDuplicateSourceFileDto(
  match: ExistingSvgSourceFileCutJob,
): CncTelegramSkippedDuplicateSourceFileDto {
  return {
    status: 'skipped',
    sha256: match.sha256,
    fileName: match.fileName,
    cutJobId: match.cutJobId,
    cutJobDisplayNumber: match.cutJobDisplayNumber,
    cutResultId: match.cutResultId,
    packetId: match.packetId,
    note: existingSvgSourceFileCutJobNote(match),
  };
}

async function skipExistingTelegramSvgCutJobForSourceFile(
  tx: TransactionClient,
  packetId: string,
  dto: CncTelegramStructuredIngestDto,
): Promise<boolean> {
  if (dto.source.chatId === MANUAL_SVG_CHAT_ID) return false;
  const existingSourceFileJob = await findExistingSvgCutJobForSourceFile(tx, dto, packetId);
  if (!existingSourceFileJob) return false;
  await setSvgCutImportState(
    tx,
    packetId,
    'skipped',
    existingSvgSourceFileCutJobNote(existingSourceFileJob),
    existingSourceFileJob.cutJobId,
    existingSourceFileJob.cutResultId,
  );
  return true;
}

interface ExistingSvgSourceFileCutJob {
  sha256: string;
  cutJobId: number;
  cutJobDisplayNumber: string | null;
  cutResultId: number | null;
  packetId: string | null;
  fileName: string | null;
  matchedBy: 'manual_svg_upload_file' | 'cut_job_selection';
}

interface ExistingSvgSourceFileCutJobRow extends QueryResultRow {
  cut_job_id: string | number;
  cut_job_display_number: string | number | null;
  cut_result_id: string | number | null;
  packet_id: string | null;
  file_name: string | null;
  matched_by: 'manual_svg_upload_file' | 'cut_job_selection';
}

async function findExistingSvgCutJobForSourceFile(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
  currentPacketId: string | null,
): Promise<ExistingSvgSourceFileCutJob | null> {
  const sourceFile = sourceSvgIdentity(dto.sourceFiles ?? []);
  if (!sourceFile) return null;
  const result = await tx.query<ExistingSvgSourceFileCutJobRow>(
    `
    WITH manual_file AS (
      SELECT packet.svg_cut_job_id AS cut_job_id,
             svg_job.source_display_number AS cut_job_display_number,
             packet.svg_cut_result_id AS cut_result_id,
             packet.packet_id::text AS packet_id,
             file.original_file_name AS file_name,
             'manual_svg_upload_file'::text AS matched_by,
             1 AS priority,
             file.updated_at AS matched_at
      FROM cnc_manual_svg_upload_files file
      JOIN cnc_telegram_packets packet ON packet.packet_id=file.packet_id
      JOIN cut_job svg_job ON svg_job.cut_job_id=packet.svg_cut_job_id
      WHERE file.file_kind='svg'
        AND lower(file.content_sha256)=lower($1)
        AND packet.svg_cut_import_status='imported'
        AND packet.svg_cut_job_id IS NOT NULL
        AND svg_job.status <> 'archived'
        AND ($2::uuid IS NULL OR packet.packet_id <> $2::uuid)
      ORDER BY file.updated_at DESC
      LIMIT 1
    ),
    cut_job_selection AS (
      SELECT job.cut_job_id,
             job.source_display_number AS cut_job_display_number,
             packet.svg_cut_result_id AS cut_result_id,
             COALESCE(
               packet.packet_id::text,
               CASE
                 WHEN job.selection_criteria->>'packetId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   THEN job.selection_criteria->>'packetId'
                 ELSE NULL
               END
             ) AS packet_id,
             source_file.value->>'fileName' AS file_name,
             'cut_job_selection'::text AS matched_by,
             2 AS priority,
             job.created_at AS matched_at
      FROM cut_job job
      LEFT JOIN cnc_telegram_packets packet ON packet.svg_cut_job_id=job.cut_job_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(job.selection_criteria->'sourceFiles', '[]'::jsonb)) AS source_file(value)
      WHERE source_file.value->>'kind'='svg'
        AND lower(source_file.value->>'sha256')=lower($1)
        AND job.status <> 'archived'
        AND ($2::uuid IS NULL OR packet.packet_id IS NULL OR packet.packet_id <> $2::uuid)
      ORDER BY job.created_at DESC
      LIMIT 1
    )
    SELECT cut_job_id, cut_job_display_number, cut_result_id, packet_id, file_name, matched_by
    FROM (
      SELECT * FROM manual_file
      UNION ALL
      SELECT * FROM cut_job_selection
    ) matched
    ORDER BY priority, matched_at DESC
    LIMIT 1
    `,
    [sourceFile.sha256, currentPacketId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sha256: sourceFile.sha256.toLowerCase(),
    cutJobId: toNumber(row.cut_job_id),
    cutJobDisplayNumber: nullableDisplayNumber(row.cut_job_id, row.cut_job_display_number),
    cutResultId: toNullableNumber(row.cut_result_id),
    packetId: row.packet_id,
    fileName: normalizeOptional(row.file_name),
    matchedBy: row.matched_by,
  };
}

function sourceSvgIdentity(files: CncTelegramSourceFileIdentityDto[]): CncTelegramSourceFileIdentityDto | null {
  return files.find((file) =>
    file.kind === 'svg' &&
    /^[a-f0-9]{64}$/i.test(file.sha256) &&
    normalizeOptional(file.fileName) !== null
  ) ?? null;
}

function sourceFileIdentitySnapshots(files: CncTelegramSourceFileIdentityDto[]): Array<Record<string, unknown>> {
  return files
    .map((file) => ({
      kind: file.kind,
      fileName: sanitizeManualSvgFileName(file.fileName),
      contentType: normalizeOptional(file.contentType ?? null),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256.toLowerCase(),
    }))
    .filter((file) =>
      (file.kind === 'svg' || file.kind === 'gcode' || file.kind === 'screenshot') &&
      /^[a-f0-9]{64}$/.test(file.sha256) &&
      Number.isInteger(file.sizeBytes) &&
      file.sizeBytes > 0,
    )
    .sort((left, right) => {
      const leftOrder = manualSvgFileKindOrder(left.kind as CncTelegramManualSvgUploadFileDto['kind']);
      const rightOrder = manualSvgFileKindOrder(right.kind as CncTelegramManualSvgUploadFileDto['kind']);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.fileName).localeCompare(String(right.fileName));
    });
}

function existingSvgSourceFileCutJobNote(match: ExistingSvgSourceFileCutJob): string {
  const number = match.cutJobDisplayNumber ?? String(match.cutJobId);
  const fileName = match.fileName ? ` (${match.fileName})` : '';
  return `SVG-файл уже есть в задании на раскрой ${number}${fileName}; Telegram scan не создавал новое задание`;
}

async function setSvgCutImportState(
  tx: TransactionClient,
  packetId: string,
  status: 'none' | 'skipped' | 'needs_review' | 'imported',
  note: string | null,
  cutJobId: number | null,
  cutResultId: number | null,
): Promise<void> {
  await tx.query(
    `UPDATE cnc_telegram_packets
     SET svg_cut_import_status = $2,
         svg_cut_import_note = $3,
         svg_cut_job_id = $4,
         svg_cut_result_id = $5,
         updated_at = now()
     WHERE packet_id = $1::uuid`,
    [packetId, status, note, cutJobId, cutResultId],
  );
}

async function setSvgCutImportNote(
  tx: TransactionClient,
  packetId: string,
  note: string,
): Promise<void> {
  await tx.query(
    `UPDATE cnc_telegram_packets
     SET svg_cut_import_note = $2,
         updated_at = now()
     WHERE packet_id = $1::uuid`,
    [packetId, note],
  );
}

type SvgCutImportPlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      sheetWidthMm: number;
      sheetHeightMm: number;
      sheetMaterialTypeId: number | null;
      filmId: number | null;
      materialName: string | null;
      informational: boolean;
      details: SvgCutDetail[];
      placements: SvgCutPlacement[];
    };

type SvgCutPlacement = CncTelegramCutLayoutItemDto & {
  orderId: number | null;
  orderDetailId: number | null;
  itemKey: string;
  orderName: string;
  materialName?: string | null;
};

interface SvgCutDetail {
  detailId: number;
  orderId: number;
  orderName: string | null;
  orderDeleted: boolean;
  detailNumber: number | null;
  detailName: string | null;
  height: number | null;
  width: number | null;
  orderQuantity: number | null;
  cutQuantity: number;
  area: number | null;
  materialId: number | null;
  sheetMaterialTypeId: number | null;
  sheetMaterialWidthMm: number | null;
  sheetMaterialHeightMm: number | null;
  materialName: string | null;
  doweling: boolean | null;
  millingTypeId: number | null;
  millingTypeName: string | null;
  edgeTypeId: number | null;
  edgeTypeName: string | null;
  filmId: number | null;
  filmName: string | null;
  priority: number | null;
  productionStatusId: number | null;
  productionStatusName: string | null;
  jointOrderId: number | null;
  note: string | null;
  linkCuttingFile: string | null;
  linkCuttingImageFile: string | null;
  linkCadFile: string | null;
  linkPdfFile: string | null;
}

interface SvgCutDetailRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  order_name: string | null;
  order_delete_flag: boolean | null;
  detail_number: string | number | null;
  detail_name: string | null;
  height: string | number | null;
  width: string | number | null;
  order_quantity: string | number | null;
  area: string | number | null;
  material_id: string | number | null;
  sheet_material_type_id: string | number | null;
  sheet_material_width_mm: string | number | null;
  sheet_material_height_mm: string | number | null;
  material_name: string | null;
  doweling: boolean | null;
  milling_type_id: string | number | null;
  milling_type_name: string | null;
  edge_type_id: string | number | null;
  edge_type_name: string | null;
  film_id: string | number | null;
  film_name: string | null;
  priority: string | number | null;
  production_status_id: string | number | null;
  production_status_name: string | null;
  joint_order_id: string | number | null;
  note: string | null;
  link_cutting_file: string | null;
  link_cutting_image_file: string | null;
  link_cad_file: string | null;
  link_pdf_file: string | null;
}

async function buildSvgCutImportPlan(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
  matchSourceDto: CncTelegramStructuredIngestDto,
  layout: CncTelegramCutLayoutDto,
  options: {
    matchMode: CncTelegramManualSvgUploadDto['matchMode'];
    validationMode: CncTelegramManualSvgUploadDto['validationMode'];
    selectedOrderIds: number[];
  } = { matchMode: 'order_details', validationMode: 'strict', selectedOrderIds: [] },
): Promise<SvgCutImportPlan> {
  const sheet = layout.sheet;
  const items = layout.items ?? [];
  if (!sheet || !isPositiveFinite(sheet.widthMm) || !isPositiveFinite(sheet.heightMm)) {
    return { ok: false, reason: 'SVG layout has no valid sheet size' };
  }
  if (items.length === 0) {
    return { ok: false, reason: cutLayoutReason(layout, 'SVG layout has no placed details') };
  }
  if (options.matchMode === 'informational') {
    return buildInformationalSvgCutImportPlan(tx, dto, layout, options.selectedOrderIds, {
      allowOutOfSheet: options.validationMode === 'lenient',
    });
  }
  if (options.validationMode === 'lenient') {
    return buildLenientSvgCutImportPlan(tx, dto, matchSourceDto, layout, options.selectedOrderIds);
  }

  const matchedItems = new Map<string, IngestItemInput>();
  for (const item of matchSourceDto.items) {
    const key = svgLayoutMatchKey(item.orderName, item.detailNumber ?? null, item.widthMm ?? null, item.heightMm ?? null);
    if (!key) continue;
    const existing = matchedItems.get(key);
    if (existing) {
      matchedItems.set(key, {
        ...existing,
        quantity: existing.quantity + item.quantity,
      });
    } else {
      matchedItems.set(key, item);
    }
  }

  const placements: SvgCutPlacement[] = [];
  const countByDetail = new Map<number, number>();
  const countByLayoutKey = new Map<string, number>();
  for (const item of items) {
    const key = svgLayoutMatchKey(item.orderName, item.detailNumber, item.widthMm, item.heightMm);
    if (!key) return { ok: false, reason: 'SVG layout item has incomplete order/detail/size identity' };
    const match = matchedItems.get(key);
    if (!match || match.matchStatus !== 'matched' || match.matchOrderId == null || match.matchDetailId == null) {
      return { ok: false, reason: `SVG detail ${item.orderName}#${item.detailNumber} ${item.widthMm}x${item.heightMm} is not uniquely matched to an order detail` };
    }
    if (!layoutGeometryInsideSheet(item, sheet.widthMm, sheet.heightMm)) {
      return { ok: false, reason: `SVG detail ${item.orderName}#${item.detailNumber} is outside sheet bounds` };
    }
    placements.push({
      ...item,
      orderId: match.matchOrderId,
      orderDetailId: match.matchDetailId,
      itemKey: freecutItemId(match.matchDetailId),
    });
    countByDetail.set(match.matchDetailId, (countByDetail.get(match.matchDetailId) ?? 0) + 1);
    countByLayoutKey.set(key, (countByLayoutKey.get(key) ?? 0) + 1);
  }

  for (const [key, count] of countByLayoutKey.entries()) {
    const match = matchedItems.get(key);
    if (match && match.quantity !== count) {
      return { ok: false, reason: `SVG placement count ${count} differs from parsed item quantity ${match.quantity} for ${match.orderName}#${match.detailNumber}` };
    }
  }

  const detailRows = await loadSvgCutDetails(tx, [...countByDetail.keys()]);
  if (detailRows.size !== countByDetail.size) {
    return { ok: false, reason: 'Not all SVG matched details still exist in active orders' };
  }
  const details = [...countByDetail.entries()].map(([detailId, cutQuantity]) => {
    const detail = detailRows.get(detailId);
    if (!detail) throw new Error(`missing detail ${detailId}`);
    return { ...detail, cutQuantity };
  });

  const sheetMaterialIds = uniqueValues(details.map((detail) => detail.sheetMaterialTypeId));
  if (sheetMaterialIds.length !== 1 || sheetMaterialIds[0] === null) {
    return { ok: false, reason: 'SVG layout spans multiple or missing sheet material specs' };
  }
  const filmIds = uniqueValues(details.map((detail) => detail.filmId));
  const groupFilmId = filmIds.length === 1 ? filmIds[0] : null;
  const materialDetail = details.find((detail) => detail.sheetMaterialTypeId === sheetMaterialIds[0]);
  if (
    materialDetail?.sheetMaterialWidthMm != null &&
    materialDetail.sheetMaterialHeightMm != null &&
    !sheetDimsMatch(sheet.widthMm, sheet.heightMm, materialDetail.sheetMaterialWidthMm, materialDetail.sheetMaterialHeightMm)
  ) {
    return { ok: false, reason: `SVG sheet ${sheet.widthMm}x${sheet.heightMm} does not match material sheet ${materialDetail.sheetMaterialWidthMm}x${materialDetail.sheetMaterialHeightMm}` };
  }

  return {
    ok: true,
    sheetWidthMm: round3(sheet.widthMm),
    sheetHeightMm: round3(sheet.heightMm),
    sheetMaterialTypeId: sheetMaterialIds[0],
    filmId: groupFilmId,
    materialName: materialDetail?.materialName ?? normalizeOptional(dto.materialName),
    informational: false,
    details,
    placements,
  };
}

async function buildLenientSvgCutImportPlan(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
  matchSourceDto: CncTelegramStructuredIngestDto,
  layout: CncTelegramCutLayoutDto,
  selectedOrderIds: number[],
): Promise<SvgCutImportPlan> {
  const sheet = layout.sheet;
  const items = layout.items ?? [];
  if (!sheet || !isPositiveFinite(sheet.widthMm) || !isPositiveFinite(sheet.heightMm)) {
    return { ok: false, reason: 'SVG layout has no valid sheet size' };
  }
  const effectiveSelectedOrderIds = selectedOrderIds.length > 0
    ? selectedOrderIds
    : await inferTelegramSvgSelectedOrderIds(tx, matchSourceDto, layout);
  if (effectiveSelectedOrderIds.length === 0) {
    return { ok: false, reason: 'Для нестрогой загрузки SVG не выбраны заказы' };
  }

  const selectedOrders = await assertManualSvgSelectedOrdersExist(tx, effectiveSelectedOrderIds);
  const matchedItems = new Map<string, IngestItemInput>();
  for (const item of matchSourceDto.items) {
    const key = svgLayoutMatchKey(item.orderName, item.detailNumber ?? null, item.widthMm ?? null, item.heightMm ?? null);
    if (!key) continue;
    const existing = matchedItems.get(key);
    if (!existing || item.matchStatus === 'matched') {
      matchedItems.set(key, item);
    }
  }

  const placements: SvgCutPlacement[] = [];
  const countByDetail = new Map<number, number>();
  for (const [index, item] of items.entries()) {
    const key = svgLayoutMatchKey(item.orderName, item.detailNumber, item.widthMm, item.heightMm);
    const match = key ? matchedItems.get(key) : null;
    const matchedOrderId = match?.matchStatus === 'matched' ? toPositiveInteger(match.matchOrderId) : null;
    const matchedDetailId = match?.matchStatus === 'matched' ? toPositiveInteger(match.matchDetailId) : null;
    const fallbackOrder = informationalOrderForLayoutItem(item, index, selectedOrders);
    const orderId = matchedOrderId ?? fallbackOrder.orderId;
    const orderName = matchedOrderId !== null
      ? item.orderName || match?.orderName || String(matchedOrderId)
      : informationalLayoutOrderName(item, fallbackOrder);
    const orderDetailId = matchedDetailId;
    placements.push({
      ...item,
      orderName,
      orderId,
      orderDetailId,
      itemKey: orderDetailId !== null ? freecutItemId(orderDetailId) : informationalSvgItemKey(item, index),
      materialName: normalizeOptional(dto.materialName),
    });
    if (orderDetailId !== null) {
      countByDetail.set(orderDetailId, (countByDetail.get(orderDetailId) ?? 0) + 1);
    }
  }

  const detailRows = await loadSvgCutDetails(tx, [...countByDetail.keys()]);
  const details = [...countByDetail.entries()].flatMap(([detailId, cutQuantity]) => {
    const detail = detailRows.get(detailId);
    return detail ? [{ ...detail, cutQuantity }] : [];
  });
  const availableDetailIds = new Set(details.map((detail) => detail.detailId));
  const normalizedPlacements = placements.map((placement, index) => {
    if (placement.orderDetailId === null || availableDetailIds.has(placement.orderDetailId)) return placement;
    return {
      ...placement,
      orderDetailId: null,
      itemKey: informationalSvgItemKey(placement, index),
    };
  });
  const sheetMaterialIds = uniqueValues(details.map((detail) => detail.sheetMaterialTypeId).filter(isPositiveNumber));
  const filmIds = uniqueValues(details.map((detail) => detail.filmId).filter(isPositiveNumber));
  const materialDetail = sheetMaterialIds.length === 1
    ? details.find((detail) => detail.sheetMaterialTypeId === sheetMaterialIds[0]) ?? null
    : null;

  return {
    ok: true,
    sheetWidthMm: round3(sheet.widthMm),
    sheetHeightMm: round3(sheet.heightMm),
    sheetMaterialTypeId: sheetMaterialIds.length === 1 ? sheetMaterialIds[0] : null,
    filmId: filmIds.length === 1 ? filmIds[0] : null,
    materialName: normalizeOptional(dto.materialName) ?? materialDetail?.materialName ?? null,
    informational: true,
    details,
    placements: normalizedPlacements,
  };
}

async function buildInformationalSvgCutImportPlan(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
  layout: CncTelegramCutLayoutDto,
  selectedOrderIds: number[],
  options: { allowOutOfSheet?: boolean } = {},
): Promise<SvgCutImportPlan> {
  const sheet = layout.sheet;
  const items = layout.items ?? [];
  if (!sheet || !isPositiveFinite(sheet.widthMm) || !isPositiveFinite(sheet.heightMm)) {
    return { ok: false, reason: 'SVG layout has no valid sheet size' };
  }
  if (selectedOrderIds.length === 0) {
    return { ok: false, reason: 'Для информативного SVG не выбраны заказы' };
  }

  const selectedOrders = await assertManualSvgSelectedOrdersExist(tx, selectedOrderIds);
  const placements: SvgCutPlacement[] = [];
  for (const [index, item] of items.entries()) {
    if (!options.allowOutOfSheet && !layoutGeometryInsideSheet(item, sheet.widthMm, sheet.heightMm)) {
      return { ok: false, reason: `SVG деталь ${item.orderName}#${item.detailNumber} выходит за границы листа` };
    }
    const order = informationalOrderForLayoutItem(item, index, selectedOrders);
    placements.push({
      ...item,
      orderName: informationalLayoutOrderName(item, order),
      orderId: order.orderId,
      orderDetailId: null,
      itemKey: informationalSvgItemKey(item, index),
      materialName: normalizeOptional(dto.materialName),
    });
  }

  return {
    ok: true,
    sheetWidthMm: round3(sheet.widthMm),
    sheetHeightMm: round3(sheet.heightMm),
    sheetMaterialTypeId: null,
    filmId: null,
    materialName: normalizeOptional(dto.materialName),
    informational: true,
    details: [],
    placements,
  };
}

function buildTelegramInformationalSvgCutImportPlan(
  dto: CncTelegramStructuredIngestDto,
  layout: CncTelegramCutLayoutDto,
  strictFailureReason: string,
): SvgCutImportPlan {
  if (dto.source.chatId === MANUAL_SVG_CHAT_ID || !isTelegramSvgDetailMatchFailure(strictFailureReason)) {
    return { ok: false, reason: strictFailureReason };
  }
  const sheet = layout.sheet;
  const items = layout.items ?? [];
  if (!sheet || !isPositiveFinite(sheet.widthMm) || !isPositiveFinite(sheet.heightMm)) {
    return { ok: false, reason: strictFailureReason };
  }
  if (items.length === 0) {
    return { ok: false, reason: strictFailureReason };
  }
  const placements: SvgCutPlacement[] = [];
  for (const [index, item] of items.entries()) {
    if (!layoutGeometryInsideSheet(item, sheet.widthMm, sheet.heightMm)) {
      return { ok: false, reason: strictFailureReason };
    }
    placements.push({
      ...item,
      orderName: normalizeOptional(item.orderName) ?? 'SVG',
      orderId: null,
      orderDetailId: null,
      itemKey: informationalSvgItemKey(item, index),
      materialName: normalizeOptional(dto.materialName),
    });
  }
  return {
    ok: true,
    sheetWidthMm: round3(sheet.widthMm),
    sheetHeightMm: round3(sheet.heightMm),
    sheetMaterialTypeId: null,
    filmId: null,
    materialName: normalizeOptional(dto.materialName),
    informational: true,
    details: [],
    placements,
  };
}

function isTelegramSvgDetailMatchFailure(reason: string): boolean {
  return reason.includes('is not uniquely matched to an order detail');
}

function informationalOrderForLayoutItem(
  item: CncTelegramCutLayoutItemDto,
  index: number,
  selectedOrders: ManualSvgSelectedOrder[],
): ManualSvgSelectedOrder {
  const itemOrderKey = normalizeOrderKey(item.orderName);
  const exact = itemOrderKey
    ? selectedOrders.find((order) => (
        normalizeOrderKey(order.orderName) === itemOrderKey ||
        String(order.orderId) === item.orderName.trim()
      ))
    : null;
  return exact ?? selectedOrders[index % selectedOrders.length] ?? selectedOrders[0]!;
}

function informationalLayoutOrderName(
  item: CncTelegramCutLayoutItemDto,
  order: ManualSvgSelectedOrder,
): string {
  const current = normalizeOptional(item.orderName);
  if (current && current !== 'SVG' && !current.includes('+')) {
    const currentKey = normalizeOrderKey(current);
    if (
      currentKey &&
      (currentKey === normalizeOrderKey(order.orderName) || current.trim() === String(order.orderId))
    ) {
      return current;
    }
  }
  return normalizeOptional(order.orderName) ?? String(order.orderId);
}

function informationalSvgItemKey(item: CncTelegramCutLayoutItemDto, index: number): string {
  const sourceId = normalizeOptional(item.sourceElementId)?.replace(/[^a-zA-Z0-9:_-]/g, '_') ?? `part-${index + 1}`;
  return `svg-${index + 1}-${sourceId}`.slice(0, 96);
}

async function loadSvgCutDetails(tx: TransactionClient, detailIds: number[]): Promise<Map<number, Omit<SvgCutDetail, 'cutQuantity'>>> {
  if (detailIds.length === 0) return new Map();
  const rows = await tx.query<SvgCutDetailRow>(
    `
    SELECT od.detail_id, od.order_id, ord.order_name, ord.delete_flag AS order_delete_flag,
           od.detail_number, od.detail_name, od.height, od.width, od.quantity AS order_quantity,
           od.area, od.material_id, od.sheet_material_type_id,
           smt.width_mm AS sheet_material_width_mm,
           smt.height_mm AS sheet_material_height_mm,
           COALESCE(smt.name, materials.material_name) AS material_name,
           od.doweling,
           od.milling_type_id, mt.milling_type_name,
           od.edge_type_id, et.edge_type_name,
           od.film_id, films.film_name,
           od.priority, od.production_status_id, ps.production_status_name,
           od.joint_order_id, od.note,
           od.link_cutting_file, od.link_cutting_image_file, od.link_cad_file, od.link_pdf_file
    FROM order_details od
    JOIN orders ord ON ord.order_id = od.order_id
    LEFT JOIN materials ON materials.material_id = od.material_id
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
    LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
    LEFT JOIN edge_types et ON et.edge_type_id = od.edge_type_id
    LEFT JOIN films ON films.film_id = od.film_id
    LEFT JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
    WHERE od.detail_id = ANY($1::bigint[])
      AND od.delete_flag = false
      AND ord.delete_flag = false
    `,
    [detailIds],
  );
  const out = new Map<number, Omit<SvgCutDetail, 'cutQuantity'>>();
  for (const row of rows.rows) {
    const detailId = toNumber(row.detail_id);
    out.set(detailId, {
      detailId,
      orderId: toNumber(row.order_id),
      orderName: row.order_name,
      orderDeleted: row.order_delete_flag === true,
      detailNumber: toNullableNumber(row.detail_number),
      detailName: row.detail_name,
      height: toNullableNumber(row.height),
      width: toNullableNumber(row.width),
      orderQuantity: toNullableNumber(row.order_quantity),
      area: toNullableNumber(row.area),
      materialId: toNullableNumber(row.material_id),
      sheetMaterialTypeId: toNullableNumber(row.sheet_material_type_id),
      sheetMaterialWidthMm: toNullableNumber(row.sheet_material_width_mm),
      sheetMaterialHeightMm: toNullableNumber(row.sheet_material_height_mm),
      materialName: row.material_name,
      doweling: row.doweling === null || row.doweling === undefined ? null : row.doweling === true,
      millingTypeId: toNullableNumber(row.milling_type_id),
      millingTypeName: row.milling_type_name,
      edgeTypeId: toNullableNumber(row.edge_type_id),
      edgeTypeName: row.edge_type_name,
      filmId: toNullableNumber(row.film_id),
      filmName: row.film_name,
      priority: toNullableNumber(row.priority),
      productionStatusId: toNullableNumber(row.production_status_id),
      productionStatusName: row.production_status_name,
      jointOrderId: toNullableNumber(row.joint_order_id),
      note: row.note,
      linkCuttingFile: row.link_cutting_file,
      linkCuttingImageFile: row.link_cutting_image_file,
      linkCadFile: row.link_cad_file,
      linkPdfFile: row.link_pdf_file,
    });
  }
  return out;
}

async function createSvgCutJob(
  tx: TransactionClient,
  packetId: string,
  dto: CncTelegramStructuredIngestDto,
  layout: CncTelegramCutLayoutDto,
  plan: Extract<SvgCutImportPlan, { ok: true }>,
  cuttingSequenceNo: number,
  actorUserId: string,
  requestedCutJobId: number | null = null,
): Promise<{ cutJobId: number; cutResultId: number | null }> {
  const params = SVG_REVERSE_IMPORT_PARAMS;
  const requestedSourceDisplayNumber = requestedCutJobId === null ? null : String(requestedCutJobId);
  if (requestedSourceDisplayNumber !== null) {
    await ensureSvgCutJobDisplayNumberAvailable(tx, requestedSourceDisplayNumber, null);
  }
  const isManualSvgUpload = dto.source.chatId === MANUAL_SVG_CHAT_ID;
  const selectionSource = isManualSvgUpload ? 'manual_svg_upload' : 'cnc_telegram_svg';
  const selectionCriteria = {
    source: selectionSource,
    externalPacketKey: dto.externalPacketKey,
    packetId,
    cuttingSequenceNo,
    requestedCutJobId,
    sourceVersion: dto.source.version,
    programName: dto.programName ?? null,
    machine: dto.machine ?? null,
    sourceFiles: sourceFileIdentitySnapshots(dto.sourceFiles ?? []),
    cutLayout: {
      sheet: layout.sheet,
      acceptedItemCount: layout.acceptedItemCount ?? layout.items.length,
      partContourCount: layout.partContourCount ?? null,
    },
  };
  const jobName = truncateText(dto.programName ?? `SVG ${dto.externalPacketKey}`, 200);
  const requestHash = sha256Json({ selectionCriteria, placements: plan.placements });
  const commandId = randomUUID();
  const commandPayloadHash = sha256Json({
    type: 'manual_save',
    source: isManualSvgUpload ? 'manual_svg_upload_reverse_import' : 'cnc_telegram_svg_reverse_import',
    packetId,
    externalPacketKey: dto.externalPacketKey,
    sourceVersion: dto.source.version,
    cuttingSequenceNo,
    requestHash,
  });
  const resolvedSourceDisplayNumber = requestedSourceDisplayNumber
    ?? await allocateCutJobSourceDisplayNumber(tx, 'regular');
  const cutJobInsertParams = [
    jobName,
    JSON.stringify(selectionCriteria),
    JSON.stringify(params),
    requestHash,
    toNullableNumber(actorUserId),
    requestHash,
    plan.sheetMaterialTypeId,
    resolvedSourceDisplayNumber,
  ];
  const job = await tx.query<{ cut_job_id: string | number; created_at: string | Date }>(
    `
      INSERT INTO cut_job (
        name, status, source, selection_criteria, params, request_hash,
        pdf_prewarm_state, created_by, version, last_calc_params, last_calc_basis,
        sheet_material_type_id, combine_films, split_by_material, source_display_number
      )
      VALUES (
        $1, 'ready', 'api', $2::jsonb, $3::jsonb, $4,
        'pending', $5, 1, $3::jsonb, $6,
        $7, false, true, $8
      )
      RETURNING cut_job_id, created_at
      `,
    cutJobInsertParams,
  );
  const cutJobId = toNumber(job.rows[0].cut_job_id);
  const cutJobCreatedAt = toIso(job.rows[0].created_at);
  const groupKey = `svg:m:${plan.sheetMaterialTypeId ?? 'none'}:f:${plan.filmId ?? 'none'}`;
  const summary = buildSvgCutSummary(plan, selectionSource);
  const group = await tx.query<{ cut_group_id: string | number }>(
    `
    INSERT INTO cut_group (
      cut_job_id, sheet_material_type_id, film_id, status, pdf_template_code,
      summary, group_key
    )
    VALUES ($1, $2, $3, 'ready', 'standard', $4::jsonb, $5)
    RETURNING cut_group_id
    `,
    [cutJobId, plan.sheetMaterialTypeId, plan.filmId, JSON.stringify(summary), groupKey],
  );
  const cutGroupId = toNumber(group.rows[0].cut_group_id);

  const items: CutJobItemDto[] = [];
  for (const detail of plan.details) {
    const inserted = await tx.query<{ cut_job_item_id: string | number }>(
      `
      INSERT INTO cut_job_item (
        cut_job_id, cut_group_id, order_detail_id, order_id, qty, is_active, freecut_item_id
      )
      VALUES ($1, $2, $3, $4, $5, true, $6)
      RETURNING cut_job_item_id
      `,
      [cutJobId, cutGroupId, detail.detailId, detail.orderId, detail.cutQuantity, freecutItemId(detail.detailId)],
    );
    items.push(buildCutJobItemDto(inserted.rows[0].cut_job_item_id, cutGroupId, detail));
  }

  const itemByDetailId = new Map(items.map((item) => [item.orderDetailId, item]));
  const placements = buildSvgSheetPlacements(plan, itemByDetailId);
  const renderSnapshot = buildSvgRenderSnapshot(placements, itemByDetailId, dto.programName ?? dto.externalPacketKey, plan);
  const sheet = await tx.query<{ cut_group_sheet_id: string | number }>(
    `
    INSERT INTO cut_group_sheet (
      cut_group_id, sheet_index, sheet_material_type_id, placements
    )
    VALUES ($1, 0, $2, $3::jsonb)
    RETURNING cut_group_sheet_id
    `,
    [cutGroupId, plan.sheetMaterialTypeId, JSON.stringify(placements)],
  );
  const cutGroupSheetId = toNumber(sheet.rows[0].cut_group_sheet_id);
  if (!svgPlanCanCreateCutResult(plan)) {
    return { cutJobId, cutResultId: null };
  }
  const totals = buildSvgCutTotals(plan);
  const snapshot: CutJobDto = {
    cutJobId,
    displayNumber: formatCutJobNumber(cutJobId, false, resolvedSourceDisplayNumber),
    createdAt: cutJobCreatedAt,
    name: jobName,
    status: 'ready',
    source: 'api',
    version: 1,
    pdfPrewarmState: 'pending',
    failureCode: null,
    failureReason: null,
    paramProfileId: null,
    sheetMaterialTypeId: plan.sheetMaterialTypeId,
    pdfTemplate: 'standard',
    combineFilms: false,
    splitByMaterial: true,
    rotationAllowed: true,
    textureDirection: 'none',
    materialNames: plan.details.length > 0
      ? uniqueValues(plan.details.map((detail) => detail.materialName).filter((value): value is string => Boolean(value)))
      : uniqueValues([plan.materialName].filter((value): value is string => Boolean(value))),
    totals,
    items,
    groups: [{
      cutGroupId,
      sheetMaterialTypeId: plan.sheetMaterialTypeId,
      filmId: plan.filmId,
      status: 'ready',
      pdfTemplate: 'standard',
      summary,
      groupKey,
      renderToken: `snapshot:g${cutGroupId}:m0:a0`,
      sheets: [{
        cutGroupSheetId,
        sheetIndex: 0,
        pngCacheKey: null,
        placements,
        renderSnapshot,
      }],
      manualLayout: null,
    }],
    editorParams: { kerfMm: 0, spacingMm: 0 },
    unplaced: [],
    requiresRecalc: false,
    autoLayoutValidation: { valid: true },
    renderToken: 'snapshot:j1',
  };
  const manifest = buildSvgCutResultManifest(snapshot);
  await tx.query(
    `INSERT INTO cut_result_command
       (cut_job_id, command_id, command_type, payload_hash, status, created_by)
     VALUES ($1, $2::uuid, 'manual_save', $3, 'in_progress', $4)`,
    [cutJobId, commandId, commandPayloadHash, toNullableNumber(actorUserId)],
  );
  const result = await tx.query<{ cut_result_id: string | number }>(
    `
    INSERT INTO cut_result (
      cut_job_id, result_no, revision_no, result_kind, source_job_version,
      command_id, command_payload_hash, request_hash, snapshot_job, snapshot_manifest, snapshot_digest,
      totals_snapshot, created_by
    )
    VALUES (
      $1, 1, 1, 'manual', 1,
      $2::uuid, $3, $4, $5::jsonb, $6::jsonb, cut_result_snapshot_digest($5::jsonb),
      $7::jsonb, $8
    )
    RETURNING cut_result_id
    `,
    [
      cutJobId,
      commandId,
      commandPayloadHash,
      requestHash,
      JSON.stringify(snapshot),
      JSON.stringify(manifest),
      JSON.stringify(totals),
      toNullableNumber(actorUserId),
    ],
  );
  const cutResultId = toNumber(result.rows[0].cut_result_id);
  await tx.query(
    `UPDATE cut_job
     SET current_cut_result_id = $2, next_cut_result_no = 2
     WHERE cut_job_id = $1`,
    [cutJobId, cutResultId],
  );
  await tx.query(
    `UPDATE cut_result_command
     SET status = 'completed', cut_result_id = $3, completed_at = now(),
         owner_token = NULL, heartbeat_at = now(), lease_expires_at = NULL
     WHERE cut_job_id = $1 AND command_id = $2::uuid AND status = 'in_progress'`,
    [cutJobId, commandId, cutResultId],
  );
  return { cutJobId, cutResultId };
}

async function refreshImportedSvgCutResult(
  tx: TransactionClient,
  packetId: string,
  dto: CncTelegramStructuredIngestDto,
  plan: Extract<SvgCutImportPlan, { ok: true }>,
  actorUserId: string,
  cutJobId: number,
  previousCutResultId: number,
): Promise<{ ok: true; cutJobId: number; cutResultId: number } | { ok: false; reason: string }> {
  const state = await tx.query<{
    version: string | number;
    next_cut_result_no: string | number;
    current_cut_result_id: string | number | null;
    request_hash: string | null;
    snapshot_job: CutJobDto | null;
  }>(
    `
    SELECT j.version, j.next_cut_result_no, j.current_cut_result_id, j.request_hash,
           current_result.snapshot_job
    FROM cut_job j
    LEFT JOIN cut_result current_result
      ON current_result.cut_result_id = COALESCE(j.current_cut_result_id, $2::bigint)
     AND current_result.cut_job_id = j.cut_job_id
    WHERE j.cut_job_id = $1
    FOR UPDATE OF j
    `,
    [cutJobId, previousCutResultId],
  );
  const row = state.rows[0];
  const baseSnapshot = row?.snapshot_job;
  if (!row || !baseSnapshot) {
    return { ok: false, reason: 'current SVG cut result snapshot is missing' };
  }
  if (baseSnapshot.groups.length !== 1 || baseSnapshot.groups[0]?.sheets.length !== 1) {
    return { ok: false, reason: 'current SVG cut result is not a single imported sheet' };
  }

  const group = baseSnapshot.groups[0]!;
  const sheet = group.sheets[0]!;
  const items = await syncSvgCutJobItemsForPlan(tx, cutJobId, group.cutGroupId, plan, baseSnapshot.items);
  const itemByDetailId = new Map(items.map((item) => [item.orderDetailId, item]));
  const placements = buildSvgSheetPlacements(plan, itemByDetailId);
  const renderSnapshot = buildSvgRenderSnapshot(placements, itemByDetailId, dto.programName ?? dto.externalPacketKey, plan);
  const summary = buildSvgCutSummary(plan, 'cnc_telegram_svg');
  const totals = buildSvgCutTotals(plan);
  const nextSnapshot: CutJobDto = {
    ...baseSnapshot,
    version: toNumber(row.version),
    pdfPrewarmState: 'pending',
    sheetMaterialTypeId: plan.sheetMaterialTypeId,
    materialNames: plan.details.length > 0
      ? uniqueValues(plan.details.map((detail) => detail.materialName).filter((value): value is string => Boolean(value)))
      : uniqueValues([plan.materialName].filter((value): value is string => Boolean(value))),
    totals,
    items,
    groups: [{
      ...group,
      sheetMaterialTypeId: plan.sheetMaterialTypeId,
      filmId: plan.filmId,
      status: 'ready',
      summary,
      sheets: [{
        ...sheet,
        placements,
        renderSnapshot,
        pngCacheKey: null,
      }],
      manualLayout: null,
    }],
    unplaced: [],
    requiresRecalc: false,
    autoLayoutValidation: { valid: true },
  };

  await tx.query(
    `UPDATE cut_group
     SET sheet_material_type_id = $2,
         film_id = $3,
         summary = $4::jsonb,
         status = 'ready'
     WHERE cut_group_id = $1`,
    [group.cutGroupId, plan.sheetMaterialTypeId, plan.filmId, JSON.stringify(summary)],
  );
  await tx.query(
    `UPDATE cut_group_sheet
     SET sheet_material_type_id = $2,
         placements = $3::jsonb
     WHERE cut_group_sheet_id = $1`,
    [sheet.cutGroupSheetId, plan.sheetMaterialTypeId, JSON.stringify(placements)],
  );

  const resultNo = Math.max(1, toNumber(row.next_cut_result_no));
  const commandId = randomUUID();
  const commandPayloadHash = sha256Json({
    type: 'telegram_svg_refresh',
    packetId,
    externalPacketKey: dto.externalPacketKey,
    sourceVersion: dto.source.version,
    cutJobId,
    previousCutResultId,
    placements,
  });
  await tx.query(
    `INSERT INTO cut_result_command
       (cut_job_id, command_id, command_type, payload_hash, status, created_by)
     VALUES ($1, $2::uuid, 'manual_save', $3, 'in_progress', $4)`,
    [cutJobId, commandId, commandPayloadHash, toNullableNumber(actorUserId)],
  );
  const manifest = buildSvgCutResultManifest(nextSnapshot);
  const inserted = await tx.query<{ cut_result_id: string | number }>(
    `
    INSERT INTO cut_result (
      cut_job_id, result_no, revision_no, result_kind, source_job_version,
      based_on_result_id, command_id, command_payload_hash, request_hash,
      snapshot_job, snapshot_manifest, snapshot_digest, totals_snapshot,
      created_by
    )
    VALUES (
      $1, $2, 1, 'manual', $3,
      $4, $5::uuid, $6, $7,
      $8::jsonb, $9::jsonb, cut_result_snapshot_digest($8::jsonb), $10::jsonb,
      $11
    )
    RETURNING cut_result_id
    `,
    [
      cutJobId,
      resultNo,
      toNumber(row.version),
      toNullableNumber(row.current_cut_result_id) ?? previousCutResultId,
      commandId,
      commandPayloadHash,
      row.request_hash,
      JSON.stringify(nextSnapshot),
      JSON.stringify(manifest),
      JSON.stringify(totals),
      toNullableNumber(actorUserId),
    ],
  );
  const cutResultId = toNumber(inserted.rows[0].cut_result_id);
  const verified = await tx.query<{ snapshot_digest: string; computed_digest: string }>(
    `SELECT snapshot_digest, cut_result_snapshot_digest(snapshot_job) AS computed_digest
     FROM cut_result
     WHERE cut_result_id = $1 AND cut_job_id = $2`,
    [cutResultId, cutJobId],
  );
  const digest = verified.rows[0];
  if (!digest || digest.snapshot_digest !== digest.computed_digest) {
    throw new ApiError(500, 'CUT_RESULT_SNAPSHOT_INCOMPLETE', 'Не удалось проверить полноту версии раскроя');
  }

  await tx.query(
    `UPDATE cut_job
     SET current_cut_result_id = $2,
         next_cut_result_no = $3,
         pdf_prewarm_state = 'pending',
         updated_at = now()
     WHERE cut_job_id = $1`,
    [cutJobId, cutResultId, resultNo + 1],
  );
  await tx.query(
    `UPDATE cut_result_command
     SET status = 'completed', cut_result_id = $3, completed_at = now(),
         owner_token = NULL, heartbeat_at = now(), lease_expires_at = NULL
     WHERE cut_job_id = $1 AND command_id = $2::uuid AND status = 'in_progress'`,
    [cutJobId, commandId, cutResultId],
  );
  return { ok: true, cutJobId, cutResultId };
}

async function syncSvgCutJobItemsForPlan(
  tx: TransactionClient,
  cutJobId: number,
  cutGroupId: number,
  plan: Extract<SvgCutImportPlan, { ok: true }>,
  existingItems: CutJobItemDto[],
): Promise<CutJobItemDto[]> {
  if (plan.details.length === 0) return [];
  const existingByDetailId = new Map(existingItems.map((item) => [item.orderDetailId, item]));
  const result: CutJobItemDto[] = [];
  for (const detail of plan.details) {
    const existing = existingByDetailId.get(detail.detailId);
    if (existing) {
      await tx.query(
        `UPDATE cut_job_item
         SET cut_group_id = $3,
             qty = $4,
             is_active = true,
             freecut_item_id = $5
         WHERE cut_job_id = $1
           AND cut_job_item_id = $2`,
        [cutJobId, existing.cutJobItemId, cutGroupId, detail.cutQuantity, freecutItemId(detail.detailId)],
      );
      result.push(buildCutJobItemDto(existing.cutJobItemId, cutGroupId, detail));
      continue;
    }
    const inserted = await tx.query<{ cut_job_item_id: string | number }>(
      `
      INSERT INTO cut_job_item (
        cut_job_id, cut_group_id, order_detail_id, order_id, qty, is_active, freecut_item_id
      )
      VALUES ($1, $2, $3, $4, $5, true, $6)
      RETURNING cut_job_item_id
      `,
      [cutJobId, cutGroupId, detail.detailId, detail.orderId, detail.cutQuantity, freecutItemId(detail.detailId)],
    );
    result.push(buildCutJobItemDto(inserted.rows[0].cut_job_item_id, cutGroupId, detail));
  }
  return result;
}

function svgPlanCanCreateCutResult(plan: Extract<SvgCutImportPlan, { ok: true }>): boolean {
  return !plan.informational || plan.placements.every((placement) => placement.orderId !== null);
}

async function ensureSvgCutJobDisplayNumberAvailable(
  tx: TransactionClient,
  displayNumber: string,
  currentCutJobId: number | null,
): Promise<void> {
  const result = await tx.query<{ cut_job_id: string | number }>(
    `
    SELECT existing_job.cut_job_id
    FROM cut_job existing_job
    WHERE NULLIF(trim(existing_job.source_display_number::text), '') = $1
      AND ($2::bigint IS NULL OR existing_job.cut_job_id <> $2::bigint)
    LIMIT 1
    `,
    [displayNumber, currentCutJobId],
  );
  if (result.rows.length === 0) return;
  const requestedCutJobId = Number(displayNumber);
  const suggestedCutJobIds = Number.isFinite(requestedCutJobId)
    ? await suggestCutJobDisplayNumbers(tx, requestedCutJobId)
    : [];
  throw new ApiError(
    409,
    'CUT_JOB_NUMBER_CONFLICT',
    `Задание на раскрой №${displayNumber} уже существует`,
    { requestedCutJobId, suggestedCutJobIds },
  );
}

async function suggestCutJobDisplayNumbers(tx: TransactionClient, requestedCutJobId: number): Promise<number[]> {
  const result = await tx.query<{ cut_job_id: string | number }>(
    `
    SELECT candidate.cut_job_id
    FROM generate_series($1::bigint + 1, $1::bigint + 200) AS candidate(cut_job_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM cut_job existing_job
      WHERE NULLIF(trim(existing_job.source_display_number::text), '') = candidate.cut_job_id::text
    )
    ORDER BY candidate.cut_job_id
    LIMIT 5
    `,
    [requestedCutJobId],
  );
  return result.rows.map((row) => toNumber(row.cut_job_id)).filter(isPositiveNumber);
}

const SVG_REVERSE_IMPORT_PARAMS = {
  kerf_mm: 0,
  spacing_mm: 0,
  trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
  objective: 'as_imported',
  time_limit_ms: 0,
  restarts: 0,
  layout_mode: 'guillotine',
  retry_strategy: 'disabled',
} as const;

function buildSvgCutSummary(
  plan: Extract<SvgCutImportPlan, { ok: true }>,
  source: 'cnc_telegram_svg' | 'manual_svg_upload',
): Record<string, unknown> {
  const sheetArea = plan.sheetWidthMm * plan.sheetHeightMm;
  const placedArea = plan.placements.reduce((sum, item) => sum + item.placedWidthMm * item.placedHeightMm, 0);
  const wastePercent = sheetArea > 0 ? Math.max(0, ((sheetArea - placedArea) / sheetArea) * 100) : 0;
  return {
    used_stock_count: 1,
    waste_percent: round2(wastePercent),
    engine_used: 'svg_reverse_import',
    source,
  };
}

function buildCutJobItemDto(
  cutJobItemId: string | number,
  cutGroupId: number,
  detail: SvgCutDetail,
): CutJobItemDto {
  return {
    cutJobItemId: toNumber(cutJobItemId),
    orderDetailId: detail.detailId,
    orderId: detail.orderId,
    qty: detail.cutQuantity,
    cutGroupId,
    orderName: detail.orderName,
    orderDeleted: detail.orderDeleted,
    detail: {
      detailFields: null,
      detailNumber: detail.detailNumber,
      detailName: detail.detailName,
      height: detail.height,
      width: detail.width,
      quantity: detail.orderQuantity,
      area: detail.area,
      materialId: detail.materialId,
      sheetMaterialTypeId: detail.sheetMaterialTypeId,
      materialName: detail.materialName,
      doweling: detail.doweling,
      millingTypeId: detail.millingTypeId,
      millingTypeName: detail.millingTypeName,
      edgeTypeId: detail.edgeTypeId,
      edgeTypeName: detail.edgeTypeName,
      filmId: detail.filmId,
      filmName: detail.filmName,
      priority: detail.priority,
      productionStatusId: detail.productionStatusId,
      productionStatusName: detail.productionStatusName,
      jointOrderId: detail.jointOrderId,
      note: detail.note,
      linkCuttingFile: detail.linkCuttingFile,
      linkCuttingImageFile: detail.linkCuttingImageFile,
      linkCadFile: detail.linkCadFile,
      linkPdfFile: detail.linkPdfFile,
    },
  };
}

function buildSvgSheetPlacements(
  plan: Extract<SvgCutImportPlan, { ok: true }>,
  itemByDetailId: ReadonlyMap<number, CutJobItemDto>,
): SheetPlacementsJson {
  const nextInstance = new Map<string, number>();
  const pieces = plan.placements.map((item) => {
    const instance = (nextInstance.get(item.itemKey) ?? 0) + 1;
    nextInstance.set(item.itemKey, instance);
    const jobItem = item.orderDetailId === null ? undefined : itemByDetailId.get(item.orderDetailId);
    return {
      item_id: item.itemKey,
      instance,
      x_mm: round3(item.xMm),
      y_mm: round3(item.yMm),
      width_mm: round3(item.placedWidthMm),
      height_mm: round3(item.placedHeightMm),
      rotated: item.rotated === true,
      source_svg: sourceSvgPlacementFragment(item),
      label: {
        orderId: item.orderId,
        orderName: item.orderName,
        detailId: item.orderDetailId,
        detailNumber: jobItem?.detail?.detailNumber ?? item.detailNumber,
        widthMm: jobItem?.detail?.width ?? item.widthMm,
        heightMm: jobItem?.detail?.height ?? item.heightMm,
        materialName: item.materialName ?? jobItem?.detail?.materialName ?? plan.materialName ?? null,
      },
    };
  });
  return {
    trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
    sheet_width_mm: plan.sheetWidthMm,
    sheet_height_mm: plan.sheetHeightMm,
    pieces,
  };
}

function sourceSvgPlacementFragment(
  item: CncTelegramCutLayoutItemDto,
): SheetPlacementsJson['pieces'][number]['source_svg'] | undefined {
  const fragment = item.sourceSvg;
  if (!fragment?.body.trim()) return undefined;
  return {
    viewBox: {
      x_mm: round3(fragment.viewBox.xMm),
      y_mm: round3(fragment.viewBox.yMm),
      width_mm: round3(fragment.viewBox.widthMm),
      height_mm: round3(fragment.viewBox.heightMm),
    },
    body: fragment.body,
  };
}

function buildSvgRenderSnapshot(
  placements: SheetPlacementsJson,
  itemByDetailId: ReadonlyMap<number, CutJobItemDto>,
  machineFile: string,
  plan: Extract<SvgCutImportPlan, { ok: true }>,
): CutSheetRenderSnapshotDto {
  const itemByItemId = new Map<string, CutJobItemDto>();
  for (const item of itemByDetailId.values()) itemByItemId.set(freecutItemId(item.orderDetailId), item);
  const quantities = new Map<string, number>();
  for (const piece of placements.pieces) quantities.set(piece.item_id, (quantities.get(piece.item_id) ?? 0) + 1);
  const fillForOrder = createOrderFillResolver(plan.placements.map((item) => item.orderId).filter(isPositiveNumber));
  const labelFor = (piece: FreecutPlacement) => {
    const item = itemByItemId.get(piece.item_id);
    const label = (piece as {
      label?: {
        orderId: number | null;
        orderName?: string | null;
        detailId?: number | null;
        detailNumber: number | null;
        widthMm: number | null;
        heightMm: number | null;
        materialName?: string | null;
      };
    }).label;
    return composePieceLabelLines({
      orderId: label?.orderId ?? item?.orderId ?? null,
      orderName: label?.orderName ?? item?.orderName ?? null,
      detailId: label?.detailId ?? item?.orderDetailId ?? null,
      detailNumber: label?.detailNumber ?? item?.detail?.detailNumber ?? null,
      widthMm: label?.widthMm ?? item?.detail?.width ?? null,
      heightMm: label?.heightMm ?? item?.detail?.height ?? null,
      itemId: piece.item_id,
      instance: piece.instance,
      qty: quantities.get(piece.item_id) ?? item?.qty ?? 1,
      materialName: label?.materialName ?? item?.detail?.materialName ?? plan.materialName ?? null,
    });
  };
  const bathDetailInfoFor = (piece: FreecutPlacement) => {
    const detail = itemByItemId.get(piece.item_id)?.detail;
    return {
      edgeTypeName: detail?.edgeTypeName ?? null,
      millingTypeName: detail?.millingTypeName ?? null,
      doweling: detail?.doweling ?? false,
    };
  };
  const fillFor = (piece: FreecutPlacement) => {
    const label = (piece as { label?: { orderId: number | null } }).label;
    const orderId = label?.orderId ?? itemByItemId.get(piece.item_id)?.orderId ?? null;
    return fillForOrder(orderId);
  };
  const views: CutSheetRenderSnapshotDto['views'] = {};
  for (const rotate90 of [false, true]) {
    for (const originTopLeft of rotate90 ? [false, true] : [false]) {
      for (const axisOrigin of ['top-left', 'bottom-left'] as const) {
        for (const showLabels of [false, true]) {
          const key = svgFrozenRenderViewKey({ rotate90, originTopLeft, axisOrigin, showLabels });
          views[key] = {
            svg: buildSheetSvg({ sheet: placements, labelFor, fillFor, rotate90, originTopLeft, axisOrigin, showLabels }),
            bathSvg: buildBathProfileSheetSvg({ sheet: placements, labelFor, fillFor, bathDetailInfoFor, rotate90, originTopLeft, axisOrigin, showLabels: true }),
          };
        }
      }
    }
  }
  return {
    contractVersion: 'cut_sheet_render_v1',
    views,
    pdfMeta: buildSvgPdfMeta(itemByDetailId, machineFile, plan),
    pdfDetailRows: buildSvgPdfDetailRows(itemByDetailId, machineFile, plan),
  };
}

function buildSvgPdfMeta(
  itemByDetailId: ReadonlyMap<number, CutJobItemDto>,
  machineFile: string,
  plan: Extract<SvgCutImportPlan, { ok: true }>,
): Record<string, unknown> {
  return {
    orders: plan.informational || itemByDetailId.size === 0
      ? uniqueValues(plan.placements.map((item) => item.orderName || String(item.orderId ?? ''))).filter(Boolean)
      : uniqueValues([...itemByDetailId.values()].map((item) => item.orderName ?? String(item.orderId))),
    clients: [],
    dates: [],
    readyDates: [],
    materials: plan.informational || itemByDetailId.size === 0
      ? uniqueValues(plan.placements.map((item) => item.materialName ?? plan.materialName).filter((value): value is string => Boolean(value)))
      : uniqueValues([...itemByDetailId.values()].map((item) => item.detail?.materialName).filter((value): value is string => Boolean(value))),
    thicknesses: [],
    films: uniqueValues([...itemByDetailId.values()].map((item) => item.detail?.filmName).filter((value): value is string => Boolean(value))),
    edgeTypes: uniqueValues([...itemByDetailId.values()].map((item) => item.detail?.edgeTypeName).filter((value): value is string => Boolean(value))),
    machineFiles: [machineFile],
  };
}

function buildSvgPdfDetailRows(
  itemByDetailId: ReadonlyMap<number, CutJobItemDto>,
  machineFile: string,
  plan: Extract<SvgCutImportPlan, { ok: true }>,
): Record<string, unknown>[] {
  if (plan.informational) {
    return buildInformationalSvgPdfDetailRows(plan, machineFile);
  }
  return [...itemByDetailId.values()]
    .sort((a, b) => a.orderId - b.orderId || (a.detail?.detailNumber ?? a.orderDetailId) - (b.detail?.detailNumber ?? b.orderDetailId))
    .map((item) => ({
      order: item.orderName ?? String(item.orderId),
      position: item.detail?.detailNumber ?? item.orderDetailId,
      lengthMm: Math.max(item.detail?.width ?? 0, item.detail?.height ?? 0) || null,
      widthMm: Math.min(item.detail?.width ?? 0, item.detail?.height ?? 0) || null,
      quantity: item.qty,
      machineFiles: [machineFile],
      fields: {
        detail_id: item.orderDetailId,
        order_id: item.orderId,
        detail_number: item.detail?.detailNumber ?? null,
        height: item.detail?.height ?? null,
        width: item.detail?.width ?? null,
        quantity: item.qty,
        sheet_quantity: item.qty,
        machine_file: machineFile,
        machine_files: machineFile,
        material_name: item.detail?.materialName ?? null,
        materials: item.detail?.materialName ?? null,
        film_name: item.detail?.filmName ?? null,
        films: item.detail?.filmName ?? null,
        milling_type_name: item.detail?.millingTypeName ?? null,
        edge_type_name: item.detail?.edgeTypeName ?? null,
        production_status_name: item.detail?.productionStatusName ?? null,
      },
      material: item.detail?.materialName ?? null,
      film: item.detail?.filmName ?? null,
    }));
}

function buildInformationalSvgPdfDetailRows(
  plan: Extract<SvgCutImportPlan, { ok: true }>,
  machineFile: string,
): Record<string, unknown>[] {
  const groups = new Map<string, {
    order: string;
    orderId: number | null;
    detailId: number | null;
    position: number;
    widthMm: number;
    heightMm: number;
    quantity: number;
    material: string | null;
  }>();

  for (const item of plan.placements) {
    const key = [
      item.orderId ?? '',
      item.orderName,
      item.orderDetailId ?? '',
      item.detailNumber,
      dimensionKey(item.widthMm),
      dimensionKey(item.heightMm),
      item.materialName ?? plan.materialName ?? '',
    ].join(':');
    const existing = groups.get(key);
    if (existing) {
      existing.quantity += Math.max(1, item.quantity ?? 1);
      continue;
    }
    groups.set(key, {
      order: item.orderName || String(item.orderId ?? ''),
      orderId: item.orderId,
      detailId: item.orderDetailId,
      position: item.detailNumber,
      widthMm: item.widthMm,
      heightMm: item.heightMm,
      quantity: Math.max(1, item.quantity ?? 1),
      material: item.materialName ?? plan.materialName ?? null,
    });
  }

  return [...groups.values()]
    .sort((left, right) => (
      left.order.localeCompare(right.order, 'ru', { numeric: true }) ||
      left.position - right.position ||
      left.widthMm - right.widthMm ||
      left.heightMm - right.heightMm
    ))
    .map((item) => ({
      order: item.order,
      position: item.position,
      lengthMm: Math.max(item.widthMm, item.heightMm),
      widthMm: Math.min(item.widthMm, item.heightMm),
      quantity: item.quantity,
      machineFiles: [machineFile],
      fields: {
        detail_id: item.detailId,
        order_id: item.orderId,
        detail_number: item.position,
        height: item.heightMm,
        width: item.widthMm,
        quantity: item.quantity,
        sheet_quantity: item.quantity,
        machine_file: machineFile,
        machine_files: machineFile,
        material_name: item.material,
        materials: item.material,
      },
      material: item.material,
      film: null,
    }));
}

function buildSvgCutTotals(plan: Extract<SvgCutImportPlan, { ok: true }>): CutJobTotals {
  if (plan.informational) {
    const details = plan.placements.reduce((sum, item) => sum + Math.max(1, item.quantity ?? 1), 0);
    const area = plan.placements.reduce((sum, item) =>
      sum + (item.widthMm * item.heightMm * Math.max(1, item.quantity ?? 1)) / 1_000_000, 0);
    const materialCount = uniqueValues(
      plan.placements
        .map((item) => item.materialName ?? plan.materialName)
        .filter((value): value is string => Boolean(value)),
    ).length;
    return {
      positions: plan.placements.length,
      details,
      area: round2(area),
      sheets: 1,
      materialsCount: materialCount,
      filmsCount: 0,
      filmUsage: [],
    };
  }
  const details = plan.details.reduce((sum, detail) => sum + detail.cutQuantity, 0);
  const area = plan.details.reduce((sum, detail) => sum + (detail.area ?? 0) * detail.cutQuantity, 0);
  const filmsCount = uniqueValues(plan.details.map((detail) => detail.filmId).filter((filmId): filmId is number => filmId !== null)).length;
  return {
    positions: plan.details.length,
    details,
    area: round2(area),
    sheets: 1,
    materialsCount: 1,
    filmsCount,
    filmUsage: [],
  };
}

function buildSvgCutResultManifest(snapshot: CutJobDto): Record<string, unknown> {
  const snapshotPieces = snapshot.groups.flatMap((group) =>
    group.sheets.flatMap((sheet) => sheet.placements.pieces),
  );
  return {
    groups: snapshot.groups.length,
    items: uniqueValues(snapshotPieces.map((piece) => piece.item_id)).length || snapshot.items.length,
    instances: snapshotPieces.length || snapshot.items.reduce((sum, item) => sum + item.qty, 0),
    unplaced: snapshot.unplaced?.length ?? 0,
    variants: snapshot.groups.map((group) => ({
      groupKey: group.groupKey ?? `group:${group.cutGroupId}`,
      autoSheets: group.sheets.map((sheet) => sheet.sheetIndex),
      manualSheets: [],
      renderContract: 'cut_sheet_render_v1',
      autoRenderViews: group.sheets.map((sheet) => Object.keys(sheet.renderSnapshot?.views ?? {}).length),
      manualRenderViews: [],
      manualState: 'none',
    })),
  };
}

function svgFrozenRenderViewKey(view: {
  rotate90?: boolean;
  originTopLeft?: boolean;
  axisOrigin?: 'top-left' | 'bottom-left';
  showLabels?: boolean;
}): string {
  const rotate90 = view.rotate90 === true;
  return [
    rotate90 ? 'r90' : 'r0',
    rotate90 && view.originTopLeft === true ? 'tl' : 'raw',
    view.axisOrigin ?? 'top-left',
    view.showLabels === false ? 'labels-off' : 'labels-on',
  ].join(':');
}

function svgLayoutMatchKey(
  orderName: string | null | undefined,
  detailNumber: number | null | undefined,
  widthMm: number | null | undefined,
  heightMm: number | null | undefined,
): string | null {
  const orderKey = normalizeOrderKey(orderName);
  if (!orderKey || detailNumber == null || widthMm == null || heightMm == null) return null;
  return `${orderKey}|${detailNumber}|${dimensionKey(widthMm)}x${dimensionKey(heightMm)}`;
}

function layoutGeometryInsideSheet(item: CncTelegramCutLayoutItemDto, sheetWidthMm: number, sheetHeightMm: number): boolean {
  const toleranceMm = 2;
  return (
    item.xMm >= -toleranceMm &&
    item.yMm >= -toleranceMm &&
    item.xMm + item.placedWidthMm <= sheetWidthMm + toleranceMm &&
    item.yMm + item.placedHeightMm <= sheetHeightMm + toleranceMm
  );
}

function sheetDimsMatch(svgWidth: number, svgHeight: number, materialWidth: number, materialHeight: number): boolean {
  const toleranceMm = 10;
  const direct = Math.abs(svgWidth - materialWidth) <= toleranceMm && Math.abs(svgHeight - materialHeight) <= toleranceMm;
  const rotated = Math.abs(svgWidth - materialHeight) <= toleranceMm && Math.abs(svgHeight - materialWidth) <= toleranceMm;
  return direct || rotated;
}

function cutLayoutReason(layout: CncTelegramCutLayoutDto, fallback: string): string {
  return layout.reasons.length > 0 ? layout.reasons.join('; ') : fallback;
}

function isReviewableSvgCutImportError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500;
}

function svgCutImportErrorNote(error: ApiError): string {
  return truncateText(error.message, 500);
}

function dimensionKey(value: number): string {
  return String(round3(value));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function uniqueValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, (_key, x: unknown) => {
    if (x !== null && typeof x === 'object' && !Array.isArray(x)) {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return x;
  });
}

async function resolveItemMatches(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
  options: { orderIds?: number[]; tolerantSizeMm?: number } = {},
): Promise<CncTelegramStructuredIngestDto> {
  const orderKeys = Array.from(
    new Set(
      dto.items
        .filter(canResolveItem)
        .map((item) => normalizeOrderKey(item.orderName))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (orderKeys.length === 0) return dto;

  const result = await tx.query<DetailMatchRow>(
    `
    SELECT
      lower(trim(o.order_name)) AS order_key,
      o.order_id,
      od.detail_id,
      od.detail_number,
      od.width,
      od.height
    FROM orders o
    JOIN order_details od ON od.order_id = o.order_id
    WHERE lower(trim(o.order_name)) = ANY($1::text[])
      AND ($2::bigint[] IS NULL OR o.order_id = ANY($2::bigint[]))
      AND o.delete_flag = false
      AND od.delete_flag = false
    ORDER BY o.order_id, od.detail_number NULLS LAST, od.detail_id
    `,
    [orderKeys, options.orderIds && options.orderIds.length > 0 ? options.orderIds : null],
  );
  if (result.rows.length === 0) return dto;

  const detailsByOrder = new Map<string, DetailMatch[]>();
  for (const row of result.rows) {
    const detail = toDetailMatch(row);
    if (!detail) continue;
    const details = detailsByOrder.get(detail.orderKey) ?? [];
    details.push(detail);
    detailsByOrder.set(detail.orderKey, details);
  }
  if (detailsByOrder.size === 0) return dto;

  let changed = false;
  const items = dto.items.map((item) => {
    const orderKey = normalizeOrderKey(item.orderName);
    const details = orderKey ? detailsByOrder.get(orderKey) : undefined;
    const match = details ? resolveItemMatch(item, details, options) : null;
    if (!match) return item;
    changed = true;
    return {
      ...item,
      detailNumber: item.detailNumber ?? match.detailNumber,
      matchOrderId: match.orderId,
      matchDetailId: match.detailId,
      matchStatus: 'matched' as const,
      reviewNote: null,
    };
  });

  return changed ? { ...dto, items } : dto;
}

function aggregateMatchedItems(dto: CncTelegramStructuredIngestDto): CncTelegramStructuredIngestDto {
  const result: IngestItemInput[] = [];
  const matchedByDetail = new Map<string, IngestItemInput>();
  let changed = false;

  for (const item of dto.items) {
    const aggregateKey = matchedItemAggregateKey(item);
    if (!aggregateKey) {
      result.push(item);
      continue;
    }

    const existing = matchedByDetail.get(aggregateKey);
    if (!existing) {
      const copy = { ...item };
      matchedByDetail.set(aggregateKey, copy);
      result.push(copy);
      continue;
    }

    changed = true;
    existing.quantity += item.quantity;
    existing.confidence = Math.max(existing.confidence, item.confidence);
    existing.detailNumber ??= item.detailNumber ?? null;
    existing.widthMm ??= item.widthMm ?? null;
    existing.heightMm ??= item.heightMm ?? null;
    existing.source = preferredItemSource(existing.source, item.source);
    existing.reviewNote = normalizeOptional(existing.reviewNote) ?? normalizeOptional(item.reviewNote);
  }

  return changed ? { ...dto, items: result } : dto;
}

function matchedItemAggregateKey(item: IngestItemInput): string | null {
  if (
    item.matchStatus !== 'matched' ||
    item.matchOrderId == null ||
    item.matchDetailId == null
  ) {
    return null;
  }
  return `${item.matchOrderId}:${item.matchDetailId}`;
}

function preferredItemSource(
  left: IngestItemInput['source'],
  right: IngestItemInput['source'],
): IngestItemInput['source'] {
  const priority: Record<IngestItemInput['source'], number> = {
    vector: 4,
    ocr: 3,
    gcode: 2,
    manual: 1,
  };
  return priority[right] > priority[left] ? right : left;
}

function canResolveItem(item: IngestItemInput): boolean {
  if (item.matchOrderId != null || item.matchDetailId != null) return false;
  if (item.matchStatus != null && item.matchStatus !== 'unmatched') return false;
  if (!normalizeOrderKey(item.orderName)) return false;
  return item.detailNumber != null || (item.widthMm != null && item.heightMm != null);
}

function toDetailMatch(row: DetailMatchRow): DetailMatch | null {
  const orderKey = normalizeOrderKey(row.order_key);
  const orderId = toPositiveInteger(row.order_id);
  const detailId = toPositiveInteger(row.detail_id);
  if (!orderKey || orderId === null || detailId === null) return null;
  return {
    orderKey,
    orderId,
    detailId,
    detailNumber: toNullablePositiveInteger(row.detail_number),
    width: toNullableFiniteNumber(row.width),
    height: toNullableFiniteNumber(row.height),
  };
}

function resolveItemMatch(
  item: IngestItemInput,
  details: DetailMatch[],
  options: { tolerantSizeMm?: number } = {},
): DetailMatch | null {
  if (details.length === 0 || uniqueOrderId(details) === null) return null;

  if (item.detailNumber != null) {
    let candidates = details.filter((detail) => detail.detailNumber === item.detailNumber);
    candidates = preferSizeMatches(item, candidates, options);
    return uniqueDetail(candidates);
  }

  if (item.widthMm == null || item.heightMm == null) return null;
  return uniqueDetail(details.filter((detail) => sameItemSize(item, detail, options.tolerantSizeMm)));
}

function preferSizeMatches(
  item: IngestItemInput,
  details: DetailMatch[],
  options: { tolerantSizeMm?: number } = {},
): DetailMatch[] {
  if (item.widthMm == null || item.heightMm == null) return details;
  const detailsWithSize = details.filter((detail) => detail.width != null && detail.height != null);
  if (detailsWithSize.length === 0) return details;
  const sizeMatches = detailsWithSize.filter((detail) => sameItemSize(item, detail, options.tolerantSizeMm));
  if (sizeMatches.length > 0) return sizeMatches;
  return options.tolerantSizeMm !== undefined ? [] : detailsWithSize;
}

function uniqueOrderId(details: DetailMatch[]): number | null {
  const orderIds = new Set(details.map((detail) => detail.orderId));
  if (orderIds.size !== 1) return null;
  return details[0]?.orderId ?? null;
}

function uniqueDetail(details: DetailMatch[]): DetailMatch | null {
  const byId = new Map<number, DetailMatch>();
  for (const detail of details) byId.set(detail.detailId, detail);
  if (byId.size === 1) return Array.from(byId.values())[0] ?? null;

  const logicalKey = detailLogicalDuplicateKey(details[0]);
  if (!logicalKey) return null;
  for (const detail of details) {
    if (detailLogicalDuplicateKey(detail) !== logicalKey) return null;
  }
  return [...details].sort((a, b) => b.detailId - a.detailId)[0] ?? null;
}

function detailLogicalDuplicateKey(detail: DetailMatch | undefined): string | null {
  if (!detail || detail.detailNumber === null || detail.width === null || detail.height === null) return null;
  return [
    detail.orderId,
    detail.detailNumber,
    roundDimensionForKey(detail.width),
    roundDimensionForKey(detail.height),
  ].join(':');
}

function roundDimensionForKey(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function sameItemSize(
  item: IngestItemInput,
  detail: DetailMatch,
  tolerantSizeMm?: number,
): boolean {
  const itemWidth = toNullableFiniteNumber(item.widthMm);
  const itemHeight = toNullableFiniteNumber(item.heightMm);
  if (itemWidth === null || itemHeight === null || detail.width === null || detail.height === null) {
    return false;
  }
  const matchesSize = tolerantSizeMm !== undefined
    ? (leftWidth: number, leftHeight: number, rightWidth: number, rightHeight: number) =>
      closeEnoughSize(leftWidth, leftHeight, rightWidth, rightHeight, tolerantSizeMm)
    : item.source === 'ocr'
      ? closeEnoughSize
      : exactSize;
  return (
    matchesSize(itemWidth, itemHeight, detail.width, detail.height)
    || matchesSize(itemWidth, itemHeight, detail.height, detail.width)
  );
}

function exactSize(
  itemWidth: number,
  itemHeight: number,
  detailWidth: number,
  detailHeight: number,
): boolean {
  return itemWidth === detailWidth && itemHeight === detailHeight;
}

function closeEnoughSize(
  itemWidth: number,
  itemHeight: number,
  detailWidth: number,
  detailHeight: number,
  toleranceMm = 3,
): boolean {
  return closeEnough(itemWidth, detailWidth, toleranceMm) && closeEnough(itemHeight, detailHeight, toleranceMm);
}

function closeEnough(left: number, right: number, toleranceMm = 3): boolean {
  return Math.abs(left - right) <= toleranceMm;
}

function normalizeOrderKey(value: string | null | undefined): string | null {
  const normalized = normalizeOptional(value)?.toLowerCase();
  return normalized ?? null;
}

async function assertMatchedDetailsBelongToOrders(
  tx: TransactionClient,
  dto: CncTelegramStructuredIngestDto,
): Promise<void> {
  const pairs = new Map<string, { orderId: number; detailId: number }>();
  for (const item of dto.items) {
    if (item.matchOrderId && item.matchDetailId) {
      pairs.set(`${item.matchOrderId}:${item.matchDetailId}`, {
        orderId: item.matchOrderId,
        detailId: item.matchDetailId,
      });
    }
  }
  if (pairs.size === 0) return;

  const orderIds = Array.from(pairs.values()).map((pair) => pair.orderId);
  const detailIds = Array.from(pairs.values()).map((pair) => pair.detailId);
  const result = await tx.query<{ order_id: string | number; detail_id: string | number }>(
    `
    SELECT pairs.order_id, pairs.detail_id
    FROM unnest($1::bigint[], $2::bigint[]) AS pairs(order_id, detail_id)
    LEFT JOIN order_details od
      ON od.order_id = pairs.order_id
     AND od.detail_id = pairs.detail_id
    WHERE od.detail_id IS NULL
    LIMIT 20
    `,
    [orderIds, detailIds],
  );
  if (result.rows.length > 0) {
    throw new ApiError(
      422,
      'MATCH_DETAIL_ORDER_MISMATCH',
      'Matched CNC Telegram detail does not belong to the matched order',
      {
        mismatches: result.rows.map((row) => ({
          orderId: Number(row.order_id),
          detailId: Number(row.detail_id),
        })),
      },
    );
  }
}

async function writeIngestAudit(
  tx: TransactionClient,
  input: {
    command: IngestCncTelegramPacketCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    previousSourceVersion: number | null;
  },
): Promise<string> {
  const matchedOrderIds = Array.from(
    new Set(input.packet.items.map((item) => item.matchOrderId).filter(isPositiveNumber)),
  );
  return auditService.record(tx, {
    event: 'cnc.telegram_packet.ingested',
    entityType: 'cnc_telegram_packet',
    entityId: input.packet.packetId,
    actorUserId: input.command.currentUser.id,
    actorUsername: input.command.currentUser.username ?? null,
    actorRole: input.command.currentUser.role ?? null,
    requestId: input.requestId,
    source: SOURCE,
    before: input.previousSourceVersion === null
      ? null
      : { sourceVersion: input.previousSourceVersion },
    after: packetAuditSnapshot(input.packet),
    diff: {
      sourceVersion: {
        before: input.previousSourceVersion,
        after: input.packet.sourceVersion,
      },
      itemCount: input.packet.itemCount,
      itemQuantityTotal: input.packet.itemQuantityTotal,
    },
    metadata: {
      source: SOURCE,
      action: 'structured_ingest',
      externalPacketKey: input.packet.externalPacketKey,
      cuttingSequenceNo: input.packet.cuttingSequenceNo,
      machine: input.packet.machine,
      programName: input.packet.programName,
      materialName: input.packet.materialName,
      parseStatus: input.packet.parseStatus,
      completionStatus: input.packet.completionStatus,
      thumbsUp: input.packet.thumbsUp,
      rework: input.packet.rework,
      itemCount: input.packet.itemCount,
      itemQuantityTotal: input.packet.itemQuantityTotal,
      warningsCount: input.packet.analysisWarnings.length,
      commentsCount: input.packet.comments.length,
      ocrEngine: input.packet.ocrEngine,
      parserVersion: input.packet.parserVersion,
      requestId: input.requestId,
    },
    relatedEntities: [
      ...matchedOrderIds.map((orderId) => ({ entityType: 'order', entityId: orderId })),
    ],
  });
}

async function enqueuePacketEvents(
  tx: TransactionClient,
  command: IngestCncTelegramPacketCommand,
  packet: CncTelegramPacketDto,
  requestId: string,
  auditId: string,
): Promise<void> {
  await enqueueOutbox(tx, {
    eventType: 'cnc.telegram_packet.ingested',
    aggregateType: 'cnc_telegram_packet',
    aggregateId: packet.packetId,
    idempotencyKey: `${command.dto.idempotencyKey}:ingested`,
    payload: packetOutboxPayload(packet, command, requestId, auditId, 'ingested'),
  });

  if (packet.completionStatus === 'completed' || packet.thumbsUp) {
    await enqueueOutbox(tx, {
      eventType: 'cnc.telegram_packet.completed',
      aggregateType: 'cnc_telegram_packet',
      aggregateId: packet.packetId,
      idempotencyKey: `${command.dto.idempotencyKey}:completed`,
      payload: packetOutboxPayload(packet, command, requestId, auditId, 'completed'),
    });
  }

}

function packetOutboxPayload(
  packet: CncTelegramPacketDto,
  command: IngestCncTelegramPacketCommand,
  requestId: string,
  auditId: string,
  eventKind: 'ingested' | 'completed' | 'needs_review',
): Record<string, unknown> {
  return {
    eventType: `cnc.telegram_packet.${eventKind}`,
    actorUserId: command.currentUser.id,
    requestId,
    auditId,
    packetId: packet.packetId,
    externalPacketKey: packet.externalPacketKey,
    cuttingSequenceNo: packet.cuttingSequenceNo,
    sourceChatId: packet.sourceChatId,
    sourceMessageId: packet.sourceMessageId,
    sourceVersion: packet.sourceVersion,
    workday: packet.workday,
    machine: packet.machine,
    programName: packet.programName,
    materialName: packet.materialName,
    parseStatus: packet.parseStatus,
    completionStatus: packet.completionStatus,
    thumbsUp: packet.thumbsUp,
    rework: packet.rework,
    itemCount: packet.itemCount,
    itemQuantityTotal: packet.itemQuantityTotal,
    warningsCount: packet.analysisWarnings.length,
    commentsCount: packet.comments.length,
    idempotencyKey: command.dto.idempotencyKey,
  };
}

function packetIsCompleted(packet: CncTelegramPacketDto): boolean {
  return packet.completionStatus === 'completed' || packet.thumbsUp;
}

async function evaluateMdfBoardBathColumnAutomationForPacket(
  tx: TransactionClient,
  input: {
    packet: CncTelegramPacketDto;
    actor: CurrentUser;
    requestId: string;
  },
): Promise<void> {
  const cutResultId = input.packet.svgCutResultId;
  if (!isPositiveNumber(cutResultId)) return;
  const state = await loadMdfBathColumnAutomationState(tx, cutResultId);
  if (state === null) return;
  const eventType = mdfBoardBathColumnEventType(state.column);
  await evaluateMdfBoardColumnAutomation(tx, {
    eventType,
    orderIds: state.orderIds,
    actor: input.actor,
    requestId: input.requestId,
    sourceIdempotencyKey: `mdf-board:auto:bath:cut-result-${cutResultId}:${state.column}`,
  });
}

function mdfBoardBathColumnEventType(
  column: 'baths' | 'baths_ready' | 'baths_laminated',
): MdfBoardColumnAutomationInput['eventType'] {
  switch (column) {
    case 'baths':
      return 'mdf.board.baths';
    case 'baths_ready':
      return 'mdf.board.baths_ready';
    case 'baths_laminated':
      return 'mdf.board.baths_laminated';
  }
}

async function loadMdfBathColumnAutomationState(
  tx: TransactionClient,
  cutResultId: number,
): Promise<{ column: 'baths' | 'baths_ready' | 'baths_laminated'; orderIds: number[] } | null> {
  const result = await tx.query<BathColumnAutomationRow>(
    `
    WITH laminated_status_threshold AS (
      SELECT COALESCE(
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(COALESCE(ps.production_status_code, ''))) = 'laminated'
        ),
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(ps.production_status_name)) = 'закатан'
        )
      ) AS sort_order
      FROM production_statuses ps
    ),
    target_details AS (
      SELECT DISTINCT
        placement.order_id,
        placement.order_detail_id
      FROM cut_result_placement placement
      JOIN cut_result result
        ON result.cut_result_id = placement.cut_result_id
      JOIN cut_job job
        ON job.cut_job_id = result.cut_job_id
      LEFT JOIN cut_param_profiles profile
        ON profile.cut_param_profile_id = job.param_profile_id
      LEFT JOIN cut_result_archive_state archive
        ON archive.cut_job_id = result.cut_job_id
       AND archive.result_no = result.result_no
      JOIN orders order_row
        ON order_row.order_id = placement.order_id
       AND COALESCE(order_row.delete_flag, false) = false
      JOIN order_details detail
        ON detail.detail_id = placement.order_detail_id
       AND COALESCE(detail.delete_flag, false) = false
      WHERE placement.cut_result_id = $1
        AND result.snapshot_job IS NOT NULL
        AND job.status <> 'archived'
        AND COALESCE(profile.params ->> 'layout_mode', job.params ->> 'layout_mode') = 'vacuum_table'
        AND archive.archived_at IS NULL
    ),
    completed_quantities AS (
      SELECT
        item.match_detail_id::bigint AS order_detail_id,
        SUM(
          CASE
            WHEN NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(packet.comments_json) AS packet_comment(comment_text)
              WHERE lower(packet_comment.comment_text) LIKE ANY (
                ARRAY['%hdf%', '%хдф%', '%лдсп%', '%ldsp%', '%fanera%', '%фанера%']
              )
            )
              AND (packet.completion_status = 'completed' OR packet.thumbs_up = true)
              THEN GREATEST(item.quantity, 0)
            ELSE 0
          END
        )::integer AS completed_quantity
      FROM cnc_telegram_packets packet
      JOIN cnc_telegram_packet_items item
        ON item.packet_id = packet.packet_id
      JOIN target_details target
        ON target.order_detail_id = item.match_detail_id
      WHERE item.match_status = 'matched'
        AND item.match_detail_id IS NOT NULL
      GROUP BY item.match_detail_id
    )
    SELECT
      placement.order_id,
      placement.order_detail_id,
      COUNT(*)::integer AS quantity,
      COALESCE(completed.completed_quantity, 0)::integer AS completed_quantity,
      CASE
        WHEN detail_status.sort_order IS NOT NULL
          AND laminated_status.sort_order IS NOT NULL
          THEN detail_status.sort_order >= laminated_status.sort_order
        ELSE false
      END AS laminated_or_later
    FROM cut_result_placement placement
    JOIN target_details target
      ON target.order_id = placement.order_id
     AND target.order_detail_id = placement.order_detail_id
    JOIN order_details detail
      ON detail.detail_id = placement.order_detail_id
     AND COALESCE(detail.delete_flag, false) = false
    LEFT JOIN production_statuses detail_status
      ON detail_status.production_status_id = detail.production_status_id
    CROSS JOIN laminated_status_threshold laminated_status
    LEFT JOIN completed_quantities completed
      ON completed.order_detail_id = placement.order_detail_id
    WHERE placement.cut_result_id = $1
    GROUP BY
      placement.order_id,
      placement.order_detail_id,
      completed.completed_quantity,
      detail_status.sort_order,
      laminated_status.sort_order
    ORDER BY placement.order_id, placement.order_detail_id
    `,
    [cutResultId],
  );
  if (result.rows.length === 0) return null;

  const orderIds = positiveNumberArray(result.rows.map((row) => row.order_id));
  if (orderIds.length === 0) return null;
  const ready = result.rows.every((row) => toNumber(row.completed_quantity) >= toNumber(row.quantity));
  const laminated = ready && result.rows.every((row) => row.laminated_or_later === true);
  return {
    column: laminated ? 'baths_laminated' : ready ? 'baths_ready' : 'baths',
    orderIds,
  };
}

async function applyCompletedPacketAutoCutStatus(
  tx: TransactionClient,
  input: {
    command: IngestCncTelegramPacketCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    packetAuditId: string;
  },
): Promise<void> {
  // Serialize setting changes, backfills, and packet completion. Whichever transaction wins,
  // the completed packet is handled exactly once by either the backfill or this path.
  await lockCncAutoCutStatus(tx);
  if (!await cncAutoCutStatusEnabled(tx)) return;

  const matchedDetailIds = Array.from(new Set(
    input.packet.items
      .filter((item) =>
        item.matchStatus === 'matched'
        && item.matchOrderId != null
        && item.matchDetailId != null,
      )
      .map((item) => Number(item.matchDetailId))
      .filter(isPositiveNumber),
  ));
  const matchedOrderIds = Array.from(new Set(
    input.packet.items
      .filter((item) =>
        item.matchStatus === 'matched'
        && item.matchOrderId != null
        && item.matchDetailId != null,
      )
      .map((item) => Number(item.matchOrderId))
      .filter(isPositiveNumber),
  )).sort((left, right) => left - right);
  const wholeOrderIds = cncWholeOrderIds(input.packet);
  if (matchedDetailIds.length === 0 && wholeOrderIds.length === 0) return;

  const targetStatus = await loadCncAutoCutProductionStatus(tx);
  if (!targetStatus) return;

  const applied = await applyCncAutoCutStatusCandidates(tx, {
    matchedDetailIds,
    matchedOrderIds,
    wholeOrderIds,
    targetStatus,
  });
  if (applied.changedDetailIds.length === 0) return;

  const statusId = toNumber(targetStatus.production_status_id);
  const autoCutAuditId = await auditService.record(tx, {
    event: CNC_AUTO_CUT_STATUS_EVENT,
    entityType: 'cnc_telegram_packet',
    entityId: input.packet.packetId,
    actorUserId: input.command.currentUser.id,
    actorUsername: input.command.currentUser.username ?? null,
    actorRole: input.command.currentUser.role ?? null,
    requestId: input.requestId,
    source: SOURCE,
    statusField: 'productionDetailBatch',
    statusId,
    statusName: targetStatus.production_status_name,
    statusCode: targetStatus.production_status_code,
    before: { packetCompletionStatus: 'pending' },
    after: {
      packetCompletionStatus: 'completed',
      changedOrderIds: applied.changedOrderIds,
      changedDetailIds: applied.changedDetailIds,
    },
    diff: {
      changedDetailIdsByOrder: Object.fromEntries(applied.changedDetailIdsByOrder),
      productionStatusId: statusId,
    },
    metadata: {
      source: SOURCE,
      action: 'cnc_completed_packet_auto_cut_status',
      settingKey: CNC_AUTO_CUT_STATUS_SETTING_KEY,
      packetAuditId: input.packetAuditId,
      externalPacketKey: input.packet.externalPacketKey,
      cuttingSequenceNo: input.packet.cuttingSequenceNo,
      matchedDetailIds,
      wholeOrderIds,
      requestId: input.requestId,
    },
    relatedEntities: [
      ...applied.changedOrderIds.map((entityId) => ({ entityType: 'order', entityId })),
      ...applied.changedDetailIds.map((entityId) => ({ entityType: 'order_detail', entityId })),
    ],
  });

  await enqueueOutbox(tx, {
    eventType: CNC_AUTO_CUT_STATUS_EVENT,
    aggregateType: 'cnc_telegram_packet',
    aggregateId: input.packet.packetId,
    idempotencyKey: `${input.command.dto.idempotencyKey}:auto-cut-status`,
    payload: {
      eventType: CNC_AUTO_CUT_STATUS_EVENT,
      actorUserId: input.command.currentUser.id,
      requestId: input.requestId,
      auditId: autoCutAuditId,
      packetId: input.packet.packetId,
      externalPacketKey: input.packet.externalPacketKey,
      cuttingSequenceNo: input.packet.cuttingSequenceNo,
      productionStatusId: statusId,
      productionStatusCode: targetStatus.production_status_code,
      changedOrderIds: applied.changedOrderIds,
      changedDetailIds: applied.changedDetailIds,
      changedDetailIdsByOrder: Object.fromEntries(applied.changedDetailIdsByOrder),
      orders: cncAutoCutOrderEventPayload(applied.bumpedOrders),
      idempotencyKey: input.command.dto.idempotencyKey,
    },
  });
}

async function lockCncAutoCutStatus(tx: TransactionClient): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    CNC_AUTO_CUT_STATUS_SETTING_KEY,
  ]);
}

async function applyCncAutoCutStatusCandidates(
  tx: TransactionClient,
  input: {
    matchedDetailIds: number[];
    matchedOrderIds: number[];
    wholeOrderIds: number[];
    targetStatus: CncAutoCutStatusRow;
  },
): Promise<CncAutoCutApplyResult> {
  if (input.matchedDetailIds.length === 0 && input.wholeOrderIds.length === 0) {
    return emptyCncAutoCutApplyResult();
  }

  const candidateOrderIds = Array.from(new Set([
    ...input.matchedOrderIds,
    ...input.wholeOrderIds,
  ])).sort((left, right) => left - right);

  // Caller holds CNC_AUTO_CUT_STATUS_SETTING_KEY advisory lock. Lock parent orders before details
  // so quantity thresholds cannot race with order edits or another completed machine-file card.
  const lockedOrders = await tx.query<CncAutoCutOrderRow>(
    `
    SELECT
      order_id,
      order_name,
      client_id,
      version,
      production_status_id,
      COALESCE(production_status_from_details_enabled, true) AS production_status_from_details_enabled
    FROM orders
    WHERE order_id = ANY($1::bigint[])
      AND COALESCE(delete_flag, false) = false
    ORDER BY order_id
    FOR UPDATE
    `,
    [candidateOrderIds],
  );
  if (lockedOrders.rows.length === 0) return emptyCncAutoCutApplyResult();

  const wholeOrderIdSet = new Set(input.wholeOrderIds);
  const wholeOrderIds = lockedOrders.rows
    .filter((row) => wholeOrderIdSet.has(toNumber(row.order_id)))
    .map((row) => toNumber(row.order_id));
  const liveOrderIds = lockedOrders.rows.map((row) => toNumber(row.order_id));

  const targets = await tx.query<CncAutoCutTargetRow>(
    `
    WITH completed_quantities AS (
      SELECT
        item.match_detail_id::bigint AS detail_id,
        SUM(GREATEST(item.quantity, 0))::integer AS completed_quantity
      FROM cnc_telegram_packet_items item
      JOIN cnc_telegram_packets packet ON packet.packet_id = item.packet_id
      WHERE item.match_status = 'matched'
        AND item.match_detail_id = ANY($1::bigint[])
        AND (packet.completion_status = 'completed' OR packet.thumbs_up = true)
      GROUP BY item.match_detail_id
    )
    SELECT DISTINCT details.order_id, details.detail_id
    FROM order_details details
    JOIN orders ON orders.order_id = details.order_id
    LEFT JOIN completed_quantities completed ON completed.detail_id = details.detail_id
    WHERE COALESCE(details.delete_flag, false) = false
      AND COALESCE(orders.delete_flag, false) = false
      AND details.order_id = ANY($3::bigint[])
      AND (
        (
          details.detail_id = ANY($1::bigint[])
          AND COALESCE(completed.completed_quantity, 0) >= GREATEST(COALESCE(details.quantity, 1), 1)
        )
        OR details.order_id = ANY($2::bigint[])
      )
    ORDER BY details.order_id, details.detail_id
    `,
    [input.matchedDetailIds, wholeOrderIds, liveOrderIds],
  );
  if (targets.rows.length === 0) return emptyCncAutoCutApplyResult();

  const targetDetailIds = targets.rows.map((row) => toNumber(row.detail_id));
  const liveOrderIdSet = new Set(liveOrderIds);

  const lockedDetails = await tx.query<CncAutoCutDetailRow>(
    `
    SELECT
      details.order_id,
      details.detail_id,
      details.production_status_id
    FROM order_details details
    WHERE details.detail_id = ANY($1::bigint[])
      AND COALESCE(details.delete_flag, false) = false
    ORDER BY details.order_id, details.detail_id
    FOR UPDATE OF details
    `,
    [targetDetailIds],
  );
  const currentStatusIds = Array.from(new Set(
    lockedDetails.rows
      .map((row) => row.production_status_id === null ? null : Number(row.production_status_id))
      .filter((statusId): statusId is number => statusId !== null && isPositiveNumber(statusId)),
  )).sort((left, right) => left - right);
  const currentStatuses = currentStatusIds.length > 0
    ? await tx.query<CncAutoCutCurrentStatusRow>(
        `
        SELECT production_status_id, sort_order
        FROM production_statuses
        WHERE production_status_id = ANY($1::bigint[])
        ORDER BY production_status_id
        FOR SHARE
        `,
        [currentStatusIds],
      )
    : { rows: [] };
  const currentStatusSortOrderById = new Map(
    currentStatuses.rows.map((row) => [
      toNumber(row.production_status_id),
      row.sort_order === null ? null : Number(row.sort_order),
    ]),
  );
  const eligibleDetailIds = lockedDetails.rows
    .filter((row) => {
      const orderId = toNumber(row.order_id);
      if (!liveOrderIdSet.has(orderId)) return false;
      if (row.production_status_id === null) return true;
      const currentStatusId = toNumber(row.production_status_id);
      if (currentStatusId === toNumber(input.targetStatus.production_status_id)) return false;
      const currentSortOrder = currentStatusSortOrderById.get(currentStatusId);
      if (currentSortOrder === undefined || currentSortOrder === null) return false;
      return currentSortOrder <= Number(input.targetStatus.sort_order);
    })
    .map((row) => toNumber(row.detail_id));
  if (eligibleDetailIds.length === 0) return emptyCncAutoCutApplyResult();

  const updated = await tx.query<CncAutoCutTargetRow>(
    `
    UPDATE order_details
    SET production_status_id = $1
    WHERE detail_id = ANY($2::bigint[])
      AND COALESCE(delete_flag, false) = false
      AND production_status_id IS DISTINCT FROM $1
    RETURNING order_id, detail_id
    `,
    [toNumber(input.targetStatus.production_status_id), eligibleDetailIds],
  );
  if (updated.rows.length === 0) return emptyCncAutoCutApplyResult();

  const changedDetailIdsByOrder = new Map<number, number[]>();
  for (const row of updated.rows) {
    const orderId = toNumber(row.order_id);
    const detailIds = changedDetailIdsByOrder.get(orderId) ?? [];
    detailIds.push(toNumber(row.detail_id));
    changedDetailIdsByOrder.set(orderId, detailIds);
  }
  const changedOrderIds = Array.from(changedDetailIdsByOrder.keys()).sort((left, right) => left - right);
  const orderById = new Map(
    lockedOrders.rows.map((row) => [toNumber(row.order_id), row] as const),
  );
  for (const orderId of changedOrderIds) {
    if (orderById.get(orderId)?.production_status_from_details_enabled !== false) {
      await tx.query('SELECT recalc_order_production_status($1)', [orderId]);
    }
  }

  const bumpedOrders = await tx.query<CncAutoCutOrderRow>(
    `
    UPDATE orders
    SET version = version + 1, updated_at = now()
    WHERE order_id = ANY($1::bigint[])
    RETURNING
      order_id,
      order_name,
      client_id,
      version,
      production_status_id,
      COALESCE(production_status_from_details_enabled, true) AS production_status_from_details_enabled
    `,
    [changedOrderIds],
  );
  const changedDetailIds = updated.rows.map((row) => toNumber(row.detail_id));
  return {
    changedOrderIds,
    changedDetailIds,
    changedDetailIdsByOrder,
    bumpedOrders: bumpedOrders.rows,
  };
}

function emptyCncAutoCutApplyResult(): CncAutoCutApplyResult {
  return {
    changedOrderIds: [],
    changedDetailIds: [],
    changedDetailIdsByOrder: new Map(),
    bumpedOrders: [],
  };
}

function cncAutoCutOrderEventPayload(rows: CncAutoCutOrderRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    orderId: toNumber(row.order_id),
    clientId: row.client_id === null ? null : toNumber(row.client_id),
    version: toNumber(row.version),
    productionStatusId: row.production_status_id === null
      ? null
      : toNumber(row.production_status_id),
    productionStatusFromDetailsEnabled: row.production_status_from_details_enabled,
  }));
}

function cncAutoCutStatusConfigureCounts(input: {
  completedPacketCount: number;
  matchedDetailIds: number[];
  wholeOrderIds: number[];
  applied: CncAutoCutApplyResult;
}): Pick<
  CncAutoCutStatusConfigureResponseDto,
  | 'completedPacketCount'
  | 'matchedDetailCount'
  | 'wholeOrderCount'
  | 'changedOrderCount'
  | 'changedDetailCount'
> {
  return {
    completedPacketCount: input.completedPacketCount,
    matchedDetailCount: input.matchedDetailIds.length,
    wholeOrderCount: input.wholeOrderIds.length,
    changedOrderCount: input.applied.changedOrderIds.length,
    changedDetailCount: input.applied.changedDetailIds.length,
  };
}

async function cncAutoCutStatusEnabled(tx: TransactionClient): Promise<boolean> {
  const result = await tx.query<CncAutoCutSettingRow>(
    `
    SELECT is_active, value_json
    FROM app_settings
    WHERE setting_key = $1
    LIMIT 1
    `,
    [CNC_AUTO_CUT_STATUS_SETTING_KEY],
  );
  const row = result.rows[0];
  if (!row?.is_active) return false;
  if (row.value_json === true) return true;
  if (!row.value_json || typeof row.value_json !== 'object' || Array.isArray(row.value_json)) {
    return false;
  }
  const value = row.value_json as Record<string, unknown>;
  return value.value === true || value.enabled === true;
}

async function loadCncAutoCutProductionStatus(
  tx: TransactionClient,
): Promise<CncAutoCutStatusRow | null> {
  const result = await tx.query<CncAutoCutStatusRow>(
    `
    SELECT
      production_status_id,
      production_status_name,
      production_status_code,
      sort_order
    FROM production_statuses
    WHERE COALESCE(is_active, true) = true
      AND sort_order IS NOT NULL
      AND (
        lower(trim(production_status_name)) = 'распилен'
        OR lower(trim(production_status_code)) = 'cut'
      )
    ORDER BY
      CASE WHEN lower(trim(production_status_name)) = 'распилен' THEN 0 ELSE 1 END,
      production_status_id
    LIMIT 1
    FOR SHARE
    `,
  );
  return result.rows[0] ?? null;
}

async function loadCncAutoCutBackfillCandidates(
  tx: TransactionClient,
): Promise<{
  completedPacketCount: number;
  matchedDetailIds: number[];
  matchedOrderIds: number[];
  wholeOrderIds: number[];
}> {
  const candidates = await tx.query<CncAutoCutBackfillCandidateRow>(
    `
    SELECT
      COUNT(DISTINCT packet.packet_id)::integer AS completed_packet_count,
      COALESCE(
        array_agg(DISTINCT item.match_detail_id)
          FILTER (
            WHERE item.match_status = 'matched'
              AND item.match_order_id IS NOT NULL
              AND item.match_detail_id IS NOT NULL
          ),
        ARRAY[]::bigint[]
      ) AS matched_detail_ids,
      COALESCE(
        array_agg(DISTINCT item.match_order_id)
          FILTER (
            WHERE item.match_status = 'matched'
              AND item.match_order_id IS NOT NULL
              AND item.match_detail_id IS NOT NULL
          ),
        ARRAY[]::bigint[]
      ) AS matched_order_ids
    FROM cnc_telegram_packets packet
    LEFT JOIN cnc_telegram_packet_items item ON item.packet_id = packet.packet_id
    WHERE packet.completion_status = 'completed' OR packet.thumbs_up = true
    `,
  );
  const candidate = candidates.rows[0];

  const comments = await tx.query<CncAutoCutBackfillCommentRow>(
    `
    SELECT
      packet.comments_json,
      COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
          'orderName', item.order_name,
          'matchOrderId', item.match_order_id
        )) FILTER (
          WHERE item.match_status = 'matched'
            AND item.match_order_id IS NOT NULL
            AND NULLIF(trim(item.order_name), '') IS NOT NULL
        ),
        '[]'::jsonb
      ) AS items_json
    FROM cnc_telegram_packets packet
    LEFT JOIN cnc_telegram_packet_items item ON item.packet_id = packet.packet_id
    WHERE (packet.completion_status = 'completed' OR packet.thumbs_up = true)
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(packet.comments_json, '[]'::jsonb)) AS comment(value)
        WHERE comment.value ~* 'весь[[:space:]]+заказ'
      )
    GROUP BY packet.packet_id, packet.comments_json
    `,
  );
  const wholeOrderIds = new Set<number>();
  for (const row of comments.rows) {
    const packet = {
      comments: stringArray(row.comments_json),
      items: cncAutoCutBackfillItems(row.items_json),
    };
    for (const orderId of cncWholeOrderIds(packet)) wholeOrderIds.add(orderId);
  }

  return {
    completedPacketCount: toNumber(candidate?.completed_packet_count),
    matchedDetailIds: positiveNumberArray(candidate?.matched_detail_ids),
    matchedOrderIds: positiveNumberArray(candidate?.matched_order_ids),
    wholeOrderIds: Array.from(wholeOrderIds).sort((left, right) => left - right),
  };
}

async function saveCncAutoCutStatusSetting(
  tx: TransactionClient,
  enabled: boolean,
  actorUserId: number,
): Promise<void> {
  await tx.query(
    `
    INSERT INTO app_settings (
      setting_key, value_json, description, is_active, created_by, edited_by
    )
    VALUES ($1, $2::jsonb, $3, true, $4, $4)
    ON CONFLICT (setting_key) DO UPDATE
    SET value_json = EXCLUDED.value_json,
        description = EXCLUDED.description,
        is_active = true,
        edited_by = EXCLUDED.edited_by,
        updated_at = now()
    `,
    [
      CNC_AUTO_CUT_STATUS_SETTING_KEY,
      JSON.stringify({ value: enabled }),
      'Автоматически ставить деталям статус «Распилен» при завершении карточки файла станка',
      actorUserId,
    ],
  );
}

async function writeCncAutoCutStatusConfigureAudit(
  tx: TransactionClient,
  input: {
    command: ConfigureCncAutoCutStatusCommand;
    requestId: string;
    previousSettingEnabled: boolean;
    targetStatus: CncAutoCutStatusRow | null;
    completedPacketCount: number;
    matchedDetailIds: number[];
    wholeOrderIds: number[];
    applied: CncAutoCutApplyResult;
  },
): Promise<string> {
  const counts = cncAutoCutStatusConfigureCounts(input);
  return auditService.record(tx, {
    event: CNC_AUTO_CUT_STATUS_CONFIGURE_EVENT,
    entityType: 'app_setting',
    entityId: CNC_AUTO_CUT_STATUS_SETTING_KEY,
    actorUserId: input.command.currentUser.id,
    actorUsername: input.command.currentUser.username ?? null,
    actorRole: input.command.currentUser.role ?? null,
    requestId: input.requestId,
    source: SOURCE,
    statusField: 'enabled',
    statusId: input.targetStatus ? toNumber(input.targetStatus.production_status_id) : null,
    statusName: input.targetStatus?.production_status_name ?? null,
    statusCode: input.targetStatus?.production_status_code ?? null,
    before: { enabled: input.previousSettingEnabled },
    after: {
      enabled: input.command.enabled,
      changedOrderIds: input.applied.changedOrderIds,
      changedDetailIds: input.applied.changedDetailIds,
    },
    diff: {
      enabled: { before: input.previousSettingEnabled, after: input.command.enabled },
      changedDetailIdsByOrder: Object.fromEntries(input.applied.changedDetailIdsByOrder),
    },
    metadata: {
      source: SOURCE,
      action: 'configure_cnc_auto_cut_status_and_backfill',
      settingKey: CNC_AUTO_CUT_STATUS_SETTING_KEY,
      ...counts,
      matchedDetailIds: input.matchedDetailIds,
      wholeOrderIds: input.wholeOrderIds,
      idempotencyKey: input.command.idempotencyKey,
    },
    relatedEntities: [
      ...input.applied.changedOrderIds.map((entityId) => ({ entityType: 'order', entityId })),
      ...input.applied.changedDetailIds.map((entityId) => ({ entityType: 'order_detail', entityId })),
    ],
  });
}

async function enqueueCncAutoCutStatusConfigureEvent(
  tx: TransactionClient,
  input: {
    command: ConfigureCncAutoCutStatusCommand;
    requestId: string;
    auditId: string;
    completedPacketCount: number;
    matchedDetailIds: number[];
    wholeOrderIds: number[];
    applied: CncAutoCutApplyResult;
  },
): Promise<void> {
  const counts = cncAutoCutStatusConfigureCounts(input);
  await enqueueOutbox(tx, {
    eventType: CNC_AUTO_CUT_STATUS_CONFIGURE_EVENT,
    aggregateType: 'app_setting',
    aggregateId: CNC_AUTO_CUT_STATUS_SETTING_KEY,
    idempotencyKey: `${input.command.idempotencyKey}:configured`,
    payload: {
      eventType: CNC_AUTO_CUT_STATUS_CONFIGURE_EVENT,
      actorUserId: input.command.currentUser.id,
      requestId: input.requestId,
      auditId: input.auditId,
      settingKey: CNC_AUTO_CUT_STATUS_SETTING_KEY,
      settingEnabled: input.command.enabled,
      ...counts,
      matchedDetailIds: input.matchedDetailIds,
      wholeOrderIds: input.wholeOrderIds,
      changedOrderIds: input.applied.changedOrderIds,
      changedDetailIds: input.applied.changedDetailIds,
      changedDetailIdsByOrder: Object.fromEntries(input.applied.changedDetailIdsByOrder),
      orders: cncAutoCutOrderEventPayload(input.applied.bumpedOrders),
      idempotencyKey: input.command.idempotencyKey,
    },
  });
}

export function cncWholeOrderKeys(
  packet: Pick<CncTelegramPacketDto, 'comments'> & {
    items: Array<Pick<CncTelegramPacketItemDto, 'orderName'>>;
  },
): string[] {
  const keys = new Set<string>();
  const packetOrderKeys = Array.from(new Set(
    packet.items
      .map((item) => normalizeOptional(item.orderName)?.toLocaleLowerCase('ru-RU'))
      .filter((value): value is string => Boolean(value)),
  ));

  for (const comment of packet.comments) {
    if (!/весь\s+заказ/iu.test(comment)) continue;
    const normalizedComment = comment.toLocaleLowerCase('ru-RU');
    const explicitOrderKeys = explicitOrderKeysFromComment(normalizedComment, packetOrderKeys);
    for (const orderKey of explicitOrderKeys) keys.add(orderKey);
    if (explicitOrderKeys.length === 0 && packetOrderKeys.length === 1) {
      keys.add(packetOrderKeys[0]);
    }
  }
  return Array.from(keys);
}

export function cncWholeOrderIds(
  packet: Pick<CncTelegramPacketDto, 'comments'> & {
    items: Array<Pick<CncTelegramPacketItemDto, 'orderName' | 'matchOrderId' | 'matchStatus'>>;
  },
): number[] {
  const wholeOrderKeys = new Set(cncWholeOrderKeys(packet));
  const idsByOrderKey = new Map<string, Set<number>>();
  for (const item of packet.items) {
    if (item.matchStatus !== 'matched') continue;
    const orderKey = normalizeOptional(item.orderName)?.toLocaleLowerCase('ru-RU');
    const orderId = Number(item.matchOrderId);
    if (!orderKey || !wholeOrderKeys.has(orderKey) || !isPositiveNumber(orderId)) continue;
    const ids = idsByOrderKey.get(orderKey) ?? new Set<number>();
    ids.add(orderId);
    idsByOrderKey.set(orderKey, ids);
  }

  const wholeOrderIds = new Set<number>();
  for (const ids of idsByOrderKey.values()) {
    if (ids.size === 1) wholeOrderIds.add(Array.from(ids)[0]);
  }
  return Array.from(wholeOrderIds).sort((left, right) => left - right);
}

function cncAutoCutBackfillItems(
  value: unknown,
): Array<Pick<CncTelegramPacketItemDto, 'orderName' | 'matchOrderId' | 'matchStatus'>> {
  if (!Array.isArray(value)) return [];
  const items: Array<
    Pick<CncTelegramPacketItemDto, 'orderName' | 'matchOrderId' | 'matchStatus'>
  > = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    const orderName = typeof row.orderName === 'string' ? normalizeOptional(row.orderName) : null;
    const matchOrderId = Number(row.matchOrderId);
    if (!orderName || !isPositiveNumber(matchOrderId)) continue;
    items.push({ orderName, matchOrderId, matchStatus: 'matched' });
  }
  return items;
}

function explicitOrderKeysFromComment(comment: string, orderKeys: string[]): string[] {
  const occupiedRanges: Array<{ start: number; end: number }> = [];
  const matchedKeys: string[] = [];
  const longestFirst = [...orderKeys].sort((left, right) =>
    right.length - left.length || left.localeCompare(right, 'ru-RU'),
  );

  for (const orderKey of longestFirst) {
    const escapedOrderKey = orderKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}])(${escapedOrderKey})(?=$|[^\\p{L}\\p{N}])`,
      'giu',
    );
    let accepted = false;
    for (const match of comment.matchAll(pattern)) {
      const start = (match.index ?? 0) + (match[1]?.length ?? 0);
      const end = start + orderKey.length;
      if (occupiedRanges.some((range) => start < range.end && end > range.start)) continue;
      occupiedRanges.push({ start, end });
      accepted = true;
    }
    if (accepted) matchedKeys.push(orderKey);
  }
  return matchedKeys;
}

async function reconcileIdempotency(
  tx: TransactionClient,
  input: {
    dto: CncTelegramStructuredIngestDto;
    currentUserId: string;
    payloadHash: string;
    commandName?: string;
    entityType?: string;
  },
): Promise<CncTelegramIngestResponseDto | null> {
  const commandName = input.commandName ?? COMMAND_NAME;
  const entityType = input.entityType ?? 'cnc_telegram_packet';
  const requestHash = hashRequest({
    actorUserId: input.currentUserId,
    commandName,
    externalPacketKey: input.dto.externalPacketKey,
    sourceVersion: input.dto.source.version,
    payloadHash: input.payloadHash,
  });
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING request_hash, response_json, status
    `,
    [
      input.dto.idempotencyKey,
      commandName,
      Number(input.currentUserId),
      entityType,
      input.dto.externalPacketKey,
      requestHash,
    ],
  );
  if (inserted.rows[0]) return null;

  const existing = await tx.query<IdempotencyRow>(
    `
    SELECT request_hash, response_json, status
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [input.dto.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.dto.idempotencyKey);
  if (row.request_hash !== requestHash) {
    throw idempotencyError('IDEMPOTENCY_KEY_REUSED', input.dto.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    const response = cncTelegramIngestResponseFromJson(row.response_json);
    if (response) return response;
    throw new ApiError(
      500,
      'IDEMPOTENCY_RESPONSE_INVALID',
      'Stored CNC Telegram ingest response is invalid',
      { idempotencyKey: input.dto.idempotencyKey },
    );
  }
  if (row.status === 'failed') {
    throw idempotencyError('IDEMPOTENCY_FAILED', input.dto.idempotencyKey);
  }
  throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.dto.idempotencyKey);
}

async function reconcileManualSvgUploadIdempotency(
  tx: TransactionClient,
  input: {
    command: ManualSvgUploadCommand;
    dto: CncTelegramStructuredIngestDto;
    payloadHash: string;
  },
): Promise<CncTelegramManualSvgUploadResponseDto | null> {
  const requestHash = hashRequest({
    actorUserId: input.command.currentUser.id,
    commandName: MANUAL_SVG_COMMAND_NAME,
    externalPacketKey: input.dto.externalPacketKey,
    sourceVersion: input.dto.source.version,
    selectedOrderIds: input.command.dto.selectedOrderIds,
    createMdfMachineFileCard: input.command.dto.createMdfMachineFileCard,
    matchMode: input.command.dto.matchMode,
    requestedCutJobId: input.command.dto.requestedCutJobId ?? null,
    sourceFiles: manualSvgSourceFileRequestSnapshot(input.command.dto.sourceFiles ?? []),
    generatedScreenshot: {
      contrast: input.command.dto.generatedScreenshot?.contrast ?? null,
    },
    telegramSend: {
      enabled: input.command.dto.telegramSend?.enabled === true,
      message: input.command.dto.telegramSend?.message?.trim() ?? null,
    },
    payloadHash: input.payloadHash,
  });
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, 'cnc_manual_svg_upload', $4, $5, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING request_hash, response_json, status
    `,
    [
      input.dto.idempotencyKey,
      MANUAL_SVG_COMMAND_NAME,
      Number(input.command.currentUser.id),
      input.dto.externalPacketKey,
      requestHash,
    ],
  );
  if (inserted.rows[0]) return null;

  const existing = await tx.query<IdempotencyRow>(
    `
    SELECT request_hash, response_json, status
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [input.dto.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.dto.idempotencyKey);
  if (row.request_hash !== requestHash) {
    throw idempotencyError('IDEMPOTENCY_KEY_REUSED', input.dto.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    const response = manualSvgUploadResponseFromJson(row.response_json);
    if (response) return response;
    throw new ApiError(
      500,
      'IDEMPOTENCY_RESPONSE_INVALID',
      'Stored manual SVG upload response is invalid',
      { idempotencyKey: input.dto.idempotencyKey },
    );
  }
  if (row.status === 'failed') {
    throw idempotencyError('IDEMPOTENCY_FAILED', input.dto.idempotencyKey);
  }
  throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.dto.idempotencyKey);
}

function manualSvgSourceFileRequestSnapshot(
  files: CncTelegramManualSvgUploadFileDto[],
): Array<Record<string, unknown>> {
  return files
    .map((file) => ({
      kind: file.kind,
      fileName: sanitizeManualSvgFileName(file.fileName),
      contentType: file.contentType.trim().toLowerCase(),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256.toLowerCase(),
    }))
    .sort((left, right) => {
      const leftOrder = manualSvgFileKindOrder(left.kind as CncTelegramManualSvgUploadFileDto['kind']);
      const rightOrder = manualSvgFileKindOrder(right.kind as CncTelegramManualSvgUploadFileDto['kind']);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.fileName).localeCompare(String(right.fileName));
    });
}

async function reconcileManualSvgPresetIdempotency(
  tx: TransactionClient,
  input: {
    idempotencyKey: string;
    currentUserId: string;
    entityId: string;
    requestHash: string;
  },
): Promise<CncTelegramManualSvgCommentPresetDto | null> {
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, 'cnc_manual_svg_comment_preset', $4, $5, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING request_hash, response_json, status
    `,
    [
      input.idempotencyKey,
      MANUAL_SVG_PRESET_COMMAND_NAME,
      Number(input.currentUserId),
      input.entityId,
      input.requestHash,
    ],
  );
  if (inserted.rows[0]) return null;

  const existing = await tx.query<IdempotencyRow>(
    `
    SELECT request_hash, response_json, status
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.idempotencyKey);
  if (row.request_hash !== input.requestHash) {
    throw idempotencyError('IDEMPOTENCY_KEY_REUSED', input.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    const response = manualSvgPresetResponseFromJson(row.response_json);
    if (response) return response;
    throw new ApiError(
      500,
      'IDEMPOTENCY_RESPONSE_INVALID',
      'Stored manual SVG preset response is invalid',
      { idempotencyKey: input.idempotencyKey },
    );
  }
  if (row.status === 'failed') {
    throw idempotencyError('IDEMPOTENCY_FAILED', input.idempotencyKey);
  }
  throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.idempotencyKey);
}

function manualSvgUploadResponseFromJson(
  value: IdempotencyRow['response_json'],
): CncTelegramManualSvgUploadResponseDto | null {
  const parsed = parseStoredJsonObject(value);
  if (!parsed || typeof parsed.requestId !== 'string' || typeof parsed.packet !== 'object' || parsed.packet === null) return null;
  if (!('createdMdfMachineFileCard' in parsed) || typeof parsed.createdMdfMachineFileCard !== 'boolean') return null;
  return parsed as unknown as CncTelegramManualSvgUploadResponseDto;
}

function cncTelegramIngestResponseFromJson(
  value: IdempotencyRow['response_json'],
): CncTelegramIngestResponseDto | null {
  const parsed = parseStoredJsonObject(value);
  if (!parsed || typeof parsed.requestId !== 'string' || typeof parsed.packet !== 'object' || parsed.packet === null) return null;
  if (typeof parsed.applied !== 'boolean' || typeof parsed.ignoredStaleSourceVersion !== 'boolean') return null;
  if ('auditId' in parsed && typeof parsed.auditId !== 'string') return null;
  if (
    'skippedDuplicateSourceFile' in parsed
    && (
      typeof parsed.skippedDuplicateSourceFile !== 'object'
      || parsed.skippedDuplicateSourceFile === null
      || Array.isArray(parsed.skippedDuplicateSourceFile)
    )
  ) return null;
  return parsed as unknown as CncTelegramIngestResponseDto;
}

function manualSvgPresetResponseFromJson(
  value: IdempotencyRow['response_json'],
): CncTelegramManualSvgCommentPresetDto | null {
  const parsed = parseStoredJsonObject(value);
  if (
    !parsed ||
    typeof parsed.presetId !== 'number' ||
    !Number.isSafeInteger(parsed.presetId) ||
    typeof parsed.label !== 'string' ||
    typeof parsed.commentText !== 'string' ||
    typeof parsed.category !== 'string'
  ) return null;
  return parsed as unknown as CncTelegramManualSvgCommentPresetDto;
}

function parseStoredJsonObject(value: IdempotencyRow['response_json']): Record<string, unknown> | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

async function reconcileCncAutoCutStatusConfigureIdempotency(
  tx: TransactionClient,
  command: ConfigureCncAutoCutStatusCommand,
): Promise<CncAutoCutStatusConfigureResponseDto | null> {
  const requestHash = hashRequest({
    actorUserId: command.currentUser.id,
    commandName: CNC_AUTO_CUT_STATUS_CONFIGURE_COMMAND,
    enabled: command.enabled,
  });
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, 'app_setting', $4, $5, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING request_hash, response_json, status
    `,
    [
      command.idempotencyKey,
      CNC_AUTO_CUT_STATUS_CONFIGURE_COMMAND,
      Number(command.currentUser.id),
      CNC_AUTO_CUT_STATUS_SETTING_KEY,
      requestHash,
    ],
  );
  if (inserted.rows[0]) return null;

  const existing = await tx.query<IdempotencyRow>(
    `
    SELECT request_hash, response_json, status
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [command.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', command.idempotencyKey);
  if (row.request_hash !== requestHash) {
    throw idempotencyError('IDEMPOTENCY_KEY_REUSED', command.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    const response = cncAutoCutStatusConfigureResponse(row.response_json);
    if (response) return response;
    throw new ApiError(
      500,
      'IDEMPOTENCY_RESPONSE_INVALID',
      'Stored CNC auto cut status response is invalid',
      { idempotencyKey: command.idempotencyKey },
    );
  }
  if (row.status === 'failed') {
    throw idempotencyError('IDEMPOTENCY_FAILED', command.idempotencyKey);
  }
  throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', command.idempotencyKey);
}

function cncAutoCutStatusConfigureResponse(
  value: IdempotencyRow['response_json'],
): CncAutoCutStatusConfigureResponseDto | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const response = parsed as Partial<CncAutoCutStatusConfigureResponseDto>;
  if (
    typeof response.settingEnabled !== 'boolean'
    || typeof response.requestId !== 'string'
    || typeof response.auditId !== 'string'
    || !Number.isSafeInteger(response.completedPacketCount)
    || !Number.isSafeInteger(response.matchedDetailCount)
    || !Number.isSafeInteger(response.wholeOrderCount)
    || !Number.isSafeInteger(response.changedOrderCount)
    || !Number.isSafeInteger(response.changedDetailCount)
  ) return null;
  return response as CncAutoCutStatusConfigureResponseDto;
}

async function completeIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response:
    | CncTelegramIngestResponseDto
    | CncTelegramManualSvgUploadResponseDto
    | CncTelegramManualSvgCommentPresetDto
    | CncAutoCutStatusConfigureResponseDto,
): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'completed',
        response_json = $2::jsonb,
        completed_at = now()
    WHERE idempotency_key = $1
    `,
    [idempotencyKey, JSON.stringify(response)],
  );
}

async function failIdempotency(tx: TransactionClient, idempotencyKey: string): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'failed',
        completed_at = now()
    WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );
}

async function enqueueOutbox(
  tx: TransactionClient,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload),
      input.idempotencyKey,
    ],
  );
}

async function loadBathCards(
  database: DatabaseClient,
  workdayFrom: string,
  workdayTo: string,
): Promise<CncTelegramBathCardDto[]> {
  const result = await database.query<BathJoinedRow>(
    `
    WITH laminated_status_threshold AS (
      SELECT COALESCE(
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(COALESCE(ps.production_status_code, ''))) = 'laminated'
        ),
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(ps.production_status_name)) = 'закатан'
        )
      ) AS sort_order
      FROM production_statuses ps
    ),
    packed_status_threshold AS (
      SELECT COALESCE(
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(COALESCE(ps.production_status_code, ''))) = 'packed'
        ),
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(ps.production_status_name)) = 'упакован'
        )
      ) AS sort_order
      FROM production_statuses ps
    ),
    packet_items AS (
      SELECT
        p.completion_status,
        p.thumbs_up,
        NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(p.comments_json) AS packet_comment(comment_text)
          WHERE lower(packet_comment.comment_text) LIKE ANY (
            ARRAY['%hdf%', '%хдф%', '%лдсп%', '%ldsp%', '%fanera%', '%фанера%']
          )
        ) AS mdf_relevant,
        i.match_order_id,
        i.match_detail_id,
        i.source,
        lower(trim(i.order_name)) AS order_key,
        i.detail_number,
        i.width_mm,
        i.height_mm,
        i.quantity
      FROM cnc_telegram_packets p
      JOIN cnc_telegram_packet_items i ON i.packet_id = p.packet_id
      WHERE p.workday BETWEEN $1::date AND $2::date
        AND p.mdf_board_hidden_at IS NULL
    ),
    matched_target_details AS (
      SELECT
        item.match_order_id::bigint AS order_id,
        item.match_detail_id::bigint AS detail_id,
        SUM(
          CASE
            WHEN item.mdf_relevant
              AND (item.completion_status = 'completed' OR item.thumbs_up = true)
              THEN GREATEST(item.quantity, 0)
            ELSE 0
          END
        )::integer AS completed_quantity
      FROM packet_items item
      WHERE item.match_order_id IS NOT NULL
        AND item.match_detail_id IS NOT NULL
      GROUP BY item.match_order_id, item.match_detail_id
    ),
    unique_order_keys AS (
      SELECT
        lower(trim(o.order_name)) AS order_key,
        MIN(o.order_id)::bigint AS order_id
      FROM orders o
      WHERE o.delete_flag = false
        AND NULLIF(trim(o.order_name), '') IS NOT NULL
      GROUP BY lower(trim(o.order_name))
      HAVING COUNT(*) = 1
    ),
    completed_whole_order_keys AS (
      SELECT DISTINCT lower(trim(order_match.match[2])) AS order_key
      FROM cnc_telegram_packets p
      CROSS JOIN LATERAL jsonb_array_elements_text(p.comments_json) AS packet_comment(comment_text)
      CROSS JOIN LATERAL regexp_matches(
        packet_comment.comment_text,
        '(^|[^0-9])([0-9]{4,})([^0-9]|$)',
        'g'
      ) AS order_match(match)
      WHERE p.workday BETWEEN $1::date AND $2::date
        AND p.mdf_board_hidden_at IS NULL
        AND (p.completion_status = 'completed' OR p.thumbs_up = true)
        AND lower(packet_comment.comment_text) LIKE '%весь%'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(p.comments_json) AS material_comment(comment_text)
          WHERE lower(material_comment.comment_text) LIKE ANY (
            ARRAY['%hdf%', '%хдф%', '%лдсп%', '%ldsp%', '%fanera%', '%фанера%']
          )
        )
    ),
    whole_order_target_details AS (
      SELECT
        order_key.order_id,
        od.detail_id::bigint AS detail_id,
        1000000000::integer AS completed_quantity
      FROM completed_whole_order_keys whole_order
      JOIN unique_order_keys order_key
        ON order_key.order_key = whole_order.order_key
      JOIN order_details od
        ON od.order_id = order_key.order_id
       AND od.delete_flag = false
    ),
    fallback_target_details AS (
      SELECT
        order_key.order_id,
        od.detail_id::bigint AS detail_id,
        SUM(
          CASE
            WHEN item.mdf_relevant
              AND (item.completion_status = 'completed' OR item.thumbs_up = true)
              THEN GREATEST(item.quantity, 0)
            ELSE 0
          END
        )::integer AS completed_quantity
      FROM packet_items item
      JOIN unique_order_keys order_key
        ON order_key.order_key = item.order_key
      JOIN order_details od
        ON od.order_id = order_key.order_id
       AND od.delete_flag = false
      WHERE item.match_order_id IS NULL
        AND item.match_detail_id IS NULL
        AND item.detail_number IS NOT NULL
        AND od.detail_number = item.detail_number
        AND item.width_mm IS NOT NULL
        AND item.height_mm IS NOT NULL
        AND od.width IS NOT NULL
        AND od.height IS NOT NULL
        AND (
          (
            item.source <> 'ocr'
            AND (
              (
                item.width_mm::numeric = od.width::numeric
                AND item.height_mm::numeric = od.height::numeric
              )
              OR (
                item.width_mm::numeric = od.height::numeric
                AND item.height_mm::numeric = od.width::numeric
              )
            )
          )
          OR (
            item.source = 'ocr'
            AND (
              (
                ABS(item.width_mm::numeric - od.width::numeric) <= 3
                AND ABS(item.height_mm::numeric - od.height::numeric) <= 3
              )
              OR (
                ABS(item.width_mm::numeric - od.height::numeric) <= 3
                AND ABS(item.height_mm::numeric - od.width::numeric) <= 3
              )
            )
          )
        )
      GROUP BY order_key.order_id, od.detail_id
    ),
    target_details AS (
      SELECT
        target.order_id,
        target.detail_id,
        LEAST(SUM(target.completed_quantity), 1000000000::bigint)::integer AS completed_quantity
      FROM (
        SELECT * FROM matched_target_details
        UNION ALL
        SELECT * FROM fallback_target_details
        UNION ALL
        SELECT * FROM whole_order_target_details
      ) target
      GROUP BY target.order_id, target.detail_id
    ),
    candidate_vacuum_results AS (
      SELECT
        r.cut_result_id,
        r.cut_job_id,
        j.source_display_number,
        r.result_no,
        r.revision_no,
        r.created_at AS result_created_at,
        COALESCE(r.snapshot_job ->> 'name', j.name, 'Раскрой ' || j.cut_job_id::text) AS cut_job_name,
        (current_result.result_no = r.result_no) AS is_current_result
      FROM cut_job j
      JOIN cut_result r ON r.cut_job_id = j.cut_job_id
      LEFT JOIN cut_result current_result
        ON current_result.cut_result_id = j.current_cut_result_id
      LEFT JOIN cut_param_profiles profile
        ON profile.cut_param_profile_id = j.param_profile_id
      LEFT JOIN cut_result_archive_state archive
        ON archive.cut_job_id = r.cut_job_id
       AND archive.result_no = r.result_no
      JOIN cut_result_label_map_projection projection
        ON projection.cut_result_id = r.cut_result_id
       AND projection.snapshot_digest = r.snapshot_digest
      WHERE r.snapshot_job IS NOT NULL
        AND j.status <> 'archived'
        AND COALESCE(profile.params ->> 'layout_mode', j.params ->> 'layout_mode') = 'vacuum_table'
        AND archive.archived_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM cut_result_placement placement
          JOIN cut_result_sheet_map sheet
            ON sheet.cut_result_sheet_map_id = placement.cut_result_sheet_map_id
           AND sheet.is_effective = true
          JOIN target_details target
            ON target.order_id = placement.order_id
           AND target.detail_id = placement.order_detail_id
          WHERE placement.cut_result_id = r.cut_result_id
        )
    ),
    latest_vacuum_results AS (
      SELECT DISTINCT ON (candidate.cut_job_id)
        candidate.*
      FROM candidate_vacuum_results candidate
      ORDER BY
        candidate.cut_job_id,
        candidate.is_current_result DESC,
        candidate.result_created_at DESC,
        candidate.result_no DESC,
        candidate.revision_no DESC,
        candidate.cut_result_id DESC
    )
    SELECT
      result.cut_result_id,
      result.cut_job_id,
      result.result_no,
      result.revision_no,
      result.result_created_at,
      result.cut_job_name,
      placement.order_id,
      placement.order_detail_id,
      COALESCE(NULLIF(trim(o.order_name), ''), placement.order_id::text) AS order_name,
      od.detail_number,
      COALESCE(od.width, placement.detail_width_mm) AS width_mm,
      COALESCE(od.height, placement.detail_height_mm) AS height_mm,
      COALESCE(target.completed_quantity, 0) AS completed_quantity,
      CASE
        WHEN detail_status.sort_order IS NOT NULL
          AND laminated_status.sort_order IS NOT NULL
          THEN detail_status.sort_order >= laminated_status.sort_order
        ELSE false
      END AS laminated_or_later,
      CASE
        WHEN detail_status.sort_order IS NOT NULL
          AND packed_status.sort_order IS NOT NULL
          THEN detail_status.sort_order >= packed_status.sort_order
        ELSE false
      END AS packed_or_later,
      sheet.cut_group_id,
      sheet.variant,
      sheet.sheet_index,
      sheet.sheet_ordinal,
      sheet.sheet_width_mm,
      sheet.sheet_height_mm
    FROM latest_vacuum_results result
    JOIN cut_result_placement placement
      ON placement.cut_result_id = result.cut_result_id
    JOIN cut_result_sheet_map sheet
      ON sheet.cut_result_sheet_map_id = placement.cut_result_sheet_map_id
     AND sheet.is_effective = true
    LEFT JOIN orders o
      ON o.order_id = placement.order_id
     AND o.delete_flag = false
    LEFT JOIN order_details od
      ON od.detail_id = placement.order_detail_id
     AND od.delete_flag = false
    LEFT JOIN production_statuses detail_status
      ON detail_status.production_status_id = od.production_status_id
    CROSS JOIN laminated_status_threshold laminated_status
    CROSS JOIN packed_status_threshold packed_status
    LEFT JOIN target_details target
      ON target.order_id = placement.order_id
     AND target.detail_id = placement.order_detail_id
    ORDER BY
      result.result_created_at DESC,
      result.cut_result_id DESC,
      sheet.sheet_ordinal ASC,
      placement.order_id ASC,
      od.detail_number ASC NULLS LAST,
      placement.order_detail_id ASC,
      placement.instance ASC
    `,
    [workdayFrom, workdayTo],
  );
  return mapBathRows(result.rows);
}

function buildTodayColumns(
  packets: CncTelegramPacketDto[],
  baths: CncTelegramBathCardDto[],
  bazisCutSets: CncTelegramBazisCutSetCardDto[],
): CncTelegramTodayColumnDto[] {
  const definitions: Array<Pick<CncTelegramTodayColumnDto, 'key' | 'title'>> = [
    { key: 'parsed', title: 'Файлы на станке' },
    { key: 'completed', title: 'Выполнено' },
  ];
  const activeBazisCutSets = bazisCutSets.filter((set) => !allItemsPackedOrLater(set.items));
  const completedBazisCutSets = bazisCutSets.filter((set) => allItemsPackedOrLater(set.items));
  const packetColumns = definitions.map((definition) => {
    const columnPackets = packets.filter((packet) => packetColumnKey(packet) === definition.key);
    const columnBazisCutSets = definition.key === 'parsed' ? activeBazisCutSets : [];
    return {
      ...definition,
      total: columnPackets.length + columnBazisCutSets.length,
      packets: columnPackets,
      baths: [],
      bazisCutSets: columnBazisCutSets,
    };
  });

  const completedBaths = baths.filter((bath) => allItemsPackedOrLater(bath.items));
  const activeBaths = baths.filter((bath) => !allItemsPackedOrLater(bath.items));
  const pendingBaths = activeBaths.filter((bath) => !bath.ready);
  const readyBaths = activeBaths.filter((bath) =>
    bath.ready && !allItemsLaminatedOrLater(bath.items),
  );
  const laminatedBaths = baths.filter((bath) =>
    bath.ready && allItemsLaminatedOrLater(bath.items) && !allItemsPackedOrLater(bath.items),
  );
  const laminatedPackets = packets.filter(
    (packet) => packetColumnKey(packet) === 'completed_laminated',
  );
  return [
    ...packetColumns,
    {
      key: 'baths',
      title: 'Ванны',
      total: pendingBaths.length,
      packets: [],
      baths: pendingBaths,
      bazisCutSets: [],
    },
    {
      key: 'baths_ready',
      title: 'Готовы к закатке',
      total: readyBaths.length,
      packets: [],
      baths: readyBaths,
      bazisCutSets: [],
    },
    {
      key: 'completed_laminated',
      title: 'Распиленные файлы',
      total: laminatedPackets.length + completedBazisCutSets.length,
      packets: laminatedPackets,
      baths: [],
      bazisCutSets: completedBazisCutSets,
    },
    {
      key: 'baths_laminated',
      title: 'Закатаны/выданы',
      total: laminatedBaths.length,
      packets: [],
      baths: laminatedBaths,
      bazisCutSets: [],
    },
    {
      key: 'completed_baths',
      title: 'Завершенные ванны',
      total: completedBaths.length,
      packets: [],
      baths: completedBaths,
      bazisCutSets: [],
    },
  ];
}

async function loadPeriodBazisCutSetCards(
  database: DatabaseClient,
  workdayFrom: string,
  workdayTo: string,
): Promise<CncTelegramBazisCutSetCardDto[]> {
  const result = await database.query<BazisCutSetJoinedRow>(
    `
    WITH packed_status_threshold AS (
      SELECT COALESCE(
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(COALESCE(ps.production_status_code, ''))) = 'packed'
        ),
        MIN(ps.sort_order) FILTER (
          WHERE lower(trim(ps.production_status_name)) = 'упакован'
        )
      ) AS sort_order
      FROM production_statuses ps
    ),
    issued_status_threshold AS (
      SELECT MIN(os.sort_order) FILTER (
        WHERE lower(trim(os.order_status_name)) = 'выдан'
      ) AS sort_order
      FROM order_statuses os
    ),
    target_bazis_cut_sets AS (
      SELECT cut_set.bazis_cut_set_id
      FROM bazis_cut_sets cut_set
      WHERE cut_set.created_at >= $1::date
        AND cut_set.created_at < ($2::date + INTERVAL '1 day')
    )
    SELECT
      cut_set.bazis_cut_set_id,
      cut_set.name,
      cut_set.created_at,
      detail.sort_order,
      detail.source_order_detail_id,
      COALESCE(detail.source_order_id, source_detail.order_id) AS source_order_id,
      COALESCE(
        NULLIF(btrim(detail.source_order_name), ''),
        NULLIF(btrim(source_order.order_name), ''),
        'Без заказа'
      ) AS source_order_name,
      COALESCE(source_order.delete_flag, false) AS source_order_deleted,
      source_detail.detail_number,
      COALESCE(source_detail.width, detail.finished_width_mm) AS width_mm,
      COALESCE(source_detail.height, detail.finished_length_mm) AS height_mm,
      detail.material_name,
      detail.quantity,
      CASE
        WHEN (
          detail_status.sort_order IS NOT NULL
          AND packed_status.sort_order IS NOT NULL
          AND detail_status.sort_order >= packed_status.sort_order
        ) THEN true
        WHEN (
          source_order_status.sort_order IS NOT NULL
          AND issued_status.sort_order IS NOT NULL
          AND source_order_status.sort_order >= issued_status.sort_order
        ) THEN true
        WHEN issued_order_move.move_id IS NOT NULL THEN true
        ELSE false
      END AS packed_or_later
    FROM target_bazis_cut_sets target
    JOIN bazis_cut_sets cut_set
      ON cut_set.bazis_cut_set_id = target.bazis_cut_set_id
    JOIN bazis_cut_set_details detail
      ON detail.bazis_cut_set_id = cut_set.bazis_cut_set_id
    LEFT JOIN order_details source_detail
      ON source_detail.detail_id = detail.source_order_detail_id
    LEFT JOIN orders source_order
      ON source_order.order_id = COALESCE(detail.source_order_id, source_detail.order_id)
    LEFT JOIN order_statuses source_order_status
      ON source_order_status.order_status_id = source_order.order_status_id
    LEFT JOIN production_statuses detail_status
      ON detail_status.production_status_id = source_detail.production_status_id
    LEFT JOIN mdf_board_manual_moves issued_order_move
      ON issued_order_move.card_kind = 'order'
      AND issued_order_move.card_id = source_order.order_id::text
      AND issued_order_move.target_column = 'orders_issued'
    CROSS JOIN packed_status_threshold packed_status
    CROSS JOIN issued_status_threshold issued_status
    ORDER BY cut_set.created_at DESC, cut_set.bazis_cut_set_id DESC,
      detail.sort_order, detail.bazis_cut_set_detail_id
    `,
    [workdayFrom, workdayTo],
  );
  return mapBazisCutSetRows(result.rows);
}

function mapBazisCutSetRows(
  rows: readonly BazisCutSetJoinedRow[],
): CncTelegramBazisCutSetCardDto[] {
  const cards = new Map<number, {
    card: CncTelegramBazisCutSetCardDto;
    orderKeys: Set<string>;
  }>();

  for (const row of rows) {
    const bazisCutSetId = toPositiveInteger(row.bazis_cut_set_id);
    if (bazisCutSetId === null) continue;
    let accumulator = cards.get(bazisCutSetId);
    if (!accumulator) {
      accumulator = {
        card: {
          bazisCutSetId,
          name: normalizeOptional(row.name) ?? `БР-${bazisCutSetId}`,
          createdAt: toIso(row.created_at),
          orderCount: 0,
          positionCount: 0,
          itemQuantityTotal: 0,
          items: [],
        },
        orderKeys: new Set(),
      };
      cards.set(bazisCutSetId, accumulator);
    }

    const orderId = toPositiveInteger(row.source_order_id);
    const orderName = normalizeOptional(row.source_order_name) ?? 'Без заказа';
    const quantity = Math.max(0, toNumber(row.quantity));
    const item: CncTelegramBazisCutSetItemDto = {
      orderId,
      orderName,
      orderDeleted: row.source_order_deleted === true,
      detailId: toPositiveInteger(row.source_order_detail_id),
      detailNumber: toNullableNumber(row.detail_number),
      widthMm: toNullableNumber(row.width_mm),
      heightMm: toNullableNumber(row.height_mm),
      materialName: normalizeOptional(row.material_name) ?? 'Не определён',
      quantity,
      packedOrLater: row.packed_or_later === true,
    };
    accumulator.card.items.push(item);
    accumulator.card.positionCount += 1;
    accumulator.card.itemQuantityTotal += quantity;
    accumulator.orderKeys.add(orderId === null ? `name:${orderName}` : `id:${orderId}`);
  }

  return Array.from(cards.values()).map(({ card, orderKeys }) => ({
    ...card,
    orderCount: orderKeys.size,
  }));
}

function allItemsLaminatedOrLater(
  items: ReadonlyArray<{ laminatedOrLater: boolean }>,
): boolean {
  return items.length > 0 && items.every((item) => item.laminatedOrLater);
}

function allItemsPackedOrLater(
  items: ReadonlyArray<{ packedOrLater: boolean }>,
): boolean {
  return items.length > 0 && items.every((item) => item.packedOrLater);
}

function mapBathRows(rows: BathJoinedRow[]): CncTelegramBathCardDto[] {
  const cards = new Map<string, {
    card: CncTelegramBathCardDto;
    itemsByKey: Map<string, CncTelegramBathItemDto>;
    sheetKeys: Set<string>;
    orderIds: Set<number>;
  }>();

  for (const row of rows) {
    const cutResultId = toPositiveInteger(row.cut_result_id);
    const cutJobId = toPositiveInteger(row.cut_job_id);
    const resultNo = toPositiveInteger(row.result_no);
    const revisionNo = toPositiveInteger(row.revision_no);
    if (cutResultId === null || cutJobId === null || resultNo === null || revisionNo === null) {
      continue;
    }

    const bathCardId = `cut-result:${cutResultId}`;
    let accumulator = cards.get(bathCardId);
    if (!accumulator) {
      const card: CncTelegramBathCardDto = {
        bathCardId,
        cutJobId,
        cutResultId,
        resultNo,
        revisionNo,
        cutNumber: formatCutNumber(cutJobId, resultNo, true, row.source_display_number),
        displayCutNumber: formatCutJobNumber(cutJobId, true, row.source_display_number),
        cutJobName: normalizeOptional(row.cut_job_name) ?? `Раскрой ${cutJobId}`,
        createdAt: toIso(row.result_created_at),
        ready: false,
        orderCount: 0,
        positionCount: 0,
        itemQuantityTotal: 0,
        items: [],
        sheets: [],
      };
      accumulator = {
        card,
        itemsByKey: new Map(),
        sheetKeys: new Set(),
        orderIds: new Set(),
      };
      cards.set(bathCardId, accumulator);
    }

    const sheet = bathSheetFromRow(row);
    if (sheet) {
      const sheetKey = `${sheet.cutGroupId}:${sheet.variant}:${sheet.sheetIndex}`;
      if (!accumulator.sheetKeys.has(sheetKey)) {
        accumulator.sheetKeys.add(sheetKey);
        accumulator.card.sheets.push(sheet);
      }
    }

    const orderId = toPositiveInteger(row.order_id);
    const detailId = toPositiveInteger(row.order_detail_id);
    if (orderId === null || detailId === null) continue;

    const itemKey = `${orderId}:${detailId}`;
    let item = accumulator.itemsByKey.get(itemKey);
    if (!item) {
      item = {
        bathItemId: `${bathCardId}:detail:${itemKey}`,
        orderId,
        orderName: normalizeOptional(row.order_name) ?? String(orderId),
        detailId,
        detailNumber: toNullableNumber(row.detail_number),
        widthMm: toNullableNumber(row.width_mm),
        heightMm: toNullableNumber(row.height_mm),
        quantity: 0,
        completedQuantity: Math.max(0, toNumber(row.completed_quantity)),
        ready: false,
        laminatedOrLater: row.laminated_or_later === true,
        packedOrLater: row.packed_or_later === true,
      };
      accumulator.itemsByKey.set(itemKey, item);
      accumulator.orderIds.add(orderId);
    }
    item.quantity += 1;
  }

  const result: CncTelegramBathCardDto[] = [];
  for (const accumulator of cards.values()) {
    const items = Array.from(accumulator.itemsByKey.values()).sort(compareBathItems);
    for (const item of items) {
      item.ready = item.completedQuantity >= item.quantity;
    }
    const card = accumulator.card;
    card.items = items;
    card.sheets.sort(compareBathSheets);
    card.orderCount = accumulator.orderIds.size;
    card.positionCount = items.length;
    card.itemQuantityTotal = items.reduce((sum, item) => sum + item.quantity, 0);
    card.ready = items.length > 0 && items.every((item) => item.ready);
    result.push(card);
  }

  return result;
}

function bathSheetFromRow(row: BathJoinedRow): CncTelegramBathSheetDto | null {
  const cutGroupId = toPositiveInteger(row.cut_group_id);
  const sheetIndex = toNullableNumber(row.sheet_index);
  const sheetNumber = toPositiveInteger(row.sheet_ordinal);
  if (cutGroupId === null || sheetIndex === null || sheetNumber === null) return null;
  return {
    cutGroupId,
    sheetIndex,
    sheetNumber,
    variant: row.variant === 'manual' ? 'manual' : 'auto',
    sheetWidthMm: toNullableNumber(row.sheet_width_mm),
    sheetHeightMm: toNullableNumber(row.sheet_height_mm),
  };
}

function compareBathItems(left: CncTelegramBathItemDto, right: CncTelegramBathItemDto): number {
  return (
    left.orderName.localeCompare(right.orderName, 'ru', { numeric: true }) ||
    (left.detailNumber ?? Number.MAX_SAFE_INTEGER) - (right.detailNumber ?? Number.MAX_SAFE_INTEGER) ||
    left.detailId - right.detailId
  );
}

function compareBathSheets(left: CncTelegramBathSheetDto, right: CncTelegramBathSheetDto): number {
  return left.sheetNumber - right.sheetNumber || left.cutGroupId - right.cutGroupId;
}

function packetColumnKey(
  packet: CncTelegramPacketDto,
): 'parsed' | 'completed' | 'completed_laminated' {
  if (packet.completionStatus === 'completed' || packet.thumbsUp) {
    return packet.allLinkedOrderDetailsPackedOrLater ? 'completed_laminated' : 'completed';
  }
  return 'parsed';
}

function mapOrderCuttingSequenceRow(row: OrderCuttingSequenceRow): CncTelegramOrderCuttingSequenceDto {
  return {
    packetId: row.packet_id,
    externalPacketKey: row.external_packet_key,
    cuttingSequenceNo: toNumber(row.cutting_sequence_no),
    sourceMessageId: toNullableNumber(row.source_message_id),
    workday: toDateOnly(row.workday),
    programName: row.program_name,
    materialName: row.material_name,
    completionStatus: row.completion_status,
    sourceCreatedAt: toNullableIso(row.source_created_at),
    itemQuantityTotal: toNumber(row.item_quantity_total),
  };
}

function mapPacketRows(rows: PacketJoinedRow[]): CncTelegramPacketDto[] {
  const packets = new Map<string, CncTelegramPacketDto>();
  for (const row of rows) {
    let packet = packets.get(row.packet_id);
    if (!packet) {
      packet = {
        packetId: row.packet_id,
        externalPacketKey: row.external_packet_key,
        cuttingSequenceNo: toNullableNumber(row.cutting_sequence_no),
        sourceChatId: row.source_chat_id,
        sourceMessageId: toNullableNumber(row.source_message_id),
        sourceThreadId: toNullableNumber(row.source_thread_id),
        sourceVersion: toNumber(row.source_version),
        sourceCreatedAt: toNullableIso(row.source_created_at),
        sourceUpdatedAt: toNullableIso(row.source_updated_at),
        workday: toDateOnly(row.workday),
        machine: row.machine,
        programName: row.program_name,
        materialName: row.material_name,
        sheetImageUrl: row.sheet_image_storage_key
          ? `/api/v1/cnc-telegram/media/${encodeURIComponent(row.sheet_image_storage_key)}`
          : null,
        sheetImageContentType: row.sheet_image_content_type,
        sheetImageSizeBytes: toNullableNumber(row.sheet_image_size_bytes),
        parseStatus: row.parse_status,
        completionStatus: row.completion_status,
        thumbsUp: row.thumbs_up === true,
        completedAt: toNullableIso(row.completed_at),
        rework: row.rework === true,
        comments: stringArray(row.comments_json),
        tools: toolArray(row.tools_json),
        dowelingLinks: dowelingArray(row.doweling_links_json),
        analysisWarnings: analysisWarningsArray(row.analysis_warnings_json),
        ocrEngine: row.ocr_engine,
        parserVersion: row.parser_version,
        cutLayout: cutLayoutOrNull(row.cut_layout_json),
        svgCutJobId: toNullableNumber(row.svg_cut_job_id),
        svgCutJobDisplayNumber: nullableDisplayNumber(row.svg_cut_job_id, row.svg_cut_job_display_number),
        svgCutResultId: toNullableNumber(row.svg_cut_result_id),
        svgCutResultNo: toNullableNumber(row.svg_cut_result_no),
        svgCutImportStatus: row.svg_cut_import_status ?? 'none',
        svgCutImportNote: row.svg_cut_import_note,
        allLinkedOrderDetailsPackedOrLater: false,
        svgCutSheets: packetCutSheetsArray(row.svg_cut_sheets_json),
        itemCount: 0,
        itemQuantityTotal: 0,
        updatedAt: toIso(row.updated_at),
        items: [],
      };
      packets.set(row.packet_id, packet);
    }

    if (row.packet_item_id) {
      packet.allLinkedOrderDetailsPackedOrLater = packet.itemCount === 0
        ? row.all_linked_order_details_packed_or_later === true
        : packet.allLinkedOrderDetailsPackedOrLater
          && row.all_linked_order_details_packed_or_later === true;
      const item: CncTelegramPacketItemDto = {
        packetItemId: row.packet_item_id,
        sourceItemKey: row.source_item_key ?? '',
        orderName: row.order_name ?? '',
        orderId: toNullableNumber(row.item_order_id),
        ...(row.order_delete_flag === true ? { orderDeleted: true } : {}),
        detailNumber: toNullableNumber(row.detail_number),
        widthMm: toNullableNumber(row.width_mm),
        heightMm: toNullableNumber(row.height_mm),
        quantity: toNumber(row.quantity),
        source: row.item_source ?? 'ocr',
        confidence: toNumber(row.confidence),
        matchOrderId: toNullableNumber(row.match_order_id),
        matchDetailId: toNullableNumber(row.match_detail_id),
        matchDetailQuantity: toNullableNumber(row.match_detail_quantity),
        matchStatus: row.match_status ?? 'unmatched',
        reviewNote: row.review_note,
        laminatedOrLater:
          row.match_status === 'matched' && row.laminated_or_later === true,
      };
      packet.items.push(item);
      packet.itemCount += 1;
      packet.itemQuantityTotal += item.quantity;
    }
  }
  return Array.from(packets.values());
}

function packetAuditSnapshot(packet: CncTelegramPacketDto): Record<string, unknown> {
  return {
    packetId: packet.packetId,
    externalPacketKey: packet.externalPacketKey,
    cuttingSequenceNo: packet.cuttingSequenceNo,
    sourceVersion: packet.sourceVersion,
    workday: packet.workday,
    machine: packet.machine,
    programName: packet.programName,
    materialName: packet.materialName,
    parseStatus: packet.parseStatus,
    completionStatus: packet.completionStatus,
    thumbsUp: packet.thumbsUp,
    rework: packet.rework,
    itemCount: packet.itemCount,
    itemQuantityTotal: packet.itemQuantityTotal,
    warningsCount: packet.analysisWarnings.length,
    commentsCount: packet.comments.length,
    cutLayoutStatus: packet.cutLayout?.status ?? null,
    svgCutImportStatus: packet.svgCutImportStatus ?? 'none',
    svgCutImportNote: packet.svgCutImportNote ?? null,
    svgCutJobId: packet.svgCutJobId ?? null,
    svgCutJobDisplayNumber: packet.svgCutJobDisplayNumber ?? null,
    svgCutResultId: packet.svgCutResultId ?? null,
  };
}

function deriveParseStatus(dto: CncTelegramStructuredIngestDto): CncTelegramPacketDto['parseStatus'] {
  if (analysisWarningsArray(dto.analysisWarnings ?? []).length > 0) return 'needs_review';
  if (dto.items.some((item) => item.matchStatus === 'conflict' || item.matchStatus === 'needs_review')) {
    return 'needs_review';
  }
  return 'parsed';
}

function hashPayload(dto: CncTelegramStructuredIngestDto): string {
  const { idempotencyKey: _idempotencyKey, cuttingSequenceNo: _cuttingSequenceNo, ...payload } = dto;
  return `sha256:${createHash('sha256').update(stableStringify(payload)).digest('hex')}`;
}

function hashRequest(value: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  ).join(',')}}`;
}

function idempotencyError(code: string, idempotencyKey: string): ApiError {
  return new ApiError(409, code, 'Idempotent CNC Telegram command cannot be processed', {
    idempotencyKey,
  });
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

async function currentDatabaseWorkday(database: DatabaseClient): Promise<string> {
  const result = await database.query<CurrentDateRow>(
    'SELECT CURRENT_DATE::text AS workday',
  );
  const workday = result.rows[0]?.workday;
  if (!workday) {
    throw new ApiError(500, 'CNC_TELEGRAM_WORKDAY_UNAVAILABLE', 'Database workday is unavailable');
  }
  return toDateOnly(workday);
}

function dateOnlyDaysBefore(value: string, days: number): string {
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return value;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequired(value: string): string {
  return normalizeOptional(value) ?? '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function positiveNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((item) => Number(item))
      .filter(isPositiveNumber),
  )).sort((left, right) => left - right);
}

function analysisWarningsArray(value: unknown): string[] {
  return stringArray(value).filter((warning) => !IGNORED_ANALYSIS_WARNINGS.has(warning));
}

function toolArray(value: unknown): CncTelegramToolDto[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CncTelegramToolDto =>
    Boolean(item) &&
    typeof item === 'object' &&
    Number.isSafeInteger((item as CncTelegramToolDto).toolNumber),
  );
}

function dowelingArray(value: unknown): CncTelegramDowelingLinkDto[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CncTelegramDowelingLinkDto =>
    Boolean(item) &&
    typeof item === 'object' &&
    typeof (item as CncTelegramDowelingLinkDto).orderName === 'string' &&
    typeof (item as CncTelegramDowelingLinkDto).dowelingNumber === 'string',
  );
}

function packetCutSheetsArray(value: unknown): CncTelegramPacketCutSheetDto[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(packetCutSheetOrNull)
    .filter((sheet): sheet is CncTelegramPacketCutSheetDto => sheet !== null);
}

function packetCutSheetOrNull(value: unknown): CncTelegramPacketCutSheetDto | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const cutGroupId = toPositiveInteger(raw.cutGroupId as string | number | null | undefined);
  const sheetIndex = toNullableNumber(raw.sheetIndex as string | number | null | undefined);
  const sheetNumber = toPositiveInteger(raw.sheetNumber as string | number | null | undefined);
  const detailIds = Array.isArray(raw.detailIds)
    ? raw.detailIds
      .map((id) => toPositiveInteger(id as string | number | null | undefined))
      .filter((id): id is number => id !== null)
    : [];
  if (
    cutGroupId === null ||
    sheetNumber === null ||
    sheetIndex === null ||
    !Number.isInteger(sheetIndex) ||
    sheetIndex < 0
  ) {
    return null;
  }
  return {
    cutGroupId,
    sheetIndex,
    sheetNumber,
    variant: raw.variant === 'manual' ? 'manual' : 'auto',
    detailIds,
  };
}

function cutLayoutOrNull(value: unknown): CncTelegramCutLayoutDto | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.status !== 'valid' && raw.status !== 'invalid') return null;
  const rawSheet = raw.sheet;
  const sheet = rawSheet && typeof rawSheet === 'object'
    ? {
        widthMm: toNumber((rawSheet as Record<string, unknown>).widthMm as string | number | null | undefined),
        heightMm: toNumber((rawSheet as Record<string, unknown>).heightMm as string | number | null | undefined),
      }
    : null;
  const items = Array.isArray(raw.items)
    ? raw.items.map(cutLayoutItemOrNull).filter((item): item is CncTelegramCutLayoutItemDto => item !== null)
    : [];
  return {
    status: raw.status,
    reasons: stringArray(raw.reasons),
    sheet: sheet && sheet.widthMm > 0 && sheet.heightMm > 0 ? sheet : null,
    rawCommentCount: toNullableNumber(raw.rawCommentCount as string | number | null | undefined),
    partContourCount: toNullableNumber(raw.partContourCount as string | number | null | undefined),
    acceptedItemCount: toNullableNumber(raw.acceptedItemCount as string | number | null | undefined),
    items,
  };
}

function cutLayoutItemOrNull(value: unknown): CncTelegramCutLayoutItemDto | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const orderName = typeof raw.orderName === 'string' ? raw.orderName : '';
  const detailNumber = toNumber(raw.detailNumber as string | number | null | undefined);
  const widthMm = toNumber(raw.widthMm as string | number | null | undefined);
  const heightMm = toNumber(raw.heightMm as string | number | null | undefined);
  const xMm = toNumber(raw.xMm as string | number | null | undefined);
  const yMm = toNumber(raw.yMm as string | number | null | undefined);
  const placedWidthMm = toNumber(raw.placedWidthMm as string | number | null | undefined);
  const placedHeightMm = toNumber(raw.placedHeightMm as string | number | null | undefined);
  if (!orderName || detailNumber <= 0 || widthMm <= 0 || heightMm <= 0 || placedWidthMm <= 0 || placedHeightMm <= 0) {
    return null;
  }
  return {
    orderName,
    detailNumber,
    widthMm,
    heightMm,
    quantity: Math.max(1, toNumber(raw.quantity as string | number | null | undefined) || 1),
    confidence: toNullableNumber(raw.confidence as string | number | null | undefined),
    sourceElementId: typeof raw.sourceElementId === 'string' ? raw.sourceElementId : null,
    xMm,
    yMm,
    placedWidthMm,
    placedHeightMm,
    rotated: raw.rotated === true,
    sourceSvg: cutLayoutItemSourceSvgOrNull(raw.sourceSvg),
    visualLabel: cutLayoutItemVisualLabelOrNull(raw.visualLabel),
  };
}

function cutLayoutItemVisualLabelOrNull(value: unknown): CncTelegramCutLayoutItemDto['visualLabel'] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.rawLines)) return null;
  const rawLines = raw.rawLines
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  return rawLines.length > 0 ? { rawLines } : null;
}

function cutLayoutItemSourceSvgOrNull(value: unknown): CncTelegramCutLayoutItemDto['sourceSvg'] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const rawViewBox = raw.viewBox;
  if (!rawViewBox || typeof rawViewBox !== 'object') return null;
  const viewBox = rawViewBox as Record<string, unknown>;
  const sourceSvg = {
    viewBox: {
      xMm: toNumber(viewBox.xMm as string | number | null | undefined),
      yMm: toNumber(viewBox.yMm as string | number | null | undefined),
      widthMm: toNumber(viewBox.widthMm as string | number | null | undefined),
      heightMm: toNumber(viewBox.heightMm as string | number | null | undefined),
    },
    body: typeof raw.body === 'string' ? raw.body : '',
  };
  if (
    sourceSvg.viewBox.widthMm <= 0 ||
    sourceSvg.viewBox.heightMm <= 0 ||
    sourceSvg.body.trim().length === 0 ||
    sourceSvg.body.length > 60_000 ||
    /<\s*(?:script|foreignObject)\b|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|(?:javascript:|data:|https?:|file:)/i.test(sourceSvg.body)
  ) {
    return null;
  }
  return sourceSvg;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  return Number(value);
}

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  return Number(value);
}

function nullableDisplayNumber(
  cutJobId: string | number | null | undefined,
  sourceDisplayNumber: string | number | null | undefined,
): string | null {
  const normalized = normalizeOptional(sourceDisplayNumber == null ? null : String(sourceDisplayNumber));
  if (normalized) return normalized;
  const fallbackCutJobId = toNullableNumber(cutJobId);
  return fallbackCutJobId === null ? null : String(fallbackCutJobId);
}

function toNullableFiniteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function toPositiveInteger(value: string | number | null | undefined): number | null {
  const numberValue = toNullableFiniteNumber(value);
  return numberValue !== null && Number.isInteger(numberValue) && numberValue > 0
    ? numberValue
    : null;
}

function toNullablePositiveInteger(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  return toPositiveInteger(value);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return toIso(value);
}

function toDateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function isPositiveNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
