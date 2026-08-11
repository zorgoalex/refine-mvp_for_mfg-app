import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import { freecutItemId, type FreecutPlacement, type SheetPlacementsJson } from '../../cut/application/cut-freecut-mapping';
import { formatCutNumber } from '../../cut/application/cut-numbering';
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
  ConfigureCncAutoCutStatusCommand,
  IngestCncTelegramPacketCommand,
  ListCncTelegramOrderCuttingSequencesCommand,
  ListCncTelegramTodayCommand,
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
  CncTelegramMatchStatus,
  CncTelegramOrderCuttingSequenceDto,
  CncTelegramOrderCuttingSequencesResponseDto,
  CncTelegramPacketDto,
  CncTelegramPacketCutSheetDto,
  CncTelegramPacketItemDto,
  CncTelegramStructuredIngestDto,
  CncTelegramTodayColumnDto,
  CncTelegramTodayResponseDto,
  CncTelegramToolDto,
} from '../dto/cnc-telegram.dto';
import {
  persistTelegramItemEvidence,
  projectTelegramLabelMap,
} from './cnc-telegram-label-map-projector';

const SOURCE = 'backend-cnc-telegram-command';
const COMMAND_NAME = 'cnc.telegram_packet.ingest';
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
    | CncAutoCutStatusConfigureResponseDto
    | string
    | null;
  status: 'processing' | 'completed' | 'failed';
}

interface CurrentDateRow extends QueryResultRow {
  workday: string | Date;
}

interface BathJoinedRow extends QueryResultRow {
  cut_result_id: string | number;
  cut_job_id: string | number;
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
  cut_group_id: string | number;
  variant: 'auto' | 'manual';
  sheet_index: string | number;
  sheet_ordinal: string | number;
  sheet_width_mm: string | number | null;
  sheet_height_mm: string | number | null;
}

interface BazisCutSetJoinedRow extends QueryResultRow {
  bazis_cut_set_id: string | number;
  name: string;
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
      packetSelectSql('p.workday BETWEEN $1::date AND $2::date'),
      [workdayFrom, workdayTo],
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
      const payloadHash = hashPayload(command.dto);
      await reconcileIdempotency(tx, {
        dto: command.dto,
        currentUserId: command.currentUser.id,
        payloadHash,
      });

      const replay = await tx.query<PacketReplayRow>(
        `
        SELECT packet_id, source_version, payload_hash, completion_status, thumbs_up
        FROM cnc_telegram_packets
        WHERE external_packet_key = $1
        FOR UPDATE
        `,
        [command.dto.externalPacketKey],
      );
      const existing = replay.rows[0] ?? null;

