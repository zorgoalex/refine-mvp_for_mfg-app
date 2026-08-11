import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import type { AuditRelatedEntity } from '../../../common/audit/audit-event.types';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import {
  evaluateMdfBoardColumnAutomation,
  type MdfBoardColumnAutomationInput,
} from '../../status-automation/application/status-automation-runtime';
import type {
  DeleteMdfBoardManualMoveCommand,
  ListMdfBoardManualMovesCommand,
  MdfBoardManualMoveRepositoryPort,
  UpsertMdfBoardManualMoveCommand,
} from '../application/mdf-board-manual-move.types';
import type {
  MdfBoardManualMoveDeleteResponseDto,
  MdfBoardManualMoveDto,
  MdfBoardManualMovesResponseDto,
  MdfBoardManualMoveUpsertResponseDto,
} from '../dto/mdf-board-manual-move.dto';

const SOURCE = 'backend-mdf-board-manual-move-command';

interface MdfBoardManualMoveRow extends QueryResultRow {
  card_kind: MdfBoardManualMoveDto['cardKind'];
  card_id: string;
  target_column: MdfBoardManualMoveDto['targetColumn'];
  version: string | number;
  created_at: string | Date;
  created_by_user_id: string | number | null;
  updated_at: string | Date;
  updated_by_user_id: string | number | null;
}

export class PgMdfBoardManualMoveRepository implements MdfBoardManualMoveRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  async list(_command: ListMdfBoardManualMovesCommand): Promise<MdfBoardManualMovesResponseDto> {
    const result = await this.database.query<MdfBoardManualMoveRow>(
      `
      SELECT
        card_kind,
        card_id,
        target_column,
        version,
        created_at,
        created_by_user_id,
        updated_at,
        updated_by_user_id
      FROM mdf_board_manual_moves
      ORDER BY updated_at DESC, move_id DESC
      `,
    );
    return {
      generatedAt: new Date().toISOString(),
      moves: result.rows.map(mapMoveRow),
    };
  }

  async upsert(command: UpsertMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveUpsertResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const current = await loadMoveForUpdate(tx, command.cardKind, command.cardId);
      if (current && current.targetColumn === command.targetColumn) {
        return {
          generatedAt: new Date().toISOString(),
          changed: false,
          move: current,
        };
      }

      const actorUserId = toNullableUserId(command.currentUser.id);
      const saved = current
        ? await updateMove(tx, command, actorUserId)
        : await insertMove(tx, command, actorUserId);
      const relatedOrderIds = await loadRelatedOrderIds(tx, command.cardKind, command.cardId);
      const auditId = await auditService.record(tx, {
        event: current ? 'mdf_board.manual_move.updated' : 'mdf_board.manual_move.created',
        entityType: 'mdf_board_manual_move',
        entityId: manualMoveEntityId(command.cardKind, command.cardId),
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId ?? 'mdf-board-manual-move',
        source: SOURCE,
        relatedOrderId: relatedOrderId(command.cardKind, command.cardId),
        statusField: 'target_column',
        statusCode: command.targetColumn,
        before: current ? auditShape(current) : null,
        after: auditShape(saved),
        diff: {
          targetColumn: {
            before: current?.targetColumn ?? null,
            after: saved.targetColumn,
          },
        },
        metadata: auditMetadata(command.cardKind, command.cardId, {
          operation: current ? 'update' : 'create',
          notificationEventEmitted: false,
          notificationEventDecision: 'polling_refresh_contract',
          statusAutomationEventType: statusAutomationEventTypeForTargetColumn(command.targetColumn),
          relatedOrderIds,
        }),
        relatedEntities: relatedEntities(command.cardKind, command.cardId, relatedOrderIds),
      });
      const eventType = statusAutomationEventTypeForTargetColumn(command.targetColumn);
      if (eventType !== null) {
        await evaluateMdfBoardColumnAutomation(tx, {
          eventType,
          orderIds: relatedOrderIds,
          actor: command.currentUser,
          requestId: command.requestId ?? 'mdf-board-manual-move',
          sourceIdempotencyKey: `mdf-board:manual:${command.cardKind}:${command.cardId}:version-${saved.version}:${command.targetColumn}`,
        });
      }
      return {
        generatedAt: new Date().toISOString(),
        changed: true,
        move: saved,
        auditId,
      };
    });
  }

  async delete(command: DeleteMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveDeleteResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const current = await loadMoveForUpdate(tx, command.cardKind, command.cardId);
      if (!current) {
        return {
          generatedAt: new Date().toISOString(),
          cardKind: command.cardKind,
          cardId: command.cardId,
          deleted: false,
        };
      }

      await tx.query(
        `
        DELETE FROM mdf_board_manual_moves
        WHERE card_kind = $1
          AND card_id = $2
        `,
        [command.cardKind, command.cardId],
      );
      const auditId = await auditService.record(tx, {
        event: 'mdf_board.manual_move.deleted',
        entityType: 'mdf_board_manual_move',
        entityId: manualMoveEntityId(command.cardKind, command.cardId),
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId ?? 'mdf-board-manual-move',
        source: SOURCE,
        relatedOrderId: relatedOrderId(command.cardKind, command.cardId),
        statusField: 'target_column',
        statusCode: null,
        before: auditShape(current),
        after: null,
        diff: {
          targetColumn: {
            before: current.targetColumn,
            after: null,
          },
        },
        metadata: auditMetadata(command.cardKind, command.cardId, {
          operation: 'delete',
          notificationEventEmitted: false,
          notificationEventDecision: 'polling_refresh_contract',
        }),
        relatedEntities: relatedEntities(command.cardKind, command.cardId),
      });
      return {
        generatedAt: new Date().toISOString(),
        cardKind: command.cardKind,
        cardId: command.cardId,
        deleted: true,
        auditId,
      };
    });
  }
}

