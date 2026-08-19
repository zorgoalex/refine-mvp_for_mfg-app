import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { cncMdfTargetDetailsCtes } from '../../../shared/cnc-mdf-board/target-details-sql.js';
import { freecutItemId, type FreecutPlacement, type SheetPlacementsJson } from '../../cut/application/cut-freecut-mapping';
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
import type {
  CncTelegramDeniedAuditPort,
  CncTelegramRepositoryPort,
  CreateCncMdfCardCommand,
  CreateManualSvgCommentPresetCommand,
  IngestCncTelegramPacketCommand,
  ListManualSvgCommentPresetsCommand,
  ListCncTelegramOriginalBoardCommand,
  ListCncTelegramTodayCommand,
  ManualSvgUploadCommand,
  RecordCncTelegramDeniedAuditCommand,
} from '../application/cnc-telegram.types';
import type {
  CncTelegramBathCardDto,
  CncTelegramBathItemDto,
  CncTelegramBathSheetDto,
  CncTelegramCutLayoutDto,
  CncTelegramCutLayoutItemDto,
  CncTelegramDowelingLinkDto,
  CncTelegramIngestResponseDto,
  CncTelegramItemSource,
  CncTelegramManualSvgCommentPresetDto,
  CncTelegramManualSvgUploadResponseDto,
  CncTelegramOriginalBathCardDto,
  CncTelegramOriginalBoardResponseDto,
  CncTelegramOriginalPacketDto,
  CncTelegramMatchStatus,
  CncTelegramPacketDto,
  CncTelegramPacketCutSheetDto,
  CncTelegramPacketItemDto,
  CncTelegramStructuredIngestDto,
  CncTelegramTodayColumnDto,
  CncTelegramTodayResponseDto,
  CncTelegramToolDto,
  CreateCncMdfCardResponseDto,
} from '../dto/cnc-telegram.dto';

const SOURCE = 'backend-cnc-telegram-command';
const COMMAND_NAME = 'cnc.telegram_packet.ingest';
const MANUAL_SVG_SOURCE = 'backend-manual-svg-upload-command';
const MANUAL_SVG_COMMAND_NAME = 'cnc.manual_svg_upload';
const MANUAL_SVG_CHAT_ID = 'erp-manual-svg-upload';
const MANUAL_SVG_EVENT = 'cnc.manual_svg_upload.created';
const MANUAL_SVG_COMPLETED_EVENT = 'cnc.manual_svg_upload.mdf_card_created';
const MANUAL_SVG_PRESET_COMMAND_NAME = 'cnc.manual_svg_comment_preset.create';
const MANUAL_SVG_PRESET_CREATE_EVENT = 'cnc.manual_svg_comment_preset.created';
const MDF_CARD_COMMAND_NAME = 'cnc.mdf_card.create';
const MDF_CARD_CREATED_EVENT = 'cnc.mdf_card.created';
const MDF_CARD_SOURCE = 'backend-cut-mdf-card-command';
const IGNORED_ANALYSIS_WARNINGS = new Set([
  'RapidOCR found text, but no detail rows with order and size',
]);

interface PacketJoinedRow extends QueryResultRow {
  packet_id: string;
  external_packet_key: string;
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
  svg_cut_result_id: string | number | null;
  svg_cut_result_no: string | number | null;
  svg_cut_import_status: 'none' | 'skipped' | 'needs_review' | 'imported' | null;
  svg_cut_import_note: string | null;
  svg_cut_sheets_json: unknown;
  updated_at: string | Date;
  mdf_board_hidden_at: string | Date | null;
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
}

interface PacketReplayRow extends QueryResultRow {
  packet_id: string;
  source_version: string | number;
  payload_hash: string;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  response_json: unknown;
  status: 'processing' | 'completed' | 'failed';
  command_name?: string;
  actor_user_id?: string | number;
  entity_type?: string;
  entity_id?: string;
}

interface CurrentDateRow extends QueryResultRow {
  workday: string | Date;
}

interface OriginalDateRangeRow extends QueryResultRow {
  date_from: string | Date;
  date_to: string | Date;
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
  result_no: string | number;
  revision_no: string | number;
  result_created_at: string | Date;
  cut_job_name: string | null;
  forced: boolean;
  order_id: string | number;
  order_detail_id: string | number;
  order_name: string | null;
  detail_number: string | number | null;
  width_mm: string | number | null;
  height_mm: string | number | null;
  completed_quantity: string | number | null;
  cut_group_id: string | number;
  variant: 'auto' | 'manual';
  sheet_index: string | number;
  sheet_ordinal: string | number;
  sheet_width_mm: string | number | null;
  sheet_height_mm: string | number | null;
  current_cut_result_id?: string | number | null;
  current_result_archived_at?: string | Date | null;
  job_status?: string | null;
  current_ready?: boolean | null;
}

