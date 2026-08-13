import { extname } from 'node:path';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CncTelegramMediaRestoreCompleteDto,
  CncTelegramMediaRestoreResponseDto,
  CncTelegramMediaRestoreTaskDto,
  CncTelegramOrderScreenshotDto,
} from '../dto/cnc-telegram-media.dto';

const SOURCE = 'backend-cnc-telegram-media';
const ORIGINAL_RETENTION_SQL = "interval '30 days'";
const RESTORE_LEASE_SQL = "interval '5 minutes'";

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
}

interface RestoreTaskRow extends QueryResultRow {
  restore_request_id: string;
  packet_id: string;
  source_chat_id: string;
  source_message_id: string | number;
  sheet_image_storage_key: string;
  attempt_count: string | number;
}

interface RestoreStateRow extends RestoreRow {
  source_chat_id: string;
  source_message_id: string | number;
  sheet_image_storage_key: string;
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

export class PgCncTelegramMediaRepository {
  constructor(private readonly database: DatabaseService) {}

  async listOrderScreenshots(orderId: number): Promise<CncTelegramOrderScreenshotDto[]> {
    const result = await this.database.query<ScreenshotRow>(screenshotSelectSql(''), [orderId]);
    return result.rows.map((row) => mapScreenshotRow(row, orderId));
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

  async claimRestores(allowedChatIds: readonly string[], limit: number): Promise<CncTelegramMediaRestoreTaskDto[]> {
    const result = await this.database.transaction(async (tx) => tx.query<RestoreTaskRow>(
      `WITH candidates AS (
         SELECT request.restore_request_id
         FROM cnc_telegram_media_restore_requests request
         JOIN cnc_telegram_packets packet ON packet.packet_id=request.packet_id
         WHERE packet.source_chat_id=ANY($1::text[])
           AND packet.source_message_id IS NOT NULL
           AND packet.sheet_image_storage_key IS NOT NULL
           AND request.attempt_count < 5
           AND (
             request.status='pending'
             OR (request.status='processing' AND request.claimed_at < now() - ${RESTORE_LEASE_SQL})
           )
         ORDER BY request.requested_at, request.restore_request_id
         FOR UPDATE OF request SKIP LOCKED
         LIMIT $2::integer
       ), claimed AS (
         UPDATE cnc_telegram_media_restore_requests request
         SET status='processing',
             attempt_count=request.attempt_count+1,
             claimed_at=now(),
             finished_at=NULL,
             available_until=NULL,
             last_error=NULL,
             updated_at=now()
         FROM candidates
         WHERE request.restore_request_id=candidates.restore_request_id
         RETURNING request.restore_request_id, request.packet_id, request.attempt_count
       )
       SELECT claimed.restore_request_id, claimed.packet_id, claimed.attempt_count,
              packet.source_chat_id, packet.source_message_id, packet.sheet_image_storage_key
       FROM claimed
       JOIN cnc_telegram_packets packet ON packet.packet_id=claimed.packet_id
       ORDER BY claimed.restore_request_id`,
      [[...allowedChatIds], limit],
    ));
    return result.rows.map((row) => ({
      requestId: row.restore_request_id,
      packetId: row.packet_id,
      sourceChatId: row.source_chat_id,
      sourceMessageId: Number(row.source_message_id),
      storageKey: row.sheet_image_storage_key,
      attempt: Number(row.attempt_count),
    }));
  }

  async completeRestore(input: {
    requestId: string;
    media: CncTelegramMediaRestoreCompleteDto;
    currentUser: CurrentUser;
    requestTraceId: string;
  }): Promise<CncTelegramMediaRestoreResponseDto> {
    return this.database.transaction(async (tx) => {
      const locked = await tx.query<RestoreStateRow>(
        `SELECT request.restore_request_id, request.packet_id, request.status,
                request.requested_at, request.available_until,
                packet.source_chat_id, packet.source_message_id, packet.sheet_image_storage_key
         FROM cnc_telegram_media_restore_requests request
         JOIN cnc_telegram_packets packet ON packet.packet_id=request.packet_id
         WHERE request.restore_request_id=$1::uuid
         FOR UPDATE OF request, packet`,
        [input.requestId],
      );
      const current = locked.rows[0];
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Запрос восстановления не найден');
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
  }): Promise<CncTelegramMediaRestoreResponseDto> {
    return this.database.transaction(async (tx) => {
      const locked = await tx.query<RestoreRow>(
        `SELECT restore_request_id, packet_id, status, requested_at, available_until
         FROM cnc_telegram_media_restore_requests
         WHERE restore_request_id=$1::uuid
         FOR UPDATE`,
        [input.requestId],
      );
      const current = locked.rows[0];
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Запрос восстановления не найден');
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
           p.svg_cut_job_id, svg_result.result_no AS svg_cut_result_no,
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

function mapRestoreResponse(row: RestoreRow): CncTelegramMediaRestoreResponseDto {
  return {
    requestId: row.restore_request_id,
    packetId: row.packet_id,
    status: row.status,
    requestedAt: toIso(row.requested_at),
    availableUntil: row.available_until ? toIso(row.available_until) : null,
  };
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

function toIso(value: string | Date | null): string {
  if (value === null) throw new Error('expected timestamp');
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
