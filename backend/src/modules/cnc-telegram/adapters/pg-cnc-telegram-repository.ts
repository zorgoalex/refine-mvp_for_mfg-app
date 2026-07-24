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

interface PacketJoinedRow extends QueryResultRow {
  packet_id: string;
  external_packet_key: string;
  source_chat_id: string;
  source_message_id: string | number | null;
  source_thread_id: string | number | null;
  source_version: string | number;
  source_updated_at: string | Date | null;
  workday: string | Date;
  machine: string | null;
  program_name: string | null;
  material_name: string;
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
    return {
      workday,
      generatedAt: new Date().toISOString(),
      columns: buildTodayColumns(packets),
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

      await assertMatchedDetailsBelongToOrders(tx, command.dto);

      const packetId = existing?.packet_id ?? await insertPacket(tx, command, payloadHash);
      if (existing) {
        await updatePacket(tx, packetId, command, payloadHash);
      }
      await replaceItems(tx, packetId, command.dto);

      const packet = await loadPacket(tx, packetId);
      const auditId = await writeIngestAudit(tx, {
        command,
        packet,
        requestId,
        previousSourceVersion: existing ? Number(existing.source_version) : null,
      });
      await enqueuePacketEvents(tx, command, packet, requestId, auditId);

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
      p.source_updated_at,
      p.workday,
      p.machine,
      p.program_name,
      p.material_name,
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
      payload_hash,
      workday,
      machine,
      program_name,
      material_name,
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
      $1, $2, $3, $4, $5, $6::timestamptz, $7,
      COALESCE($8::date, CURRENT_DATE),
      $9, $10, COALESCE($11, 'МДФ 16мм'),
      $12, $13, $14, $15::timestamptz, $16,
      $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb,
      $21, COALESCE($22, 'cnc-telegram-structured-v1'),
      $23, $23
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
      payload_hash = $7,
      workday = COALESCE($8::date, workday),
      machine = $9,
      program_name = $10,
      material_name = COALESCE($11, 'МДФ 16мм'),
      parse_status = $12,
      completion_status = $13,
      thumbs_up = $14,
      completed_at = $15::timestamptz,
      rework = $16,
      comments_json = $17::jsonb,
      tools_json = $18::jsonb,
      doweling_links_json = $19::jsonb,
      analysis_warnings_json = $20::jsonb,
      ocr_engine = $21,
      parser_version = COALESCE($22, 'cnc-telegram-structured-v1'),
      updated_by = $23,
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
    dto.source.updatedAt ?? null,
    payloadHash,
    dto.workday ?? null,
    normalizeOptional(dto.machine),
    normalizeOptional(dto.programName),
    normalizeOptional(dto.materialName) ?? 'МДФ 16мм',
    dto.parseStatus ?? deriveParseStatus(dto),
    dto.completionStatus ?? (dto.thumbsUp ? 'completed' : 'pending'),
    dto.thumbsUp === true,
    dto.completedAt ?? (dto.thumbsUp ? dto.source.updatedAt ?? null : null),
    dto.rework === true,
    JSON.stringify(dto.comments ?? []),
    JSON.stringify(dto.tools ?? []),
    JSON.stringify(dto.dowelingLinks ?? []),
    JSON.stringify(dto.analysisWarnings ?? []),
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

  if (packetColumnKey(packet) === 'needs_review') {
    await enqueueOutbox(tx, {
      eventType: 'cnc.telegram_packet.needs_review',
      aggregateType: 'cnc_telegram_packet',
      aggregateId: packet.packetId,
      idempotencyKey: `${command.dto.idempotencyKey}:needs-review`,
      payload: packetOutboxPayload(packet, command, requestId, auditId, 'needs_review'),
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

function buildTodayColumns(packets: CncTelegramPacketDto[]): CncTelegramTodayColumnDto[] {
  const definitions: Array<Pick<CncTelegramTodayColumnDto, 'key' | 'title'>> = [
    { key: 'received', title: 'Получено' },
    { key: 'parsed', title: 'Распознано' },
    { key: 'needs_review', title: 'Нужна проверка' },
    { key: 'completed', title: 'Выполнено' },
  ];
  return definitions.map((definition) => {
    const columnPackets = packets.filter((packet) => packetColumnKey(packet) === definition.key);
    return {
      ...definition,
      total: columnPackets.length,
      packets: columnPackets,
    };
  });
}

function packetColumnKey(packet: CncTelegramPacketDto): CncTelegramTodayColumnDto['key'] {
  if (
    packet.parseStatus === 'needs_review' ||
    packet.analysisWarnings.length > 0 ||
    packet.items.some((item) => item.matchStatus === 'conflict' || item.matchStatus === 'needs_review')
  ) {
    return 'needs_review';
  }
  if (packet.completionStatus === 'completed' || packet.thumbsUp) return 'completed';
  if (packet.parseStatus === 'received') return 'received';
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
        sourceUpdatedAt: toNullableIso(row.source_updated_at),
        workday: toDateOnly(row.workday),
        machine: row.machine,
        programName: row.program_name,
        materialName: row.material_name,
        parseStatus: row.parse_status,
        completionStatus: row.completion_status,
        thumbsUp: row.thumbs_up === true,
        completedAt: toNullableIso(row.completed_at),
        rework: row.rework === true,
        comments: stringArray(row.comments_json),
        tools: toolArray(row.tools_json),
        dowelingLinks: dowelingArray(row.doweling_links_json),
        analysisWarnings: stringArray(row.analysis_warnings_json),
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
  if ((dto.analysisWarnings ?? []).length > 0) return 'needs_review';
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