interface MdfCardCutResultItemRow extends QueryResultRow {
  order_id: string | number;
  order_detail_id: string | number;
  order_name: string;
  detail_number: string | number | null;
  width_mm: string | number | null;
  height_mm: string | number | null;
  quantity: string | number;
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

interface DetailMatch {
  orderKey: string;
  orderId: number;
  detailId: number;
  detailNumber: number | null;
  width: number | null;
  height: number | null;
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
      packetSelectSql("p.workday BETWEEN $1::date AND $2::date AND p.mdf_board_hidden_at IS NULL AND p.mdf_board_card_kind = 'machine_file'"),
      [workdayFrom, workdayTo],
    );
    const packets = mapPacketRows(rows.rows);
    const baths = await loadBathCards(this.database, workdayFrom, workdayTo);
    return {
      workday: workdayTo,
      generatedAt: new Date().toISOString(),
      columns: buildTodayColumns(packets, baths),
    };
  }

  async listOriginalBoard(
    _command: ListCncTelegramOriginalBoardCommand,
  ): Promise<CncTelegramOriginalBoardResponseDto> {
    const rangeResult = await this.database.query<OriginalDateRangeRow>(`
      SELECT
        (CURRENT_DATE - INTERVAL '2 months')::date::text AS date_from,
        CURRENT_DATE::text AS date_to
    `);
    const range = rangeResult.rows[0];
    if (!range?.date_from || !range.date_to) {
      throw new ApiError(500, 'CNC_ORIGINAL_RANGE_UNAVAILABLE', 'Original MDF board date range is unavailable');
    }
    const dateFrom = toDateOnly(range.date_from);
    const dateTo = toDateOnly(range.date_to);
    const packetRows = await this.database.query<PacketJoinedRow>(
      packetSelectSql(
        `COALESCE(p.source_created_at, p.created_at) >= $1::date
         AND COALESCE(p.source_created_at, p.created_at) < ($2::date + INTERVAL '1 day')
         AND p.mdf_board_card_kind = 'machine_file'`,
        { coalesceSourceCreatedAt: true },
      ),
      [dateFrom, dateTo],
    );
    const packets = mapOriginalPackets(packetRows.rows);
    const baths = await loadOriginalBathCards(this.database, dateFrom, dateTo);
    return {
      dateFrom,
      dateTo,
      generatedAt: new Date().toISOString(),
      packets,
      baths,
    };
  }

  async ingest(command: IngestCncTelegramPacketCommand): Promise<CncTelegramIngestResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = command.requestId || 'cnc-telegram-ingest';
      const payloadHash = hashPayload(command.dto);
      const idempotency = await reconcileIdempotency(tx, {
        dto: command.dto,
        currentUserId: command.currentUser.id,
        payloadHash,
      });
      if (idempotency.completedResponse) return idempotency.completedResponse;

      const replay = await tx.query<PacketReplayRow>(
        `
        SELECT packet_id, source_version, payload_hash
        FROM cnc_telegram_packets
        WHERE external_packet_key = $1
        FOR UPDATE
        `,
        [command.dto.externalPacketKey],
      );
      const existing = replay.rows[0] ?? null;

      if (existing && command.dto.source.version < Number(existing.source_version)) {
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
        command.dto.source.version === Number(existing.source_version) &&
        existing.payload_hash !== payloadHash
      ) {
        await failIdempotency(tx, command.dto.idempotencyKey);
        throw new ApiError(
          409,
          'SOURCE_VERSION_CONFLICT',
          'Telegram source version already exists with different parsed payload',
          {
            externalPacketKey: command.dto.externalPacketKey,
            sourceVersion: command.dto.source.version,
          },
        );
      }

      if (
        existing &&
        command.dto.source.version === Number(existing.source_version) &&
        existing.payload_hash === payloadHash
      ) {
        const matchedDto = await resolveItemMatches(tx, command.dto);
        const resolvedDto = aggregateMatchedItems(matchedDto);
        await ensureStoredCutLayout(tx, existing.packet_id, command.dto.cutLayout ?? null);
        await syncSvgCutImport(tx, existing.packet_id, resolvedDto, matchedDto, command.currentUser.id);
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

      const matchedDto = await resolveItemMatches(tx, command.dto);
      const resolvedDto = aggregateMatchedItems(matchedDto);
      const resolvedCommand = resolvedDto === command.dto ? command : { ...command, dto: resolvedDto };
      await assertMatchedDetailsBelongToOrders(tx, resolvedDto);

      const packetId = existing?.packet_id ?? await insertPacket(tx, resolvedCommand, payloadHash);
      if (existing) {
        await updatePacket(tx, packetId, resolvedCommand, payloadHash);
      }
      await replaceItems(tx, packetId, resolvedDto);
      await syncSvgCutImport(tx, packetId, resolvedDto, matchedDto, command.currentUser.id);

      const packet = await loadPacket(tx, packetId);
      const auditId = await writeIngestAudit(tx, {
        command: resolvedCommand,
        packet,
        requestId,
        previousSourceVersion: existing ? Number(existing.source_version) : null,
      });
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
      const { idempotencyKey: _manualDtoIdempotencyKey, ...manualPacketPayload } = dto;
      const payloadHash = hashPayload({
        idempotencyKey: dto.idempotencyKey,
        manualUpload: {
          selectedOrderIds: command.dto.selectedOrderIds,
          createMdfMachineFileCard: command.dto.createMdfMachineFileCard,
          svgContentHash: command.dto.svgContentHash.toLowerCase(),
        },
        packet: manualPacketPayload,
      });
      const idempotency = await reconcileIdempotency(tx, {
        dto,
        currentUserId: command.currentUser.id,
        payloadHash,
        commandName: MANUAL_SVG_COMMAND_NAME,
        entityType: 'cnc_manual_svg_upload',
      });
      if (idempotency.completedResponse) return manualSvgResponse(idempotency.completedResponse, command.dto.createMdfMachineFileCard);

      const replay = await tx.query<PacketReplayRow>(
        `
        SELECT packet_id, source_version, payload_hash
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
        }, command.dto.createMdfMachineFileCard);
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
        const matchedDto = await resolveItemMatches(tx, dto, { orderIds: command.dto.selectedOrderIds, tolerantSizeMm: 8 });
        await assertManualSvgOrderScope(tx, command.dto.selectedOrderIds, matchedDto);
        const resolvedDto = aggregateMatchedItems(matchedDto);
        await ensureStoredCutLayout(tx, existing.packet_id, dto.cutLayout ?? null);
        await syncSvgCutImport(tx, existing.packet_id, resolvedDto, matchedDto, command.currentUser.id);
        const packet = await loadPacket(tx, existing.packet_id);
        const response = manualSvgResponse({
          packet,
          requestId,
          applied: false,
          ignoredStaleSourceVersion: false,
        }, command.dto.createMdfMachineFileCard);
        await completeIdempotency(tx, dto.idempotencyKey, response);
        return response;
      }

      const matchedDto = await resolveItemMatches(tx, dto, { orderIds: command.dto.selectedOrderIds, tolerantSizeMm: 8 });
      await assertManualSvgOrderScope(tx, command.dto.selectedOrderIds, matchedDto);
      const resolvedDto = aggregateMatchedItems(matchedDto);
      await assertMatchedDetailsBelongToOrders(tx, resolvedDto);
      const resolvedCommand: IngestCncTelegramPacketCommand = {
        currentUser: command.currentUser,
        dto: resolvedDto,
        requestId,
      };

      const packetId = await insertPacket(tx, resolvedCommand, payloadHash);
      await replaceItems(tx, packetId, resolvedDto);
      await syncSvgCutImport(tx, packetId, resolvedDto, matchedDto, command.currentUser.id);

      const packet = await loadPacket(tx, packetId);
      const auditId = await writeManualSvgUploadAudit(tx, {
        command,
        packet,
        requestId,
        externalPacketKey: dto.externalPacketKey,
      });
      await enqueueManualSvgEvents(tx, {
        command,
        packet,
        requestId,
        auditId,
        externalPacketKey: dto.externalPacketKey,
      });

      const response = manualSvgResponse({
        packet,
        requestId,
        auditId,
        applied: true,
        ignoredStaleSourceVersion: false,
      }, command.dto.createMdfMachineFileCard);
      await completeIdempotency(tx, dto.idempotencyKey, response);
      return response;
    });
  }

  async createMdfCard(command: CreateCncMdfCardCommand): Promise<CreateCncMdfCardResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const requestId = command.requestId || 'cnc-mdf-card-create';
      const jobResult = await tx.query<{
        name: string;
        status: string;
        current_cut_result_id: string | number | null;
        current_result_no: string | number | null;
        layout_mode: string | null;
      }>(
        `
        SELECT
          j.name,
          j.status,
          j.current_cut_result_id,
          result.result_no AS current_result_no,
          COALESCE(profile.params ->> 'layout_mode', j.params ->> 'layout_mode') AS layout_mode
        FROM cut_job j
        LEFT JOIN cut_result result ON result.cut_result_id = j.current_cut_result_id
        LEFT JOIN cut_param_profiles profile ON profile.cut_param_profile_id = j.param_profile_id
        WHERE j.cut_job_id = $1
        FOR UPDATE OF j
        `,
        [command.cutJobId],
      );
      const job = jobResult.rows[0];
      if (!job) {
        throw new ApiError(404, 'CUT_JOB_NOT_FOUND', 'Задание на раскрой не найдено', {
          cutJobId: command.cutJobId,
        });
      }
      if (job.status === 'archived') {
        throw new ApiError(409, 'CUT_JOB_ARCHIVED', 'Для архивного раскроя нельзя создать карточку МДФ-доски', {
          cutJobId: command.cutJobId,
        });
      }
      const cutResultId = toPositiveInteger(job.current_cut_result_id);
      const resultNo = toPositiveInteger(job.current_result_no);
      if (cutResultId === null || resultNo === null) {
        throw new ApiError(422, 'CUT_JOB_CURRENT_RESULT_REQUIRED', 'Сначала рассчитайте раскрой', {
          cutJobId: command.cutJobId,
        });
      }
      const cardKind: CreateCncMdfCardResponseDto['cardKind'] =
        job.layout_mode === 'vacuum_table' ? 'bath' : 'machine_file';
      const storageKind = cardKind === 'bath' ? 'bath_seed' : 'machine_file';
      const requestHash = sha256Json({
        actorUserId: command.currentUser.id,
        cutJobId: command.cutJobId,
        cutResultId,
        cardKind,
      });
      const idempotency = await reconcileMdfCardIdempotency(tx, {
        idempotencyKey: command.idempotencyKey,
        currentUserId: command.currentUser.id,
        requestHash,
        entityId: String(command.cutJobId),
      });
      if (idempotency.completedResponse) {
        if (
          idempotency.completedResponse.cutJobId !== command.cutJobId ||
          idempotency.completedResponse.cutResultId !== cutResultId ||
          idempotency.completedResponse.cardKind !== cardKind
        ) {
          throw new ApiError(409, 'MDF_CARD_CURRENT_RESULT_CHANGED', 'Текущий результат раскроя изменился; повторите создание', {
            cutJobId: command.cutJobId,
            expectedCutResultId: idempotency.completedResponse.cutResultId,
            currentCutResultId: cutResultId,
          });
        }
        return idempotency.completedResponse;
      }

      const externalPacketKey = `erp-cut-mdf-card:${storageKind}:${command.cutJobId}:${cutResultId}`;
      const existing = await tx.query<{ packet_id: string; workday: string | Date }>(
        `SELECT packet_id::text AS packet_id, workday
         FROM cnc_telegram_packets
         WHERE external_packet_key = $1
         FOR UPDATE`,
        [externalPacketKey],
      );
      const existingPacket = existing.rows[0];
      if (existingPacket) {
        const response = mdfCardResponse({
          cutJobId: command.cutJobId,
          cutResultId,
          cardKind,
          packetId: existingPacket.packet_id,
          workday: existingPacket.workday,
          created: false,
        });
        await completeMdfCardIdempotency(tx, command.idempotencyKey, response);
        return response;
      }

      const itemResult = await tx.query<MdfCardCutResultItemRow>(
        `
        SELECT
          placement.order_id,
          placement.order_detail_id,
          COALESCE(NULLIF(trim(o.order_name), ''), placement.order_id::text) AS order_name,
          od.detail_number,
          COALESCE(od.width, placement.detail_width_mm) AS width_mm,
          COALESCE(od.height, placement.detail_height_mm) AS height_mm,
          COUNT(*)::integer AS quantity
        FROM cut_result_placement placement
        JOIN cut_result_sheet_map sheet
          ON sheet.cut_result_sheet_map_id = placement.cut_result_sheet_map_id
         AND sheet.is_effective = true
        JOIN orders o ON o.order_id = placement.order_id AND o.delete_flag = false
        JOIN order_details od ON od.detail_id = placement.order_detail_id AND od.delete_flag = false
        WHERE placement.cut_result_id = $1
          AND placement.order_id IS NOT NULL
          AND placement.order_detail_id IS NOT NULL
        GROUP BY
          placement.order_id,
          placement.order_detail_id,
          o.order_name,
          od.detail_number,
          od.width,
          od.height,
          placement.detail_width_mm,
          placement.detail_height_mm
        ORDER BY placement.order_id, od.detail_number, placement.order_detail_id
        `,
        [cutResultId],
      );
      if (itemResult.rows.length === 0) {
        throw new ApiError(422, 'CUT_RESULT_HAS_NO_MDF_CARD_ITEMS', 'В текущем результате нет активных деталей для карточки', {
          cutJobId: command.cutJobId,
          cutResultId,
        });
      }

      const dto: CncTelegramStructuredIngestDto = {
        idempotencyKey: command.idempotencyKey,
        externalPacketKey,
        source: { chatId: 'erp-cut-mdf-card', version: 1 },
        machine: 'ERP',
        programName: job.name,
        materialName: 'МДФ',
        parseStatus: 'parsed',
        completionStatus: 'pending',
        thumbsUp: false,
        comments: [],
        tools: [],
        parserVersion: 'erp-cut-mdf-card-v1',
        items: itemResult.rows.map((row) => ({
          sourceItemKey: `${toNumber(row.order_id)}:${toNumber(row.order_detail_id)}`,
          orderName: row.order_name,
          detailNumber: toNullableNumber(row.detail_number),
          widthMm: toNullableNumber(row.width_mm),
          heightMm: toNullableNumber(row.height_mm),
          quantity: Math.max(1, toNumber(row.quantity)),
          source: 'manual',
          confidence: 1,
          matchOrderId: toNumber(row.order_id),
          matchDetailId: toNumber(row.order_detail_id),
          matchStatus: 'matched',
          reviewNote: null,
        })),
      };
      const packetCommand: IngestCncTelegramPacketCommand = {
        currentUser: command.currentUser,
        dto,
        requestId,
      };
      const packetId = await insertPacket(tx, packetCommand, requestHash);
      await replaceItems(tx, packetId, dto);
      await tx.query(
        `UPDATE cnc_telegram_packets
         SET svg_cut_job_id = $2,
             svg_cut_result_id = $3,
             svg_cut_import_status = 'imported',
             svg_cut_import_note = 'forced_mdf_board_card',
             mdf_board_card_kind = $4,
             updated_at = now()
         WHERE packet_id = $1::uuid`,
        [packetId, command.cutJobId, cutResultId, storageKind],
      );
      const packet = await loadPacket(tx, packetId);
      const response = mdfCardResponse({
        cutJobId: command.cutJobId,
        cutResultId,
        cardKind,
        packetId,
        workday: packet.workday,
        created: true,
      });
      const relatedEntities = [
        { entityType: 'cut_job', entityId: command.cutJobId },
        { entityType: 'cut_result', entityId: cutResultId },
        ...itemResult.rows.flatMap((row) => [
          { entityType: 'order', entityId: toNumber(row.order_id) },
          { entityType: 'order_detail', entityId: toNumber(row.order_detail_id) },
        ]),
      ];
      const auditId = await auditService.record(tx, {
        event: MDF_CARD_CREATED_EVENT,
        entityType: 'cnc_telegram_packet',
        entityId: packetId,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username ?? null,
        actorRole: command.currentUser.role ?? null,
        requestId,
        source: MDF_CARD_SOURCE,
        before: null,
        after: { ...response },
        diff: { created: true, cardKind },
        metadata: {
          cutJobId: command.cutJobId,
          cutResultId,
          resultNo,
          cardKind,
          packetId,
          itemCount: itemResult.rows.length,
        },
        relatedEntities,
      });
      await enqueueOutbox(tx, {
        eventType: MDF_CARD_CREATED_EVENT,
        aggregateType: 'cut_job',
        aggregateId: String(command.cutJobId),
        idempotencyKey: `${MDF_CARD_CREATED_EVENT}:${command.cutJobId}:${cutResultId}:${cardKind}`,
        payload: {
          ...response,
          actorUserId: command.currentUser.id,
          requestId,
          auditId,
          packetId,
        },
      });
      await completeMdfCardIdempotency(tx, command.idempotencyKey, response);
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
      const idem = await reconcilePresetIdempotency(tx, {
        idempotencyKey: command.idempotencyKey,
        currentUserId: command.currentUser.id,
        entityId: input.commentText.toLowerCase(),
        requestHash,
      });
      if (idem.completedResponse) return idem.completedResponse;
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
        after: { ...preset },
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
      await completePresetIdempotency(tx, command.idempotencyKey, preset);
      return preset;
    });
  }

  async recordIngestDenied(command: RecordCncTelegramDeniedAuditCommand): Promise<void> {
    const entityType = command.event === 'cnc.mdf_card.create_denied'
      ? 'cut_job'
      : command.event === 'cnc.manual_svg_comment_preset.create_denied'
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
      source: SOURCE,
      reason: command.reason,
      requiredPermissions: command.requiredPermissions,
      metadata: {
        externalPacketKey: command.externalPacketKey ?? null,
      },
    });
  }
}

function buildManualSvgStructuredDto(
  dto: ManualSvgUploadCommand['dto'],
): CncTelegramStructuredIngestDto {
  const completionStatus = dto.createMdfMachineFileCard ? 'completed' : 'pending';
  const externalPacketKey = manualSvgExternalPacketKey(dto);
  return {
    idempotencyKey: dto.idempotencyKey,
    externalPacketKey,
    source: {
      chatId: MANUAL_SVG_CHAT_ID,
      version: 1,
    },
    workday: dto.workday,
    machine: normalizeOptional(dto.machine) ?? 'manual-svg-upload',
    programName: normalizeOptional(dto.programName) ?? `SVG ${dto.svgContentHash.slice(0, 12)}`,
    materialName: normalizeOptional(dto.materialName) ?? 'МДФ 16мм',
    parseStatus: 'parsed',
    completionStatus,
    thumbsUp: dto.createMdfMachineFileCard,
    rework: dto.rework === true,
    comments: dto.comments ?? [],
    tools: dto.tools ?? [],
    ocrEngine: null,
    parserVersion: normalizeOptional(dto.parserVersion) ?? 'erp-manual-svg-upload-v1',
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

function manualSvgExternalPacketKey(dto: ManualSvgUploadCommand['dto']): string {
  const identityHash = sha256Json({
    kind: 'erp-manual-svg-upload-v1',
    selectedOrderIds: [...dto.selectedOrderIds].sort((a, b) => a - b),
    createMdfMachineFileCard: dto.createMdfMachineFileCard,
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

async function assertManualSvgOrderScope(
  tx: TransactionClient,
  selectedOrderIds: number[],
  dto: CncTelegramStructuredIngestDto,
): Promise<void> {
  const allowed = new Set(selectedOrderIds);
  const orderRows = await tx.query<{ order_id: string | number }>(
    `
    SELECT order_id
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

  const unmatched = dto.items.filter((item) =>
    item.matchStatus !== 'matched' ||
    item.matchOrderId == null ||
    item.matchDetailId == null,
  );
  if (unmatched.length > 0) {
    throw new ApiError(
      422,
      'MANUAL_SVG_UNMATCHED_DETAILS',
      'All manual SVG details must match selected active order details',
      {
        items: unmatched.slice(0, 20).map((item) => ({
          orderName: item.orderName,
          detailNumber: item.detailNumber ?? null,
          widthMm: item.widthMm ?? null,
          heightMm: item.heightMm ?? null,
        })),
      },
    );
  }

  const outsideScope = dto.items.filter((item) =>
    item.matchOrderId != null && !allowed.has(item.matchOrderId),
  );
  if (outsideScope.length > 0) {
    throw new ApiError(
      422,
      'MANUAL_SVG_ORDER_SCOPE_MISMATCH',
      'SVG contains details outside the selected orders',
      {
        selectedOrderIds,
        items: outsideScope.slice(0, 20).map((item) => ({
          orderName: item.orderName,
          detailNumber: item.detailNumber ?? null,
          matchOrderId: item.matchOrderId ?? null,
          matchDetailId: item.matchDetailId ?? null,
        })),
      },
    );
  }
}

function manualSvgResponse(
  response: CncTelegramIngestResponseDto,
  createdMdfMachineFileCard: boolean,
): CncTelegramManualSvgUploadResponseDto {
  const cutJobId = response.packet.svgCutJobId ?? null;
  const cutResultId = response.packet.svgCutResultId ?? null;
  return {
    ...response,
    cutJobId,
    cutResultId,
    cutJobPath: cutJobId ? `/cut?cutJobId=${cutJobId}` : null,
    createdMdfMachineFileCard,
  };
}

async function writeManualSvgUploadAudit(
  tx: TransactionClient,
  input: {
    command: ManualSvgUploadCommand;
    packet: CncTelegramPacketDto;
    requestId: string;
    externalPacketKey: string;
  },
): Promise<string> {
  const matchedOrderIds = Array.from(
    new Set(input.packet.items.map((item) => item.matchOrderId).filter(isPositiveNumber)),
  );
  const relatedEntities = [
    ...matchedOrderIds.map((orderId) => ({ entityType: 'order', entityId: orderId })),
    ...(input.packet.svgCutJobId ? [{ entityType: 'cut_job', entityId: input.packet.svgCutJobId }] : []),
    ...(input.packet.svgCutResultId ? [{ entityType: 'cut_result', entityId: input.packet.svgCutResultId }] : []),
  ];
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
    metadata: {
      source: MANUAL_SVG_SOURCE,
      action: 'manual_svg_upload',
      externalPacketKey: input.externalPacketKey,
      svgContentHash: input.command.dto.svgContentHash.toLowerCase(),
      selectedOrderIds: input.command.dto.selectedOrderIds,
      createMdfMachineFileCard: input.command.dto.createMdfMachineFileCard,
      machine: input.packet.machine,
      programName: input.packet.programName,
      materialName: input.packet.materialName,
      rework: input.packet.rework,
      itemCount: input.packet.itemCount,
      itemQuantityTotal: input.packet.itemQuantityTotal,
      commentsCount: input.packet.comments.length,
      parserVersion: input.packet.parserVersion,
      svgCutJobId: input.packet.svgCutJobId ?? null,
      svgCutResultId: input.packet.svgCutResultId ?? null,
      svgCutImportStatus: input.packet.svgCutImportStatus ?? 'none',
      requestId: input.requestId,
    },
    relatedEntities,
  });
}