async function loadMoveForUpdate(
  tx: TransactionClient,
  cardKind: MdfBoardManualMoveDto['cardKind'],
  cardId: string,
): Promise<MdfBoardManualMoveDto | null> {
  const result = await tx.query<MdfBoardManualMoveRow>(
    `
    SELECT
      card_kind,
      card_id,
      target_column,
      version,
      created_at,
      created_by_user_id,
      updated_at,
      updated_by_user_id
    FROM mdf_board_manual_moves
    WHERE card_kind = $1
      AND card_id = $2
    FOR UPDATE
    `,
    [cardKind, cardId],
  );
  return result.rows[0] ? mapMoveRow(result.rows[0]) : null;
}

async function insertMove(
  tx: TransactionClient,
  command: UpsertMdfBoardManualMoveCommand,
  actorUserId: number | null,
): Promise<MdfBoardManualMoveDto> {
  const result = await tx.query<MdfBoardManualMoveRow>(
    `
    INSERT INTO mdf_board_manual_moves (
      card_kind,
      card_id,
      target_column,
      created_by_user_id,
      updated_by_user_id
    )
    VALUES ($1, $2, $3, $4, $4)
    RETURNING
      card_kind,
      card_id,
      target_column,
      version,
      created_at,
      created_by_user_id,
      updated_at,
      updated_by_user_id
    `,
    [command.cardKind, command.cardId, command.targetColumn, actorUserId],
  );
  return mapMoveRow(result.rows[0]);
}

async function updateMove(
  tx: TransactionClient,
  command: UpsertMdfBoardManualMoveCommand,
  actorUserId: number | null,
): Promise<MdfBoardManualMoveDto> {
  const result = await tx.query<MdfBoardManualMoveRow>(
    `
    UPDATE mdf_board_manual_moves
    SET target_column = $3,
        version = version + 1,
        updated_by_user_id = $4,
        updated_at = now()
    WHERE card_kind = $1
      AND card_id = $2
    RETURNING
      card_kind,
      card_id,
      target_column,
      version,
      created_at,
      created_by_user_id,
      updated_at,
      updated_by_user_id
    `,
    [command.cardKind, command.cardId, command.targetColumn, actorUserId],
  );
  return mapMoveRow(result.rows[0]);
}

function mapMoveRow(row: MdfBoardManualMoveRow): MdfBoardManualMoveDto {
  return {
    cardKind: row.card_kind,
    cardId: row.card_id,
    targetColumn: row.target_column,
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    createdByUserId: toNullableNumber(row.created_by_user_id),
    updatedAt: toIso(row.updated_at),
    updatedByUserId: toNullableNumber(row.updated_by_user_id),
  };
}

function auditShape(move: MdfBoardManualMoveDto): Record<string, unknown> {
  return {
    cardKind: move.cardKind,
    cardId: move.cardId,
    targetColumn: move.targetColumn,
    version: move.version,
    updatedAt: move.updatedAt,
    updatedByUserId: move.updatedByUserId,
  };
}

function auditMetadata(
  cardKind: MdfBoardManualMoveDto['cardKind'],
  cardId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source: SOURCE,
    cardKind,
    cardId,
    ...extra,
  };
}

function relatedEntities(
  cardKind: MdfBoardManualMoveDto['cardKind'],
  cardId: string,
  relatedOrderIds: number[] = [],
): AuditRelatedEntity[] {
  const ids = new Set(relatedOrderIds);
  const orderId = relatedOrderId(cardKind, cardId);
  if (orderId !== null) ids.add(orderId);
  return Array.from(ids)
    .sort((left, right) => left - right)
    .map((entityId) => ({ entityType: 'order' as const, entityId }));
}

