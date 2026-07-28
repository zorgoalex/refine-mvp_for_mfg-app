import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type {
  CncTelegramDeniedAuditPort,
  CncTelegramRepositoryPort,
  IngestCncTelegramPacketCommand,
  ListCncTelegramTodayCommand,
  RecordCncTelegramDeniedAuditCommand,
} from '../application/cnc-telegram.types';
import type {
  CncTelegramBathCardDto,
  CncTelegramBathItemDto,
  CncTelegramBathSheetDto,
  CncTelegramDowelingLinkDto,
  CncTelegramIngestResponseDto,
  CncTelegramItemSource,
  CncTelegramMatchStatus,
  CncTelegramPacketDto,
  CncTelegramPacketItemDto,
  CncTelegramStructuredIngestDto,
  CncTelegramTodayColumnDto,
  CncTelegramTodayResponseDto,
  CncTelegramToolDto,
} from '../dto/cnc-telegram.dto';

const SOURCE = 'backend-cnc-telegram-command';
const COMMAND_NAME = 'cnc.telegram_packet.ingest';
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
  updated_at: string | Date;
  packet_item_id: string | null;
  source_item_key: string | null;
  order_name: string | null;
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
  response_json: CncTelegramIngestResponseDto | string | null;
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
  cut_group_id: string | number;
  variant: 'auto' | 'manual';
  sheet_index: string | number;
  sheet_ordinal: string | number;
  sheet_width_mm: string | number | null;
  sheet_height_mm: string | number | null;
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
    const workday = command.workday ?? await currentDatabaseWorkday(this.database);
    const rows = await this.database.query<PacketJoinedRow>(
      packetSelectSql('p.workday = $1::date'),
      [workday],
    );
    const packets = mapPacketRows(rows.rows);
    const baths = await loadBathCards(this.database, workday);
    return {
      workday,
      generatedAt: new Date().toISOString(),
      columns: buildTodayColumns(packets, baths),
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

      const resolvedDto = aggregateMatchedItems(await resolveItemMatches(tx, command.dto));
      const resolvedCommand = resolvedDto === command.dto ? command : { ...command, dto: resolvedDto };
      await assertMatchedDetailsBelongToOrders(tx, resolvedDto);

      const packetId = existing?.packet_id ?? await insertPacket(tx, resolvedCommand, payloadHash);
      if (existing) {
        await updatePacket(tx, packetId, resolvedCommand, payloadHash);
      }
      await replaceItems(tx, packetId, resolvedDto);

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
}

function packetSelectSql(whereSql: string): string {
  return `
    SELECT
      p.packet_id,
      p.external_packet_key,
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
      p.updated_at,
      i.packet_item_id,
      i.source_item_key,
      i.order_name,
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
      $27, $27
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
      updated_by = $27,
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
  return byId.size === 1 ? Array.from(byId.values())[0] ?? null : null;
}

function sameItemSize(item: IngestItemInput, detail: DetailMatch): boolean {
  const itemWidth = toNullableFiniteNumber(item.widthMm);
  const itemHeight = toNullableFiniteNumber(item.heightMm);
  if (itemWidth === null || itemHeight === null || detail.width === null || detail.height === null) {
    return false;
  }
  return (
    closeEnough(itemWidth, detail.width) && closeEnough(itemHeight, detail.height)
  ) || (
    closeEnough(itemWidth, detail.height) && closeEnough(itemHeight, detail.width)
  );
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
  },
): Promise<{ completedResponse?: CncTelegramIngestResponseDto }> {
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
    return { completedResponse: parseStoredResponse(row.response_json) };
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
  workday: string,
): Promise<CncTelegramBathCardDto[]> {
  const result = await database.query<BathJoinedRow>(
    `
    WITH packet_items AS (
      SELECT
        p.completion_status,
        p.thumbs_up,
        i.match_order_id,
        i.match_detail_id,
        lower(trim(i.order_name)) AS order_key,
        i.detail_number,
        i.width_mm,
        i.height_mm,
        i.quantity
      FROM cnc_telegram_packets p
      JOIN cnc_telegram_packet_items i ON i.packet_id = p.packet_id
      WHERE p.workday = $1::date
    ),
    matched_target_details AS (
      SELECT
        item.match_order_id::bigint AS order_id,
        item.match_detail_id::bigint AS detail_id,
        SUM(
          CASE
            WHEN item.completion_status = 'completed' OR item.thumbs_up = true
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
    fallback_target_details AS (
      SELECT
        order_key.order_id,
        od.detail_id::bigint AS detail_id,
        SUM(
          CASE
            WHEN item.completion_status = 'completed' OR item.thumbs_up = true
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
        AND (
          (
            item.detail_number IS NOT NULL
            AND od.detail_number = item.detail_number
            AND (
              item.width_mm IS NULL
              OR item.height_mm IS NULL
              OR (
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
          OR (
            item.detail_number IS NULL
            AND item.width_mm IS NOT NULL
            AND item.height_mm IS NOT NULL
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
        SUM(target.completed_quantity)::integer AS completed_quantity
      FROM (
        SELECT * FROM matched_target_details
        UNION ALL
        SELECT * FROM fallback_target_details
      ) target
      GROUP BY target.order_id, target.detail_id
    ),
    latest_vacuum_results AS (
      SELECT DISTINCT ON (j.cut_job_id)
        r.cut_result_id,
        r.cut_job_id,
        r.result_no,
        r.revision_no,
        r.created_at AS result_created_at,
        COALESCE(r.snapshot_job ->> 'name', j.name, 'Раскрой ' || j.cut_job_id::text) AS cut_job_name
      FROM cut_job j
      JOIN cut_result r ON r.cut_job_id = j.cut_job_id
      LEFT JOIN cut_param_profiles profile
        ON profile.cut_param_profile_id = j.param_profile_id
      JOIN cut_result_label_map_projection projection
        ON projection.cut_result_id = r.cut_result_id
       AND projection.snapshot_digest = r.snapshot_digest
      WHERE r.snapshot_job IS NOT NULL
        AND COALESCE(profile.params ->> 'layout_mode', j.params ->> 'layout_mode') = 'vacuum_table'
      ORDER BY
        j.cut_job_id,
        (j.current_cut_result_id = r.cut_result_id) DESC NULLS LAST,
        r.created_at DESC,
        r.result_no DESC,
        r.revision_no DESC,
        r.cut_result_id DESC
    ),
    candidate_results AS (
      SELECT latest.*
      FROM latest_vacuum_results latest
      WHERE EXISTS (
        SELECT 1
        FROM cut_result_placement placement
        JOIN cut_result_sheet_map sheet
          ON sheet.cut_result_sheet_map_id = placement.cut_result_sheet_map_id
         AND sheet.is_effective = true
        JOIN target_details target
          ON target.order_id = placement.order_id
         AND target.detail_id = placement.order_detail_id
        WHERE placement.cut_result_id = latest.cut_result_id
      )
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
      sheet.cut_group_id,
      sheet.variant,
      sheet.sheet_index,
      sheet.sheet_ordinal,
      sheet.sheet_width_mm,
      sheet.sheet_height_mm
    FROM candidate_results result
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
    [workday],
  );
  return mapBathRows(result.rows);
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
  const { idempotencyKey: _idempotencyKey, ...payload } = dto;
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