async function enqueueManualSvgEvents(
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
    idempotencyKey: `${input.command.dto.idempotencyKey}:manual-svg-upload-created`,
    payload: manualSvgOutboxPayload(input, MANUAL_SVG_EVENT),
  });
  if (input.packet.completionStatus === 'completed' || input.packet.thumbsUp) {
    await enqueueOutbox(tx, {
      eventType: MANUAL_SVG_COMPLETED_EVENT,
      aggregateType: 'cnc_telegram_packet',
      aggregateId: input.packet.packetId,
      idempotencyKey: `${input.command.dto.idempotencyKey}:manual-svg-upload-mdf-card-created`,
      payload: manualSvgOutboxPayload(input, MANUAL_SVG_COMPLETED_EVENT),
    });
  }
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
    cutJobId: input.packet.svgCutJobId ?? null,
    cutResultId: input.packet.svgCutResultId ?? null,
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

function packetSelectSql(
  whereSql: string,
  options: { coalesceSourceCreatedAt?: boolean } = {},
): string {
  return `
    SELECT
      p.packet_id,
      p.external_packet_key,
      p.source_chat_id,
      p.source_message_id,
      p.source_thread_id,
      p.source_version,
      ${options.coalesceSourceCreatedAt
        ? 'COALESCE(p.source_created_at, p.created_at) AS source_created_at'
        : 'p.source_created_at'},
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
            jsonb_agg(
              placement.order_detail_id
              ORDER BY placement.order_id, placement.order_detail_id, placement.instance
            ) AS detail_ids
          FROM cut_result_placement placement
          JOIN cut_result_sheet_map sheet
            ON sheet.cut_result_sheet_map_id = placement.cut_result_sheet_map_id
           AND sheet.is_effective = true
          WHERE placement.cut_result_id = p.svg_cut_result_id
            AND placement.order_detail_id IS NOT NULL
          GROUP BY sheet.cut_group_id, sheet.sheet_index, sheet.sheet_ordinal, sheet.variant
        ) sheet_summary
      ) AS svg_cut_sheets_json,
      p.updated_at,
      p.mdf_board_hidden_at,
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
      i.match_status,
      i.review_note
    FROM cnc_telegram_packets p
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
    LEFT JOIN cut_results svg_result ON svg_result.cut_result_id = p.svg_cut_result_id
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
  await replaceWholeOrderKeys(tx, packetId, dto.comments ?? []);
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
  await replaceWholeOrderKeys(tx, packetId, dto.comments ?? []);
}

async function replaceWholeOrderKeys(
  tx: TransactionClient,
  packetId: string,
  comments: readonly string[],
): Promise<void> {
  const orderKeys = Array.from(new Set(
    comments.flatMap((comment) => {
      if (!comment.toLocaleLowerCase('ru-RU').includes('весь')) return [];
      return Array.from(comment.matchAll(/(^|[^0-9])([0-9]{4,})(?=[^0-9]|$)/g), (match) => match[2]);
    }),
  ));
  await tx.query(
    `DELETE FROM cnc_telegram_packet_whole_order_keys WHERE packet_id = $1::uuid`,
    [packetId],
  );
  if (orderKeys.length === 0) return;
  await tx.query(
    `INSERT INTO cnc_telegram_packet_whole_order_keys (packet_id, order_key)
     SELECT $1::uuid, order_key
     FROM unnest($2::text[]) AS order_key
     ON CONFLICT (packet_id, order_key) DO NOTHING`,
    [packetId, orderKeys],
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
): Promise<void> {
  const state = await tx.query<{
    svg_cut_job_id: string | number | null;
    svg_cut_result_id: string | number | null;
    svg_cut_import_status: 'none' | 'skipped' | 'needs_review' | 'imported' | null;
  }>(
    `SELECT svg_cut_job_id, svg_cut_result_id, svg_cut_import_status
     FROM cnc_telegram_packets
     WHERE packet_id = $1::uuid
     FOR UPDATE`,
    [packetId],
  );
  const row = state.rows[0];
  if (!row) return;
  if (row.svg_cut_import_status === 'imported' && row.svg_cut_job_id !== null && row.svg_cut_result_id !== null) {
    return;
  }

  const layout = dto.cutLayout ?? matchSourceDto.cutLayout ?? null;
  if (!layout) {
    await setSvgCutImportState(tx, packetId, 'none', null, null, null);
    return;
  }
  if (layout.status !== 'valid') {
    await setSvgCutImportState(tx, packetId, 'skipped', cutLayoutReason(layout, 'SVG layout invalid'), null, null);
    return;
  }

  const plan = await buildSvgCutImportPlan(tx, dto, matchSourceDto, layout);
  if (!plan.ok) {
    await setSvgCutImportState(tx, packetId, 'needs_review', plan.reason, null, null);
    return;
  }

  const imported = await createSvgCutJob(tx, packetId, dto, layout, plan, actorUserId);
  await setSvgCutImportState(tx, packetId, 'imported', 'SVG layout imported into cut job', imported.cutJobId, imported.cutResultId);
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

type SvgCutImportPlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      sheetWidthMm: number;
      sheetHeightMm: number;
      sheetMaterialTypeId: number;
      filmId: number | null;
      details: SvgCutDetail[];
      placements: Array<CncTelegramCutLayoutItemDto & { orderId: number; orderDetailId: number }>;
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
): Promise<SvgCutImportPlan> {
  const sheet = layout.sheet;
  const items = layout.items ?? [];
  if (!sheet || !isPositiveFinite(sheet.widthMm) || !isPositiveFinite(sheet.heightMm)) {
    return { ok: false, reason: 'SVG layout has no valid sheet size' };
  }
  if (items.length === 0) {
    return { ok: false, reason: cutLayoutReason(layout, 'SVG layout has no placed details') };
  }

  const matchedItems = new Map<string, IngestItemInput>();
  for (const item of matchSourceDto.items) {
    const key = svgLayoutMatchKey(item.orderName, item.detailNumber ?? null, item.widthMm ?? null, item.heightMm ?? null);
    if (!key) continue;
    matchedItems.set(key, item);
  }

  const placements: Array<CncTelegramCutLayoutItemDto & { orderId: number; orderDetailId: number }> = [];
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
    placements.push({ ...item, orderId: match.matchOrderId, orderDetailId: match.matchDetailId });
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
    details,
    placements,
  };
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
  actorUserId: string,
): Promise<{ cutJobId: number; cutResultId: number }> {
  const params = SVG_REVERSE_IMPORT_PARAMS;
  const importSource = svgReverseImportSource(dto);
  const selectionCriteria = {
    source: importSource,
    externalPacketKey: dto.externalPacketKey,
    packetId,
    sourceVersion: dto.source.version,
    programName: dto.programName ?? null,
    machine: dto.machine ?? null,
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
    source: `${importSource}_reverse_import`,
    packetId,
    externalPacketKey: dto.externalPacketKey,
    sourceVersion: dto.source.version,
    requestHash,
  });
  const job = await tx.query<{ cut_job_id: string | number; created_at: Date | string }>(
    `
    INSERT INTO cut_job (
      name, status, source, selection_criteria, params, request_hash,
      pdf_prewarm_state, created_by, version, last_calc_params, last_calc_basis,
      sheet_material_type_id, combine_films, split_by_material
    )
    VALUES (
      $1, 'ready', 'api', $2::jsonb, $3::jsonb, $4,
      'pending', $5, 1, $3::jsonb, $6,
      $7, false, true
    )
    RETURNING cut_job_id, created_at
    `,
    [
      jobName,
      JSON.stringify(selectionCriteria),
      JSON.stringify(params),
      requestHash,
      toNullableNumber(actorUserId),
      requestHash,
      plan.sheetMaterialTypeId,
    ],
  );
  const cutJobId = toNumber(job.rows[0].cut_job_id);
  const cutJobCreatedAt = job.rows[0].created_at instanceof Date
    ? job.rows[0].created_at.toISOString()
    : String(job.rows[0].created_at);
  await tx.query(
    `INSERT INTO cut_result_command
       (cut_job_id, command_id, command_type, payload_hash, status, created_by)
     VALUES ($1, $2::uuid, 'manual_save', $3, 'in_progress', $4)`,
    [cutJobId, commandId, commandPayloadHash, toNullableNumber(actorUserId)],
  );
  const groupKey = `svg:m:${plan.sheetMaterialTypeId}:f:${plan.filmId ?? 'none'}`;
  const summary = buildSvgCutSummary(plan, importSource);
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
  const renderSnapshot = buildSvgRenderSnapshot(placements, itemByDetailId, dto.programName ?? dto.externalPacketKey);
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
  const totals = buildSvgCutTotals(plan);
  const snapshot: CutJobDto = {
    cutJobId,
    name: jobName,
    status: 'ready',
    source: 'api',
    createdAt: cutJobCreatedAt,
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
    materialNames: uniqueValues(plan.details.map((detail) => detail.materialName).filter((value): value is string => Boolean(value))),
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

function svgReverseImportSource(dto: CncTelegramStructuredIngestDto): 'cnc_telegram_svg' | 'manual_svg_upload' {
  return dto.source.chatId === MANUAL_SVG_CHAT_ID ? 'manual_svg_upload' : 'cnc_telegram_svg';
}

function buildSvgCutSummary(
  plan: Extract<SvgCutImportPlan, { ok: true }>,
  source: 'cnc_telegram_svg' | 'manual_svg_upload' = 'cnc_telegram_svg',
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
  const nextInstance = new Map<number, number>();
  const pieces = plan.placements.map((item) => {
    const instance = (nextInstance.get(item.orderDetailId) ?? 0) + 1;
    nextInstance.set(item.orderDetailId, instance);
    const jobItem = itemByDetailId.get(item.orderDetailId);
    return {
      item_id: freecutItemId(item.orderDetailId),
      instance,
      x_mm: round3(item.xMm),
      y_mm: round3(item.yMm),
      width_mm: round3(item.placedWidthMm),
      height_mm: round3(item.placedHeightMm),
      rotated: item.rotated === true,
      label: {
        orderId: item.orderId,
        detailNumber: jobItem?.detail?.detailNumber ?? item.detailNumber,
        widthMm: jobItem?.detail?.width ?? item.widthMm,
        heightMm: jobItem?.detail?.height ?? item.heightMm,
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

function buildSvgRenderSnapshot(
  placements: SheetPlacementsJson,
  itemByDetailId: ReadonlyMap<number, CutJobItemDto>,
  machineFile: string,
): CutSheetRenderSnapshotDto {
  const itemByItemId = new Map<string, CutJobItemDto>();
  for (const item of itemByDetailId.values()) itemByItemId.set(freecutItemId(item.orderDetailId), item);
  const quantities = new Map<string, number>();
  for (const piece of placements.pieces) quantities.set(piece.item_id, (quantities.get(piece.item_id) ?? 0) + 1);
  const fillForOrder = createOrderFillResolver([...itemByDetailId.values()].map((item) => item.orderId));
  const labelFor = (piece: FreecutPlacement) => {
    const item = itemByItemId.get(piece.item_id);
    const label = (piece as { label?: { orderId: number | null; detailNumber: number | null; widthMm: number | null; heightMm: number | null } }).label;
    return composePieceLabelLines({
      orderId: label?.orderId ?? item?.orderId ?? null,
      orderName: item?.orderName ?? null,
      detailId: item?.orderDetailId ?? null,
      detailNumber: label?.detailNumber ?? item?.detail?.detailNumber ?? null,
      widthMm: label?.widthMm ?? item?.detail?.width ?? null,
      heightMm: label?.heightMm ?? item?.detail?.height ?? null,
      itemId: piece.item_id,
      instance: piece.instance,
      qty: quantities.get(piece.item_id) ?? item?.qty ?? 1,
    });
  };
  const bathDetailInfoFor = (piece: FreecutPlacement) => {
    const detail = itemByItemId.get(piece.item_id)?.detail;
    return {
      edgeTypeName: detail?.edgeTypeName ?? null,
      millingTypeName: detail?.millingTypeName ?? null,
    };
  };
  const fillFor = (piece: FreecutPlacement) => {
    const orderId = itemByItemId.get(piece.item_id)?.orderId ?? null;
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
    pdfMeta: buildSvgPdfMeta(itemByDetailId, machineFile),
    pdfDetailRows: buildSvgPdfDetailRows(itemByDetailId, machineFile),
  };
}

function buildSvgPdfMeta(itemByDetailId: ReadonlyMap<number, CutJobItemDto>, machineFile: string): Record<string, unknown> {
  return {
    orders: uniqueValues([...itemByDetailId.values()].map((item) => item.orderName ?? String(item.orderId))),
    clients: [],
    dates: [],
    readyDates: [],
    materials: uniqueValues([...itemByDetailId.values()].map((item) => item.detail?.materialName).filter((value): value is string => Boolean(value))),
    thicknesses: [],
    films: uniqueValues([...itemByDetailId.values()].map((item) => item.detail?.filmName).filter((value): value is string => Boolean(value))),
    edgeTypes: uniqueValues([...itemByDetailId.values()].map((item) => item.detail?.edgeTypeName).filter((value): value is string => Boolean(value))),
    machineFiles: [machineFile],
  };
}

function buildSvgPdfDetailRows(itemByDetailId: ReadonlyMap<number, CutJobItemDto>, machineFile: string): Record<string, unknown>[] {
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

function buildSvgCutTotals(plan: Extract<SvgCutImportPlan, { ok: true }>): CutJobTotals {
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
  return {
    groups: snapshot.groups.length,
    items: snapshot.items.length,
    instances: snapshot.items.reduce((sum, item) => sum + item.qty, 0),
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

async function reconcileIdempotency(
  tx: TransactionClient,
  input: {
    dto: CncTelegramStructuredIngestDto;
    currentUserId: string;
    payloadHash: string;
    commandName?: string;
    entityType?: string;
  },
): Promise<{ completedResponse?: CncTelegramIngestResponseDto }> {
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
  if (inserted.rows[0]) return {};

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
    return { completedResponse: parseStoredResponse(row.response_json as CncTelegramIngestResponseDto | string) };
  }
  if (row.status === 'failed') {
    throw idempotencyError('IDEMPOTENCY_FAILED', input.dto.idempotencyKey);
  }
  throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.dto.idempotencyKey);
}

async function completeIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: CncTelegramIngestResponseDto,
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

function mdfCardResponse(input: {
  cutJobId: number;
  cutResultId: number;
  cardKind: CreateCncMdfCardResponseDto['cardKind'];
  packetId: string;
  workday: string | Date;
  created: boolean;
}): CreateCncMdfCardResponseDto {
  return {
    cutJobId: input.cutJobId,
    cutResultId: input.cutResultId,
    cardKind: input.cardKind,
    cardId: input.cardKind === 'bath' ? `cut-result:${input.cutResultId}` : input.packetId,
    workday: toDateOnly(input.workday),
    created: input.created,
  };
}

async function reconcileMdfCardIdempotency(
  tx: TransactionClient,
  input: {
    idempotencyKey: string;
    currentUserId: string;
    requestHash: string;
    entityId: string;
  },
): Promise<{ completedResponse?: CreateCncMdfCardResponseDto }> {
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, 'cut_job', $4, $5, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING request_hash, response_json, status
    `,
    [input.idempotencyKey, MDF_CARD_COMMAND_NAME, Number(input.currentUserId), input.entityId, input.requestHash],
  );
  if (inserted.rows[0]) return {};

  const existing = await tx.query<IdempotencyRow>(
    `SELECT request_hash, response_json, status, command_name, actor_user_id, entity_type, entity_id
     FROM command_idempotency_keys
     WHERE idempotency_key = $1
     FOR UPDATE`,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.idempotencyKey);
  if (
    row.command_name !== MDF_CARD_COMMAND_NAME ||
    String(row.actor_user_id) !== String(input.currentUserId) ||
    row.entity_type !== 'cut_job' ||
    String(row.entity_id) !== input.entityId
  ) {
    throw idempotencyError('IDEMPOTENCY_KEY_REUSED', input.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredMdfCardResponse(row.response_json) };
  }
  if (row.request_hash !== input.requestHash) {
    throw idempotencyError('IDEMPOTENCY_KEY_REUSED', input.idempotencyKey);
  }
  if (row.status === 'failed') throw idempotencyError('IDEMPOTENCY_FAILED', input.idempotencyKey);
  throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.idempotencyKey);
}