function relatedOrderId(
  cardKind: MdfBoardManualMoveDto['cardKind'],
  cardId: string,
): number | null {
  if (cardKind !== 'order') return null;
  return toPositiveSafeInteger(cardId);
}

function manualMoveEntityId(cardKind: MdfBoardManualMoveDto['cardKind'], cardId: string): string {
  return `${cardKind}:${cardId}`;
}

function statusAutomationEventTypeForTargetColumn(
  targetColumn: MdfBoardManualMoveDto['targetColumn'],
): MdfBoardColumnAutomationInput['eventType'] | null {
  switch (targetColumn) {
    case 'completed':
      return 'mdf.board.completed';
    case 'baths':
      return 'mdf.board.baths';
    case 'baths_ready':
      return 'mdf.board.baths_ready';
    case 'baths_laminated':
      return 'mdf.board.baths_laminated';
    default:
      return null;
  }
}

async function loadRelatedOrderIds(
  tx: TransactionClient,
  cardKind: MdfBoardManualMoveDto['cardKind'],
  cardId: string,
): Promise<number[]> {
  switch (cardKind) {
    case 'order': {
      const orderId = relatedOrderId(cardKind, cardId);
      return orderId === null ? [] : [orderId];
    }
    case 'packet':
      return loadPacketOrderIds(tx, cardId);
    case 'bazisCutSet':
      return loadBazisCutSetOrderIds(tx, cardId);
    case 'bath':
      return loadBathOrderIds(tx, cardId);
  }
}

async function loadPacketOrderIds(tx: TransactionClient, packetId: string): Promise<number[]> {
  const result = await tx.query<{ order_id: string | number | null }>(
    `
    WITH unique_order_keys AS (
      SELECT lower(trim(o.order_name)) AS order_key, MIN(o.order_id)::bigint AS order_id
      FROM orders o
      WHERE COALESCE(o.delete_flag, false) = false
        AND NULLIF(trim(o.order_name), '') IS NOT NULL
      GROUP BY lower(trim(o.order_name))
      HAVING COUNT(*) = 1
    )
    SELECT DISTINCT COALESCE(item.match_order_id, order_key.order_id) AS order_id
    FROM cnc_telegram_packet_items item
    LEFT JOIN unique_order_keys order_key
      ON order_key.order_key = lower(trim(item.order_name))
    WHERE item.packet_id = $1
      AND COALESCE(item.match_order_id, order_key.order_id) IS NOT NULL
    ORDER BY order_id
    `,
    [packetId],
  );
  return normalizeOrderIds(result.rows.map((row) => row.order_id));
}

async function loadBazisCutSetOrderIds(tx: TransactionClient, cardId: string): Promise<number[]> {
  const bazisCutSetId = toPositiveSafeInteger(cardId);
  if (bazisCutSetId === null) return [];
  const result = await tx.query<{ order_id: string | number | null }>(
    `
    SELECT DISTINCT source_order_id AS order_id
    FROM bazis_cut_set_details
    WHERE bazis_cut_set_id = $1
      AND source_order_id IS NOT NULL
    ORDER BY source_order_id
    `,
    [bazisCutSetId],
  );
  return normalizeOrderIds(result.rows.map((row) => row.order_id));
}

async function loadBathOrderIds(tx: TransactionClient, cardId: string): Promise<number[]> {
  const cutResultId = parseBathCutResultId(cardId);
  if (cutResultId === null) return [];
  const result = await tx.query<{ order_id: string | number | null }>(
    `
    SELECT DISTINCT placement.order_id
    FROM cut_result_placement placement
    JOIN orders o
      ON o.order_id = placement.order_id
     AND COALESCE(o.delete_flag, false) = false
    WHERE placement.cut_result_id = $1
    ORDER BY placement.order_id
    `,
    [cutResultId],
  );
  return normalizeOrderIds(result.rows.map((row) => row.order_id));
}

function parseBathCutResultId(cardId: string): number | null {
  const match = /^cut-result:(\d+)$/.exec(cardId);
  return match ? toPositiveSafeInteger(match[1]) : null;
}

function normalizeOrderIds(values: Iterable<string | number | null>): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    if (value === null) continue;
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) ids.add(parsed);
  }
  return Array.from(ids).sort((left, right) => left - right);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toNullableUserId(value: string): number | null {
  return toPositiveSafeInteger(value);
}

function toPositiveSafeInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query(`SELECT set_config('erp.current_user_id', $1, true)`, [userId]);
}