      if (existing && command.dto.source.version < Number(existing.source_version)) {
        await ensureCuttingSequenceNo(tx, existing.packet_id, command.dto, Number(command.currentUser.id));
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
        await assertMatchedDetailsBelongToOrders(tx, matchedDto);
        await persistTelegramItemEvidence(tx, {
          packetId: existing.packet_id,
          sourceVersion: command.dto.source.version,
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
        await ensureCuttingSequenceNo(tx, existing.packet_id, resolvedDto, Number(command.currentUser.id));
        await ensureStoredCutLayout(tx, existing.packet_id, command.dto.cutLayout ?? null);
        await syncSvgCutImport(tx, existing.packet_id, resolvedDto, matchedDto, command.currentUser.id);
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

      const matchedDto = await resolveItemMatches(tx, command.dto);
      const resolvedDto = aggregateMatchedItems(matchedDto);
      const resolvedCommand = resolvedDto === command.dto ? command : { ...command, dto: resolvedDto };
      await assertMatchedDetailsBelongToOrders(tx, matchedDto);

      const packetId = existing?.packet_id ?? await insertPacket(tx, resolvedCommand, payloadHash);
      if (existing) {
        await updatePacket(tx, packetId, resolvedCommand, payloadHash);
      }
      await persistTelegramItemEvidence(tx, {
        packetId,
        sourceVersion: command.dto.source.version,
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
      await ensureCuttingSequenceNo(tx, packetId, resolvedDto, Number(command.currentUser.id));
      await syncSvgCutImport(tx, packetId, resolvedDto, matchedDto, command.currentUser.id);
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
    await auditService.recordDenied(this.database, {
      event: command.event,
      entityType: 'cnc_telegram_packet',
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
  actorUserId: string,
): Promise<{ cutJobId: number; cutResultId: number }> {
  const params = SVG_REVERSE_IMPORT_PARAMS;
  const selectionCriteria = {
    source: 'cnc_telegram_svg',
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
    source: 'cnc_telegram_svg_reverse_import',
    packetId,
    externalPacketKey: dto.externalPacketKey,
    sourceVersion: dto.source.version,
    requestHash,
  });
  const job = await tx.query<{ cut_job_id: string | number; created_at: string | Date }>(
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
  const cutJobCreatedAt = toIso(job.rows[0].created_at);
  await tx.query(
    `INSERT INTO cut_result_command
       (cut_job_id, command_id, command_type, payload_hash, status, created_by)
     VALUES ($1, $2::uuid, 'manual_save', $3, 'in_progress', $4)`,
    [cutJobId, commandId, commandPayloadHash, toNullableNumber(actorUserId)],
  );
  const groupKey = `svg:m:${plan.sheetMaterialTypeId}:f:${plan.filmId ?? 'none'}`;
  const summary = buildSvgCutSummary(plan);
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

function buildSvgCutSummary(plan: Extract<SvgCutImportPlan, { ok: true }>): Record<string, unknown> {
  const sheetArea = plan.sheetWidthMm * plan.sheetHeightMm;
  const placedArea = plan.placements.reduce((sum, item) => sum + item.placedWidthMm * item.placedHeightMm, 0);
  const wastePercent = sheetArea > 0 ? Math.max(0, ((sheetArea - placedArea) / sheetArea) * 100) : 0;
  return {
    used_stock_count: 1,
    waste_percent: round2(wastePercent),
    engine_used: 'svg_reverse_import',
    source: 'cnc_telegram_svg',
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
      doweling: detail?.doweling ?? false,
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
      AND o.delete_flag = false
      AND od.delete_flag = false
    ORDER BY o.order_id, od.detail_number NULLS LAST, od.detail_id
    `,
    [orderKeys],
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
    const match = details ? resolveItemMatch(item, details) : null;
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

function resolveItemMatch(item: IngestItemInput, details: DetailMatch[]): DetailMatch | null {
  if (details.length === 0 || uniqueOrderId(details) === null) return null;

  if (item.detailNumber != null) {
    let candidates = details.filter((detail) => detail.detailNumber === item.detailNumber);
    candidates = preferSizeMatches(item, candidates);
    return uniqueDetail(candidates);
  }

  if (item.widthMm == null || item.heightMm == null) return null;
  return uniqueDetail(details.filter((detail) => sameItemSize(item, detail)));
}

function preferSizeMatches(item: IngestItemInput, details: DetailMatch[]): DetailMatch[] {
  if (item.widthMm == null || item.heightMm == null) return details;
  const detailsWithSize = details.filter((detail) => detail.width != null && detail.height != null);
  if (detailsWithSize.length === 0) return details;
  return detailsWithSize.filter((detail) => sameItemSize(item, detail));
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

function sameItemSize(item: IngestItemInput, detail: DetailMatch): boolean {
  const itemWidth = toNullableFiniteNumber(item.widthMm);
  const itemHeight = toNullableFiniteNumber(item.heightMm);
  if (itemWidth === null || itemHeight === null || detail.width === null || detail.height === null) {
    return false;
  }
  const matchesSize = item.source === 'ocr' ? closeEnoughSize : exactSize;
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
): boolean {
  return closeEnough(itemWidth, detailWidth) && closeEnough(itemHeight, detailHeight);
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 3;
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
  },
): Promise<void> {
  const requestHash = hashRequest({
    actorUserId: input.currentUserId,
    commandName: COMMAND_NAME,
    externalPacketKey: input.dto.externalPacketKey,
    sourceVersion: input.dto.source.version,
    payloadHash: input.payloadHash,
  });
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, 'cnc_telegram_packet', $4, $5, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING request_hash, response_json, status
    `,
    [
      input.dto.idempotencyKey,
      COMMAND_NAME,
      Number(input.currentUserId),
      input.dto.externalPacketKey,
      requestHash,
    ],
  );
  if (inserted.rows[0]) return;

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
    return;
  }
  if (row.status === 'failed') {
    throw idempotencyError('IDEMPOTENCY_FAILED', input.dto.idempotencyKey);
  }
  throw idempotencyError('IDEMPOTENCY_IN_PROGRESS', input.dto.idempotencyKey);
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
  response: CncTelegramIngestResponseDto | CncAutoCutStatusConfigureResponseDto,
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
  const packetColumns = definitions.map((definition) => {
    const columnPackets = packets.filter((packet) => packetColumnKey(packet) === definition.key);
    const columnBazisCutSets = definition.key === 'parsed' ? bazisCutSets : [];
    return {
      ...definition,
      total: columnPackets.length + columnBazisCutSets.length,
      packets: columnPackets,
      baths: [],
      bazisCutSets: columnBazisCutSets,
    };
  });

  const pendingBaths = baths.filter((bath) => !bath.ready);
  const readyBaths = baths.filter((bath) => bath.ready && !allItemsLaminatedOrLater(bath.items));
  const laminatedBaths = baths.filter((bath) => bath.ready && allItemsLaminatedOrLater(bath.items));
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
      total: laminatedPackets.length,
      packets: laminatedPackets,
      baths: [],
      bazisCutSets: [],
    },
    {
      key: 'baths_laminated',
      title: 'Закатаны/выданы',
      total: laminatedBaths.length,
      packets: [],
      baths: laminatedBaths,
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
    WITH target_bazis_cut_sets AS (
      SELECT cut_set.bazis_cut_set_id
      FROM bazis_cut_sets cut_set
      WHERE cut_set.created_at >= $1::date
        AND cut_set.created_at < ($2::date + INTERVAL '1 day')
    )
    SELECT
      cut_set.bazis_cut_set_id,
      cut_set.name,
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
      detail.quantity
    FROM target_bazis_cut_sets target
    JOIN bazis_cut_sets cut_set
      ON cut_set.bazis_cut_set_id = target.bazis_cut_set_id
    JOIN bazis_cut_set_details detail
      ON detail.bazis_cut_set_id = cut_set.bazis_cut_set_id
    LEFT JOIN order_details source_detail
      ON source_detail.detail_id = detail.source_order_detail_id
    LEFT JOIN orders source_order
      ON source_order.order_id = COALESCE(detail.source_order_id, source_detail.order_id)
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
        cutNumber: formatCutNumber(cutJobId, resultNo, true),
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