function parseStoredMdfCardResponse(value: unknown): CreateCncMdfCardResponseDto {
  const row = value as Partial<CreateCncMdfCardResponseDto>;
  const cutJobId = toPositiveInteger(row.cutJobId);
  const cutResultId = toPositiveInteger(row.cutResultId);
  const cardKind = row.cardKind === 'bath' ? 'bath' : row.cardKind === 'machine_file' ? 'machine_file' : null;
  if (cutJobId === null || cutResultId === null || cardKind === null || typeof row.cardId !== 'string' || typeof row.workday !== 'string') {
    throw new ApiError(500, 'IDEMPOTENCY_RESPONSE_INVALID', 'Stored MDF-card response is invalid');
  }
  return {
    cutJobId,
    cutResultId,
    cardKind,
    cardId: row.cardId,
    workday: row.workday,
    created: row.created === true,
  };
}

async function completeMdfCardIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: CreateCncMdfCardResponseDto,
): Promise<void> {
  await tx.query(
    `UPDATE command_idempotency_keys
     SET status = 'completed', response_json = $2::jsonb, completed_at = now()
     WHERE idempotency_key = $1`,
    [idempotencyKey, JSON.stringify(response)],
  );
}

async function reconcilePresetIdempotency(
  tx: TransactionClient,
  input: {
    idempotencyKey: string;
    currentUserId: string;
    requestHash: string;
    entityId: string;
  },
): Promise<{ completedResponse?: CncTelegramManualSvgCommentPresetDto }> {
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
  if (inserted.rows[0]) return {};

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
    return { completedResponse: parseStoredManualPresetResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw idempotencyError('IDEMPOTENCY_FAILED', input.idempotencyKey);
  }
  throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.idempotencyKey);
}

async function completePresetIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: CncTelegramManualSvgCommentPresetDto,
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
  database: DatabaseService,
  workdayFrom: string,
  workdayTo: string,
): Promise<CncTelegramBathCardDto[]> {
  const result = await database.query<BathJoinedRow>(
    `
    WITH
    ${cncMdfTargetDetailsCtes()},
    candidate_vacuum_results AS (
      SELECT
        r.cut_result_id,
        r.cut_job_id,
        r.result_no,
        r.revision_no,
        r.created_at AS result_created_at,
        COALESCE(r.snapshot_job ->> 'name', j.name, 'Раскрой ' || j.cut_job_id::text) AS cut_job_name,
        EXISTS (
          SELECT 1
          FROM cnc_telegram_packets forced_packet
          WHERE forced_packet.svg_cut_result_id = r.cut_result_id
            AND forced_packet.mdf_board_card_kind = 'bath_seed'
            AND forced_packet.mdf_board_hidden_at IS NULL
            AND forced_packet.workday BETWEEN $1::date AND $2::date
        ) AS forced,
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
      result.forced,
      placement.order_id,
      placement.order_detail_id,
      COALESCE(NULLIF(trim(o.order_name), ''), placement.order_id::text) AS order_name,
      od.detail_number,
      COALESCE(od.width, placement.detail_width_mm) AS width_mm,
      COALESCE(od.height, placement.detail_height_mm) AS height_mm,
      COALESCE(target.completed_quantity, 0) AS completed_quantity,
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

async function loadOriginalBathCards(
  database: DatabaseService,
  dateFrom: string,
  dateTo: string,
): Promise<CncTelegramOriginalBathCardDto[]> {
  const rowsResult = await database.query<BathJoinedRow>(
    originalBathSelectSql(),
    [dateFrom, dateTo],
  );
  return mapOriginalBathRows(rowsResult.rows);
}

function originalBathSelectSql(): string {
  const packetRangePredicate = `COALESCE(forced_packet.source_created_at, forced_packet.created_at) >= $1::date
            AND COALESCE(forced_packet.source_created_at, forced_packet.created_at) < ($2::date + INTERVAL '1 day')`;
  const forcedPacketExistsSql = `EXISTS (
          SELECT 1
          FROM cnc_telegram_packets forced_packet
          WHERE forced_packet.svg_cut_result_id = r.cut_result_id
            AND forced_packet.mdf_board_card_kind = 'bath_seed'
            AND ${packetRangePredicate}
        )`;
  return `
    WITH
    ${cncMdfTargetDetailsCtes('created-history', 'history_')},
    ${cncMdfTargetDetailsCtes('current-visible', 'current_')},
    candidate_vacuum_results AS (
      SELECT
        r.cut_result_id,
        r.cut_job_id,
        r.result_no,
        r.revision_no,
        r.created_at AS result_created_at,
        COALESCE(r.snapshot_job ->> 'name', j.name, 'Раскрой ' || j.cut_job_id::text) AS cut_job_name,
        ${forcedPacketExistsSql} AS forced,
        j.status AS job_status,
        j.current_cut_result_id,
        current_archive.archived_at AS current_result_archived_at,
        archive.archived_at AS selected_result_archived_at,
        CASE
          WHEN j.current_cut_result_id IS NULL THEN NULL
          ELSE
            EXISTS (
              SELECT 1
              FROM cut_result_placement current_placement
              JOIN cut_result_sheet_map current_sheet
                ON current_sheet.cut_result_sheet_map_id = current_placement.cut_result_sheet_map_id
               AND current_sheet.is_effective = true
              WHERE current_placement.cut_result_id = j.current_cut_result_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM cut_result_placement current_placement
              JOIN cut_result_sheet_map current_sheet
                ON current_sheet.cut_result_sheet_map_id = current_placement.cut_result_sheet_map_id
               AND current_sheet.is_effective = true
              LEFT JOIN current_target_details current_target
                ON current_target.order_id = current_placement.order_id
               AND current_target.detail_id = current_placement.order_detail_id
              WHERE current_placement.cut_result_id = j.current_cut_result_id
              GROUP BY current_placement.order_id, current_placement.order_detail_id
              HAVING COUNT(*) > COALESCE(MAX(current_target.completed_quantity), 0)
            )
        END AS current_ready
      FROM cut_job j
      JOIN cut_result r ON r.cut_job_id = j.cut_job_id
      LEFT JOIN cut_result current_result
        ON current_result.cut_result_id = j.current_cut_result_id
      LEFT JOIN cut_param_profiles profile
        ON profile.cut_param_profile_id = j.param_profile_id
      LEFT JOIN cut_result_archive_state archive
        ON archive.cut_job_id = r.cut_job_id
       AND archive.result_no = r.result_no
      LEFT JOIN cut_result_archive_state current_archive
        ON current_archive.cut_job_id = current_result.cut_job_id
       AND current_archive.result_no = current_result.result_no
      JOIN cut_result_label_map_projection projection
        ON projection.cut_result_id = r.cut_result_id
       AND projection.snapshot_digest = r.snapshot_digest
      WHERE r.snapshot_job IS NOT NULL
        AND r.created_at >= $1::date
        AND r.created_at < ($2::date + INTERVAL '1 day')
        AND COALESCE(profile.params ->> 'layout_mode', j.params ->> 'layout_mode') = 'vacuum_table'
        AND (
          ${forcedPacketExistsSql}
          OR EXISTS (
            SELECT 1
            FROM cut_result_placement placement
            JOIN cut_result_sheet_map sheet
              ON sheet.cut_result_sheet_map_id = placement.cut_result_sheet_map_id
             AND sheet.is_effective = true
            JOIN history_target_details target
              ON target.order_id = placement.order_id
             AND target.detail_id = placement.order_detail_id
            WHERE placement.cut_result_id = r.cut_result_id
          )
        )
    ),
    latest_vacuum_results AS (
      SELECT DISTINCT ON (candidate.cut_job_id)
        candidate.*
      FROM candidate_vacuum_results candidate
      ORDER BY
        candidate.cut_job_id,
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
      result.forced,
      result.job_status,
      result.current_cut_result_id,
      CASE
        WHEN result.current_cut_result_id IS NULL THEN result.selected_result_archived_at
        ELSE result.current_result_archived_at
      END AS current_result_archived_at,
      result.current_ready,
      placement.order_id,
      placement.order_detail_id,
      COALESCE(NULLIF(trim(o.order_name), ''), placement.order_id::text) AS order_name,
      od.detail_number,
      COALESCE(od.width, placement.detail_width_mm) AS width_mm,
      COALESCE(od.height, placement.detail_height_mm) AS height_mm,
      COALESCE(target.completed_quantity, 0) AS completed_quantity,
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
    LEFT JOIN history_target_details target
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
  `;
}

function buildTodayColumns(
  packets: CncTelegramPacketDto[],
  baths: CncTelegramBathCardDto[],
): CncTelegramTodayColumnDto[] {
  const definitions: Array<Pick<CncTelegramTodayColumnDto, 'key' | 'title'>> = [
    { key: 'parsed', title: 'Файлы на станке' },
    { key: 'completed', title: 'Выполнено' },
  ];
  const packetColumns = definitions.map((definition) => {
    const columnPackets = packets.filter((packet) => packetColumnKey(packet) === definition.key);
    return {
      ...definition,
      total: columnPackets.length,
      packets: columnPackets,
      baths: [],
    };
  });

  const pendingBaths = baths.filter((bath) => !bath.ready);
  const readyBaths = baths.filter((bath) => bath.ready);
  return [
    ...packetColumns,
    {
      key: 'baths',
      title: 'Ванны',
      total: pendingBaths.length,
      packets: [],
      baths: pendingBaths,
    },
    {
      key: 'baths_ready',
      title: 'Готовы к закатке',
      total: readyBaths.length,
      packets: [],
      baths: readyBaths,
    },
  ];
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
        cutNumber: `${cutJobId}-${resultNo}`,
        cutJobName: normalizeOptional(row.cut_job_name) ?? `Раскрой ${cutJobId}`,
        createdAt: toIso(row.result_created_at),
        forced: row.forced === true,
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

function mapOriginalBathRows(rows: BathJoinedRow[]): CncTelegramOriginalBathCardDto[] {
  const metadata = new Map<string, BathJoinedRow>();
  for (const row of rows) metadata.set(String(row.cut_result_id), row);

  return mapBathRows(rows)
    .map((bath) => {
      const row = metadata.get(String(bath.cutResultId));
      const archived = row?.job_status === 'archived' || Boolean(row?.current_result_archived_at);
      const currentCutResultId = toPositiveInteger(row?.current_cut_result_id ?? bath.cutResultId);
      const currentReady = row?.current_ready ?? bath.ready;
      return {
        ...bath,
        currentBoardVisibility: archived ? 'archived' as const : 'visible' as const,
        currentBoardColumn: archived ? null : currentReady ? 'baths_ready' as const : 'baths' as const,
        currentBoardCardId: archived || currentCutResultId === null
          ? null
          : `cut-result:${currentCutResultId}`,
      };
    })
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.bathCardId.localeCompare(right.bathCardId),
    );
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

function packetColumnKey(packet: CncTelegramPacketDto): 'parsed' | 'completed' {
  if (packet.completionStatus === 'completed' || packet.thumbsUp) return 'completed';
  return 'parsed';
}

function mapPacketRows(rows: PacketJoinedRow[]): CncTelegramPacketDto[] {
  const packets = new Map<string, CncTelegramPacketDto>();
  for (const row of rows) {
    let packet = packets.get(row.packet_id);
    if (!packet) {
      packet = {
        packetId: row.packet_id,
        externalPacketKey: row.external_packet_key,
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
        svgCutResultId: toNullableNumber(row.svg_cut_result_id),
        svgCutResultNo: toNullableNumber(row.svg_cut_result_no),
        svgCutImportStatus: row.svg_cut_import_status ?? 'none',
        svgCutImportNote: row.svg_cut_import_note,
        svgCutSheets: packetCutSheetsArray(row.svg_cut_sheets_json),
        itemCount: 0,
        itemQuantityTotal: 0,
        updatedAt: toIso(row.updated_at),
        items: [],
      };
      packets.set(row.packet_id, packet);
    }

    if (row.packet_item_id) {
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
        matchStatus: row.match_status ?? 'unmatched',
        reviewNote: row.review_note,
      };
      packet.items.push(item);
      packet.itemCount += 1;
      packet.itemQuantityTotal += item.quantity;
    }
  }
  return Array.from(packets.values());
}

function mapOriginalPackets(rows: PacketJoinedRow[]): CncTelegramOriginalPacketDto[] {
  const hiddenPacketIds = new Set(
    rows
      .filter((row) => row.mdf_board_hidden_at !== null && row.mdf_board_hidden_at !== undefined)
      .map((row) => row.packet_id),
  );
  return mapPacketRows(rows)
    .map((packet) => {
      const hidden = hiddenPacketIds.has(packet.packetId);
      return {
        ...packet,
        currentBoardVisibility: hidden ? 'hidden' as const : 'visible' as const,
        currentBoardColumn: hidden ? null : packetColumnKey(packet),
      };
    })
    .sort((left, right) =>
      (right.sourceCreatedAt ?? '').localeCompare(left.sourceCreatedAt ?? '') ||
      left.packetId.localeCompare(right.packetId),
    );
}

function packetAuditSnapshot(packet: CncTelegramPacketDto): Record<string, unknown> {
  return {
    packetId: packet.packetId,
    externalPacketKey: packet.externalPacketKey,
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
    svgCutJobId: packet.svgCutJobId ?? null,
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

function hashPayload(dto: unknown): string {
  const payload = dto && typeof dto === 'object' && !Array.isArray(dto)
    ? Object.fromEntries(
      Object.entries(dto as Record<string, unknown>).filter(([key]) => key !== 'idempotencyKey'),
    )
    : dto;
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

function parseStoredResponse(value: CncTelegramIngestResponseDto | string): CncTelegramIngestResponseDto {
  return typeof value === 'string'
    ? JSON.parse(value) as CncTelegramIngestResponseDto
    : value;
}

function parseStoredManualPresetResponse(value: unknown): CncTelegramManualSvgCommentPresetDto {
  return typeof value === 'string'
    ? JSON.parse(value) as CncTelegramManualSvgCommentPresetDto
    : value as CncTelegramManualSvgCommentPresetDto;
}

function idempotencyError(code: string, idempotencyKey: string): ApiError {
  return new ApiError(409, code, 'Idempotent CNC Telegram command cannot be processed', {
    idempotencyKey,
  });
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

async function currentDatabaseWorkday(database: DatabaseService): Promise<string> {
  const result = await database.query<CurrentDateRow>(
    'SELECT CURRENT_DATE::text AS workday',
  );
  const workday = result.rows[0]?.workday;
  if (!workday) {
    throw new ApiError(500, 'CNC_TELEGRAM_WORKDAY_UNAVAILABLE', 'Database workday is unavailable');
  }
  return toDateOnly(workday);
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequired(value: string): string {
  const normalized = normalizeOptional(value);
  if (!normalized) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Required text value is empty');
  }
  return normalized;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
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
  };
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  return Number(value);
}

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  return Number(value);
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

function isPositiveNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
