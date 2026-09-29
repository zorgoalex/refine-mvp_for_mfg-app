import { createHash } from 'crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { markStageEventWriter } from '../../../shared/production-status/stage-event-writer';
import type { OrderDto } from '../dto/order.dto';
import { OrderNotFoundError, OrderVersionConflictError } from '../errors/order.errors';
import {
  assertUniqueReworkDetails,
  normalizeReworkComment,
  resolveReworkMode,
  reworkOutboxKey,
  REWORK_STATUS_CODE,
  type ClarifyReworkReasonRequest,
  type FalsePositiveReworkRequest,
  type OrderReworkMode,
  type StartOrExtendReworkRequest,
} from '../domain/order-rework';

/**
 * «Переделка»: production rounds of an order (plan 2026-09-27-order-rework-status-plan v18, §5).
 *
 * Every round operation runs in one transaction with the lock protocol of §5.7:
 * MDF cutover fence (shared, try) → orders → order_details (FOR NO KEY UPDATE) →
 * own round tables. No nested helper that takes `FOR UPDATE` on the order and no
 * in-transaction status automation / MDF dispatch runs here; realtime emission is
 * deferred (erp.realtime_defer) and delivered after commit.
 */

const SOURCE = 'backend-order-rework';
const IDEMPOTENCY_STALE_MS = 10 * 60 * 1000;
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);
const MAX_ATTEMPTS = 3;

export type OrderReworkAction = 'started' | 'extended' | 'noop' | 'reason_clarified' | 'false_positive';

export interface OrderReworkCommandResultDto {
  orderId: number;
  roundNo: number;
  mode: OrderReworkMode;
  action: OrderReworkAction;
  version: number;
  detailIds: number[];
  requestId: string;
}

export interface OrderReworkResponseDto extends OrderReworkCommandResultDto {
  order: OrderDto | null;
}

export type OrderReworkAvailability =
  | 'available'
  | 'disabled_flag'
  | 'mdf_engine_unsupported'
  | 'mdf_cutover_in_progress';

export interface OrderReworkReasonDto {
  reasonId: number;
  code: string;
  name: string;
  requiresComment: boolean;
  sortOrder: number;
}

export interface OrderReworkRoundDetailDto {
  detailId: number;
  detailNumber: number | null;
  fromProductionStatusId: number | null;
  fromProductionStatusName: string | null;
  fromProductionRound: number;
  toProductionStatusId: number;
  toProductionStatusName: string | null;
  addedAt: string;
  addedBySource: 'start' | 'extend';
}

export interface OrderReworkRoundDto {
  roundNo: number;
  mode: OrderReworkMode;
  source: string;
  reasonId: number;
  reasonCode: string;
  reasonName: string;
  reasonIsSystem: boolean;
  reasonComment: string | null;
  startedAt: string;
  startedByUserId: number | null;
  startedByUsername: string | null;
  reasonClarifiedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  details: OrderReworkRoundDetailDto[];
}

interface CommandBase {
  currentUser: CurrentUser;
  orderId: number;
  version: number;
  idempotencyKey: string;
  requestId?: string;
}

export interface StartOrExtendReworkCommand extends CommandBase {
  dto: StartOrExtendReworkRequest;
}

export interface ClarifyReworkReasonCommand extends CommandBase {
  roundNo: number;
  dto: ClarifyReworkReasonRequest;
}

export interface FalsePositiveReworkCommand extends CommandBase {
  roundNo: number;
  dto: FalsePositiveReworkRequest;
}

export interface OrderReworkServicePorts {
  database: DatabaseService;
  isEnabled: () => boolean;
  /** Post-commit read through the order query service (permissions/financial redaction apply). */
  readOrder: (currentUser: CurrentUser, orderId: number) => Promise<OrderDto>;
}

interface LockedOrderRow extends QueryResultRow {
  order_id: string | number;
  client_id: string | number | null;
  order_kind: string;
  order_status_id: string | number;
  order_status_code: string;
  order_status_name: string;
  production_round: string | number;
  last_round_no: string | number;
  version: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface LockedOrder {
  orderId: number;
  clientId: number | null;
  orderStatusId: number;
  orderStatusCode: string;
  orderStatusName: string;
  productionRound: number;
  lastRoundNo: number;
  version: number;
  createdBy: string | null;
  managerId: string | null;
}

interface RoundRow extends QueryResultRow {
  order_production_round_id: string | number;
  round_no: string | number;
  mode: OrderReworkMode;
  reason_id: string | number;
  reason_comment: string | null;
  from_order_status_id: string | number;
  from_order_production_round: string | number;
  closed_at: string | Date | null;
  event_seq: string | number;
}

interface DetailRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  deleted: boolean;
  production_status_id: string | number | null;
  production_round: string | number;
  status_sort: string | number | null;
}

interface StatusRow extends QueryResultRow {
  production_status_id: string | number;
  production_status_code: string | null;
  production_status_name: string;
  sort_order: string | number | null;
  is_active: boolean;
}

interface ReasonRow extends QueryResultRow {
  order_rework_reason_id: string | number;
  code: string;
  name: string;
  requires_comment: boolean;
  is_system: boolean;
  is_active: boolean;
  sort_order: string | number;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  response_json: OrderReworkCommandResultDto | string | null;
  status: 'processing' | 'completed' | 'failed';
  created_at: string | Date | null;
}

export class OrderReworkService {
  private readonly orderAccessPolicy = new OrderAccessPolicy();

  constructor(private readonly ports: OrderReworkServicePorts) {}

  // ---------------------------------------------------------------- queries

  async availability(): Promise<{ availability: OrderReworkAvailability }> {
    if (!this.ports.isEnabled()) return { availability: 'disabled_flag' };
    const availability = await this.ports.database.transaction(async (tx) => {
      const fence = await tryMdfFence(tx);
      if (!fence) return 'mdf_cutover_in_progress' as const;
      return (await mdfEngineSupportsRounds(tx)) ? ('available' as const) : ('mdf_engine_unsupported' as const);
    });
    return { availability };
  }

  async listReasons(currentUser: CurrentUser): Promise<{ data: OrderReworkReasonDto[] }> {
    requirePermission(currentUser, 'orders.view');
    const rows = await this.ports.database.query<ReasonRow>(
      `SELECT order_rework_reason_id, code, name, requires_comment, is_system, is_active, sort_order
       FROM order_rework_reasons
       WHERE is_active AND NOT is_system
       ORDER BY sort_order, name`,
    );
    return { data: rows.rows.map(mapReason) };
  }

  async listRounds(currentUser: CurrentUser, orderId: number): Promise<{ data: OrderReworkRoundDto[] }> {
    requirePermission(currentUser, 'orders.view');
    const order = (await this.ports.database.query<LockedOrderRow>(
      `SELECT order_id, created_by, manager_id FROM orders WHERE order_id = $1 AND delete_flag = false`,
      [orderId],
    )).rows[0];
    if (!order || !this.orderAccessPolicy.canView(currentUser, policySubject(order))) {
      throw new OrderNotFoundError(orderId);
    }
    const rounds = await this.ports.database.query(
      `SELECT r.round_no, r.mode, r.source, r.reason_id, rr.code AS reason_code, rr.name AS reason_name,
              rr.is_system AS reason_is_system, r.reason_comment, r.started_at, r.started_by,
              u.username AS started_by_username, r.reason_clarified_at, r.closed_at, r.close_reason,
              r.order_production_round_id
       FROM order_production_rounds r
       JOIN order_rework_reasons rr ON rr.order_rework_reason_id = r.reason_id
       LEFT JOIN users u ON u.user_id = r.started_by
       WHERE r.order_id = $1
       ORDER BY r.round_no`,
      [orderId],
    );
    const details = await this.ports.database.query(
      `SELECT rd.order_production_round_id, rd.detail_id, d.detail_number,
              rd.from_production_status_id, fs.production_status_name AS from_name,
              rd.from_production_round, rd.to_production_status_id, ts.production_status_name AS to_name,
              rd.added_at, rd.added_by_source
       FROM order_production_round_details rd
       JOIN order_production_rounds r ON r.order_production_round_id = rd.order_production_round_id
       LEFT JOIN order_details d ON d.detail_id = rd.detail_id
       LEFT JOIN production_statuses fs ON fs.production_status_id = rd.from_production_status_id
       LEFT JOIN production_statuses ts ON ts.production_status_id = rd.to_production_status_id
       WHERE r.order_id = $1
       ORDER BY rd.order_production_round_id, d.detail_number NULLS LAST, rd.detail_id`,
      [orderId],
    );
    const byRound = new Map<string, OrderReworkRoundDetailDto[]>();
    for (const row of details.rows) {
      const key = String(row.order_production_round_id);
      const list = byRound.get(key) ?? [];
      list.push({
        detailId: Number(row.detail_id),
        detailNumber: row.detail_number === null ? null : Number(row.detail_number),
        fromProductionStatusId: row.from_production_status_id === null ? null : Number(row.from_production_status_id),
        fromProductionStatusName: row.from_name ?? null,
        fromProductionRound: Number(row.from_production_round),
        toProductionStatusId: Number(row.to_production_status_id),
        toProductionStatusName: row.to_name ?? null,
        addedAt: toIso(row.added_at),
        addedBySource: row.added_by_source,
      });
      byRound.set(key, list);
    }
    return {
      data: rounds.rows.map((row) => ({
        roundNo: Number(row.round_no),
        mode: row.mode,
        source: row.source,
        reasonId: Number(row.reason_id),
        reasonCode: row.reason_code,
        reasonName: row.reason_name,
        reasonIsSystem: row.reason_is_system === true,
        reasonComment: row.reason_comment ?? null,
        startedAt: toIso(row.started_at),
        startedByUserId: row.started_by === null ? null : Number(row.started_by),
        startedByUsername: row.started_by_username ?? null,
        reasonClarifiedAt: row.reason_clarified_at ? toIso(row.reason_clarified_at) : null,
        closedAt: row.closed_at ? toIso(row.closed_at) : null,
        closeReason: row.close_reason ?? null,
        details: byRound.get(String(row.order_production_round_id)) ?? [],
      })),
    };
  }

  // --------------------------------------------------------------- commands

  async startOrExtend(command: StartOrExtendReworkCommand): Promise<OrderReworkResponseDto> {
    this.assertEnabled();
    requirePermission(command.currentUser, 'orders.rework');
    assertUniqueReworkDetails(command.dto.details);
    const requestId = command.requestId ?? 'orders-rework';
    const result = await this.withRetry(() =>
      this.ports.database.transaction((tx) => this.startOrExtendInTransaction(tx, command, requestId)),
    );
    return this.withOrder(result, command.currentUser);
  }

  async clarifyReason(command: ClarifyReworkReasonCommand): Promise<OrderReworkResponseDto> {
    this.assertEnabled();
    requirePermission(command.currentUser, 'orders.rework');
    const requestId = command.requestId ?? 'orders-rework-reason';
    const result = await this.withRetry(() =>
      this.ports.database.transaction((tx) => this.clarifyReasonInTransaction(tx, command, requestId)),
    );
    return this.withOrder(result, command.currentUser);
  }

  async falsePositive(command: FalsePositiveReworkCommand): Promise<OrderReworkResponseDto> {
    this.assertEnabled();
    requirePermission(command.currentUser, 'orders.rework');
    const requestId = command.requestId ?? 'orders-rework-false-positive';
    const result = await this.withRetry(() =>
      this.ports.database.transaction((tx) => this.falsePositiveInTransaction(tx, command, requestId)),
    );
    return this.withOrder(result, command.currentUser);
  }

  // ------------------------------------------------------------ transactions

  private async startOrExtendInTransaction(
    tx: TransactionClient,
    command: StartOrExtendReworkCommand,
    requestId: string,
  ): Promise<OrderReworkCommandResultDto> {
    await beginRoundTransaction(tx, command.currentUser);
    await assertMdfSupportsRounds(tx);
    const replay = await reconcileIdempotency(tx, command, 'orders.rework', {
      orderId: command.orderId,
      version: command.version,
      reasonId: command.dto.reasonId ?? null,
      comment: command.dto.comment ?? null,
      details: [...command.dto.details].sort((a, b) => a.detailId - b.detailId),
    });
    if (replay) return replay;

    const order = await lockOrder(tx, command.orderId);
    this.assertCanUpdate(command.currentUser, order);
    assertVersion(order, command.version);

    const openRound = await loadOpenRound(tx, order.orderId);
    const mode: OrderReworkMode | null = openRound ? openRound.mode : resolveReworkMode(order.orderStatusCode);
    if (!openRound && !mode) {
      throw new ApiError(409, 'ORDER_REWORK_STATUS_NOT_ALLOWED', 'Переделку можно начать только в производстве или после готовности заказа', {
        orderStatusCode: order.orderStatusCode,
      });
    }
    if (openRound && command.dto.reasonId !== undefined) {
      throw new ApiError(422, 'ORDER_REWORK_REASON_NOT_APPLICABLE', 'Причина задаётся при начале переделки; детали добавляются в открытый круг без причины');
    }

    let reason: ReasonRow | null = null;
    let comment: string | null = null;
    if (!openRound) {
      if (command.dto.reasonId === undefined) {
        throw new ApiError(422, 'ORDER_REWORK_REASON_REQUIRED', 'Укажите причину переделки');
      }
      reason = await loadManualReason(tx, command.dto.reasonId);
      comment = normalizeReworkComment(command.dto.comment, reason.requires_comment);
    } else if (command.dto.comment) {
      throw new ApiError(422, 'ORDER_REWORK_REASON_NOT_APPLICABLE', 'Комментарий задаётся при начале переделки');
    }

    const roundNo = openRound ? Number(openRound.round_no) : order.lastRoundNo + 1;
    const details = await lockDetails(tx, command.dto.details.map((d) => d.detailId));
    const alreadyInRound = openRound
      ? await loadRoundDetailIds(tx, Number(openRound.order_production_round_id))
      : new Set<number>();
    const targets = await loadStatuses(tx, command.dto.details.map((d) => d.productionStatusId));
    const issuedSort = await loadIssuedSort(tx);

    const planned: Array<{ detailId: number; from: DetailRow; target: StatusRow }> = [];
    for (const requested of command.dto.details) {
      const detail = details.get(requested.detailId);
      if (!detail || Number(detail.order_id) !== order.orderId || detail.deleted) {
        throw new ApiError(422, 'ORDER_REWORK_DETAIL_NOT_IN_ORDER', 'Деталь не найдена в заказе', { detailId: requested.detailId });
      }
      if (alreadyInRound.has(requested.detailId)) continue;
      const target = targets.get(requested.productionStatusId);
      assertReworkTarget(requested.detailId, detail, target, issuedSort);
      planned.push({ detailId: requested.detailId, from: detail, target: target! });
    }

    if (openRound && planned.length === 0) {
      const noop: OrderReworkCommandResultDto = {
        orderId: order.orderId, roundNo, mode: openRound.mode, action: 'noop', version: order.version, detailIds: [], requestId,
      };
      await completeIdempotency(tx, command.idempotencyKey, noop);
      return noop;
    }

    let roundId: number;
    if (openRound) {
      roundId = Number(openRound.order_production_round_id);
    } else {
      roundId = Number((await tx.query<{ order_production_round_id: string }>(
        `INSERT INTO order_production_rounds (
           order_id, round_no, mode, reason_id, reason_comment, from_order_status_id,
           from_order_production_round, source, started_by, request_id, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8, $9, $10)
         RETURNING order_production_round_id`,
        [
          order.orderId, roundNo, mode, Number(reason!.order_rework_reason_id), comment, order.orderStatusId,
          order.productionRound, actorId(command.currentUser), requestId, command.idempotencyKey,
        ],
      )).rows[0].order_production_round_id);
    }

    for (const item of planned) {
      await tx.query(
        `INSERT INTO order_production_round_details (
           order_production_round_id, detail_id, from_production_status_id, from_production_round,
           from_production_status_sort, to_production_status_id, added_by_source
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          roundId, item.detailId, toNullableNumber(item.from.production_status_id), Number(item.from.production_round),
          toNullableNumber(item.from.status_sort), Number(item.target.production_status_id), openRound ? 'extend' : 'start',
        ],
      );
      await tx.query(
        'UPDATE order_details SET production_status_id = $2, production_round = $3 WHERE detail_id = $1',
        [item.detailId, Number(item.target.production_status_id), roundNo],
      );
      await tx.query(
        `INSERT INTO production_status_events (detail_id, production_status_id, event_by, note, payload, round_no)
         VALUES ($1, $2, $3, NULL, $4::jsonb, $5)
         ON CONFLICT (detail_id, production_status_id, round_no) WHERE detail_id IS NOT NULL DO NOTHING`,
        [item.detailId, Number(item.target.production_status_id), actorId(command.currentUser),
          JSON.stringify({ source: SOURCE, requestId, roundNo }), roundNo],
      );
    }

    const enteringRework = !openRound && mode === 'after_ready';
    const reworkStatusId = enteringRework ? await loadReworkStatusId(tx) : null;
    const version = Number((await tx.query<{ version: string }>(
      `UPDATE orders
       SET order_status_id = COALESCE($2, order_status_id),
           production_round = $3,
           last_round_no = GREATEST(last_round_no, $3),
           version = version + 1
       WHERE order_id = $1
       RETURNING version`,
      [order.orderId, reworkStatusId, roundNo],
    )).rows[0].version);
    const seq = await bumpEventSeq(tx, roundId);

    const detailIds = planned.map((p) => p.detailId);
    const event = openRound ? 'order.rework_details_added' : 'order.rework_started';
    const outboxKey = reworkOutboxKey(order.orderId, roundNo, openRound ? 'details_added' : 'started', seq);
    const reasonMeta = reason
      ? { reasonId: Number(reason.order_rework_reason_id), reasonCode: reason.code }
      : await loadRoundReasonMeta(tx, roundId);
    await auditService.record(tx, {
      event,
      entityType: 'order',
      entityId: order.orderId,
      ...actorAudit(command.currentUser),
      requestId,
      source: SOURCE,
      relatedOrderId: order.orderId,
      relatedClientId: order.clientId,
      before: {
        orderStatusId: order.orderStatusId,
        productionRound: order.productionRound,
        details: planned.map((p) => ({
          detailId: p.detailId,
          productionStatusId: toNullableNumber(p.from.production_status_id),
          productionRound: Number(p.from.production_round),
        })),
      },
      after: {
        orderStatusId: reworkStatusId ?? order.orderStatusId,
        productionRound: roundNo,
        details: planned.map((p) => ({
          detailId: p.detailId,
          productionStatusId: Number(p.target.production_status_id),
          productionRound: roundNo,
        })),
      },
      diff: {
        productionRound: { before: order.productionRound, after: roundNo },
        ...(reworkStatusId ? { orderStatusId: { before: order.orderStatusId, after: reworkStatusId } } : {}),
      },
      relatedEntities: detailIds.map((detailId) => ({ entityType: 'order_detail', entityId: detailId })),
      metadata: {
        roundNo, mode, ...reasonMeta, reasonComment: comment, source: 'manual', detailIds, eventSeq: seq,
        idempotencyKey: command.idempotencyKey, outboxIdempotencyKey: outboxKey,
      },
    });
    await enqueueOutbox(tx, event, order, outboxKey, {
      roundNo, mode, ...reasonMeta, source: 'manual', detailIds, detailCount: detailIds.length,
      actorUserId: command.currentUser.id, requestId, idempotencyKey: command.idempotencyKey,
    });
    if (reworkStatusId) {
      await recordStatusTransition(tx, command.currentUser, order, reworkStatusId, requestId, `${outboxKey}:status`);
    }

    const result: OrderReworkCommandResultDto = {
      orderId: order.orderId, roundNo, mode: mode!, action: openRound ? 'extended' : 'started', version, detailIds, requestId,
    };
    await completeIdempotency(tx, command.idempotencyKey, result);
    return result;
  }

  private async clarifyReasonInTransaction(
    tx: TransactionClient,
    command: ClarifyReworkReasonCommand,
    requestId: string,
  ): Promise<OrderReworkCommandResultDto> {
    await beginRoundTransaction(tx, command.currentUser);
    await assertMdfFence(tx);
    const replay = await reconcileIdempotency(tx, command, 'orders.rework_reason', {
      orderId: command.orderId, roundNo: command.roundNo, version: command.version,
      reasonId: command.dto.reasonId, comment: command.dto.comment ?? null,
    });
    if (replay) return replay;

    const order = await lockOrder(tx, command.orderId);
    this.assertCanUpdate(command.currentUser, order);
    assertVersion(order, command.version);
    const round = await loadRound(tx, order.orderId, command.roundNo);
    const reason = await loadManualReason(tx, command.dto.reasonId);
    const comment = normalizeReworkComment(command.dto.comment, reason.requires_comment);
    const before = await loadRoundReasonMeta(tx, Number(round.order_production_round_id));

    await tx.query(
      `UPDATE order_production_rounds
       SET reason_id = $2, reason_comment = $3, reason_clarified_at = now(), reason_clarified_by = $4
       WHERE order_production_round_id = $1`,
      [Number(round.order_production_round_id), Number(reason.order_rework_reason_id), comment, actorId(command.currentUser)],
    );
    const version = await bumpOrderVersion(tx, order.orderId);
    const seq = await bumpEventSeq(tx, Number(round.order_production_round_id));
    const outboxKey = reworkOutboxKey(order.orderId, command.roundNo, 'reason_clarified', seq);
    const after = { reasonId: Number(reason.order_rework_reason_id), reasonCode: reason.code };
    await auditService.record(tx, {
      event: 'order.rework_reason_clarified',
      entityType: 'order',
      entityId: order.orderId,
      ...actorAudit(command.currentUser),
      requestId,
      source: SOURCE,
      relatedOrderId: order.orderId,
      relatedClientId: order.clientId,
      before: { ...before, reasonComment: round.reason_comment ?? null },
      after: { ...after, reasonComment: comment },
      diff: { reasonId: { before: before.reasonId, after: after.reasonId } },
      metadata: { roundNo: command.roundNo, mode: round.mode, eventSeq: seq, idempotencyKey: command.idempotencyKey, outboxIdempotencyKey: outboxKey },
    });
    await enqueueOutbox(tx, 'order.rework_reason_clarified', order, outboxKey, {
      roundNo: command.roundNo, mode: round.mode, ...after, previousReasonCode: before.reasonCode,
      actorUserId: command.currentUser.id, requestId, idempotencyKey: command.idempotencyKey,
    });
    const result: OrderReworkCommandResultDto = {
      orderId: order.orderId, roundNo: command.roundNo, mode: round.mode, action: 'reason_clarified', version, detailIds: [], requestId,
    };
    await completeIdempotency(tx, command.idempotencyKey, result);
    return result;
  }

  private async falsePositiveInTransaction(
    tx: TransactionClient,
    command: FalsePositiveReworkCommand,
    requestId: string,
  ): Promise<OrderReworkCommandResultDto> {
    await beginRoundTransaction(tx, command.currentUser);
    await assertMdfFence(tx);
    const replay = await reconcileIdempotency(tx, command, 'orders.rework_false_positive', {
      orderId: command.orderId, roundNo: command.roundNo, version: command.version, comment: command.dto.comment ?? null,
    });
    if (replay) return replay;

    const order = await lockOrder(tx, command.orderId);
    this.assertCanUpdate(command.currentUser, order);
    assertVersion(order, command.version);
    const round = await loadRound(tx, order.orderId, command.roundNo);
    if (round.closed_at !== null) {
      throw new ApiError(409, 'ORDER_REWORK_ROUND_NOT_OPEN', 'Круг переделки уже закрыт');
    }
    const comment = normalizeReworkComment(command.dto.comment, false);
    const roundId = Number(round.order_production_round_id);
    const restored = (await tx.query<{
      detail_id: string; from_production_status_id: string | null; from_production_round: string;
      production_status_id: string | null; production_round: string; deleted: boolean; order_id: string;
    }>(
      `SELECT rd.detail_id, rd.from_production_status_id, rd.from_production_round,
              d.production_status_id, d.production_round, COALESCE(d.delete_flag, false) AS deleted, d.order_id
       FROM order_production_round_details rd
       JOIN order_details d ON d.detail_id = rd.detail_id
       WHERE rd.order_production_round_id = $1
       ORDER BY rd.detail_id
       FOR NO KEY UPDATE OF d`,
      [roundId],
    )).rows;

    // Every live detail of the round must still belong to this order and to this round;
    // otherwise (moved to another order, or already in a later round) nothing is restored.
    const foreign = restored.filter((row) => !row.deleted
      && (Number(row.order_id) !== order.orderId || Number(row.production_round) !== command.roundNo));
    if (foreign.length > 0) {
      throw new ApiError(409, 'ORDER_REWORK_DETAILS_CHANGED', 'Детали круга перенесены или изменены; отмена невозможна', {
        detailIds: foreign.map((row) => Number(row.detail_id)),
      });
    }
    for (const row of restored) {
      if (row.deleted) continue;
      await tx.query(
        'UPDATE order_details SET production_round = $2, production_status_id = $3 WHERE detail_id = $1',
        [Number(row.detail_id), Number(row.from_production_round), toNullableNumber(row.from_production_status_id)],
      );
    }
    const restoreStatus = round.mode === 'after_ready' ? Number(round.from_order_status_id) : null;
    const fromRound = Number(round.from_order_production_round);
    await tx.query(
      `UPDATE order_production_rounds
       SET closed_at = now(), closed_by = $2, close_reason = 'false_positive'
       WHERE order_production_round_id = $1`,
      [roundId, actorId(command.currentUser)],
    );
    const version = Number((await tx.query<{ version: string }>(
      `UPDATE orders
       SET order_status_id = COALESCE($2, order_status_id),
           production_round = $3,
           version = version + 1
       WHERE order_id = $1
       RETURNING version`,
      [order.orderId, restoreStatus, fromRound],
    )).rows[0].version);
    const seq = await bumpEventSeq(tx, roundId);
    const outboxKey = reworkOutboxKey(order.orderId, command.roundNo, 'closed', seq);
    const detailIds = restored.filter((r) => !r.deleted).map((r) => Number(r.detail_id));
    await auditService.record(tx, {
      event: 'order.rework_closed',
      entityType: 'order',
      entityId: order.orderId,
      ...actorAudit(command.currentUser),
      requestId,
      source: SOURCE,
      relatedOrderId: order.orderId,
      relatedClientId: order.clientId,
      before: {
        orderStatusId: order.orderStatusId,
        productionRound: order.productionRound,
        details: restored.map((r) => ({
          detailId: Number(r.detail_id), productionStatusId: toNullableNumber(r.production_status_id), productionRound: Number(r.production_round),
        })),
      },
      after: {
        orderStatusId: restoreStatus ?? order.orderStatusId,
        productionRound: fromRound,
        details: restored.filter((r) => !r.deleted).map((r) => ({
          detailId: Number(r.detail_id), productionStatusId: toNullableNumber(r.from_production_status_id), productionRound: Number(r.from_production_round),
        })),
      },
      diff: {
        productionRound: { before: order.productionRound, after: fromRound },
        ...(restoreStatus !== null && restoreStatus !== order.orderStatusId
          ? { orderStatusId: { before: order.orderStatusId, after: restoreStatus } } : {}),
      },
      relatedEntities: detailIds.map((detailId) => ({ entityType: 'order_detail', entityId: detailId })),
      metadata: {
        roundNo: command.roundNo, mode: round.mode, closeReason: 'false_positive', comment, detailIds, eventSeq: seq,
        idempotencyKey: command.idempotencyKey, outboxIdempotencyKey: outboxKey,
      },
    });
    await enqueueOutbox(tx, 'order.rework_closed', order, outboxKey, {
      roundNo: command.roundNo, mode: round.mode, closeReason: 'false_positive', detailIds,
      actorUserId: command.currentUser.id, requestId, idempotencyKey: command.idempotencyKey,
    });
    if (restoreStatus !== null && restoreStatus !== order.orderStatusId) {
      await recordStatusTransition(tx, command.currentUser, order, restoreStatus, requestId, `${outboxKey}:status`);
    }
    const result: OrderReworkCommandResultDto = {
      orderId: order.orderId, roundNo: command.roundNo, mode: round.mode, action: 'false_positive', version, detailIds, requestId,
    };
    await completeIdempotency(tx, command.idempotencyKey, result);
    return result;
  }

  // ----------------------------------------------------------------- helpers

  private assertEnabled(): void {
    if (!this.ports.isEnabled()) {
      throw new ApiError(503, 'ORDER_REWORK_DISABLED', 'Переделка заказов выключена');
    }
  }

  private assertCanUpdate(currentUser: CurrentUser, order: LockedOrder): void {
    const subject = { orderId: order.orderId, createdByUserId: order.createdBy, managerUserId: order.managerId };
    if (!this.orderAccessPolicy.canUpdate(currentUser, subject)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.update', 'orders.rework'],
      });
    }
  }

  private async withOrder(result: OrderReworkCommandResultDto, currentUser: CurrentUser): Promise<OrderReworkResponseDto> {
    const order = await this.ports.readOrder(currentUser, result.orderId);
    return { ...result, order };
  }

  private async withRetry<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (attempt >= MAX_ATTEMPTS || !code || !RETRYABLE_SQLSTATES.has(code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 80) * attempt));
      }
    }
  }
}

// ------------------------------------------------------------------ SQL steps

async function beginRoundTransaction(tx: TransactionClient, currentUser: CurrentUser): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [currentUser.id]);
  // §5.7 п.5: no synchronous lock of order_realtime_stream in round transactions.
  await tx.query("SELECT set_config('erp.realtime_defer', 'on', true)");
  // §5.2: the DB guard admits entering «Переделка» only from this command.
  await tx.query("SELECT set_config('erp.rework_command', 'on', true)");
  await markStageEventWriter(tx);
}

async function tryMdfFence(tx: TransactionClient): Promise<boolean> {
  const row = (await tx.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover', 0)) AS locked",
  )).rows[0];
  return row?.locked === true;
}

async function mdfEngineSupportsRounds(tx: TransactionClient): Promise<boolean> {
  const present = (await tx.query<{ present: boolean }>(
    "SELECT to_regclass('public.mdf_engine_state') IS NOT NULL AS present",
  )).rows[0]?.present;
  if (!present) return true;
  const mode = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode;
  // The MDF engine does not support production rounds yet (plan §5.5, MDF agent note).
  return !(mode === 'active' || mode === 'read_only');
}

/** §5.7: every round command takes the shared cutover fence first and fails fast (409) during a cutover. */
async function assertMdfFence(tx: TransactionClient): Promise<void> {
  if (!(await tryMdfFence(tx))) {
    throw new ApiError(409, 'ORDER_REWORK_MDF_CUTOVER_IN_PROGRESS', 'Идёт переключение производственного учёта, повторите позже');
  }
}

/** §5.5: creating/extending rounds is refused while the MDF engine is active without round support. */
async function assertMdfSupportsRounds(tx: TransactionClient): Promise<void> {
  await assertMdfFence(tx);
  if (!(await mdfEngineSupportsRounds(tx))) {
    throw new ApiError(409, 'ORDER_REWORK_MDF_ENGINE_UNSUPPORTED', 'Переделка станет доступна после поддержки кругов в МДФ-движке');
  }
}

async function lockOrder(tx: TransactionClient, orderId: number): Promise<LockedOrder> {
  const row = (await tx.query<LockedOrderRow>(
    `SELECT o.order_id, o.client_id, o.order_kind, o.order_status_id, s.order_status_code, s.order_status_name,
            o.production_round, o.last_round_no, o.version, o.created_by, o.manager_id
     FROM orders o
     JOIN order_statuses s ON s.order_status_id = o.order_status_id
     WHERE o.order_id = $1 AND o.delete_flag = false
     FOR NO KEY UPDATE OF o`,
    [orderId],
  )).rows[0];
  if (!row || row.order_kind !== 'production_order') {
    throw new OrderNotFoundError(orderId);
  }
  return {
    orderId: Number(row.order_id),
    clientId: toNullableNumber(row.client_id),
    orderStatusId: Number(row.order_status_id),
    orderStatusCode: row.order_status_code,
    orderStatusName: row.order_status_name,
    productionRound: Number(row.production_round),
    lastRoundNo: Number(row.last_round_no),
    version: Number(row.version),
    createdBy: row.created_by === null ? null : String(row.created_by),
    managerId: row.manager_id === null ? null : String(row.manager_id),
  };
}

function assertVersion(order: LockedOrder, expected: number): void {
  if (order.version !== expected) {
    throw new OrderVersionConflictError(order.version, expected);
  }
}

async function loadOpenRound(tx: TransactionClient, orderId: number): Promise<RoundRow | null> {
  return (await tx.query<RoundRow>(
    `SELECT order_production_round_id, round_no, mode, reason_id, reason_comment, from_order_status_id,
            from_order_production_round, closed_at, event_seq
     FROM order_production_rounds
     WHERE order_id = $1 AND closed_at IS NULL
     FOR UPDATE`,
    [orderId],
  )).rows[0] ?? null;
}

async function loadRound(tx: TransactionClient, orderId: number, roundNo: number): Promise<RoundRow> {
  const row = (await tx.query<RoundRow>(
    `SELECT order_production_round_id, round_no, mode, reason_id, reason_comment, from_order_status_id,
            from_order_production_round, closed_at, event_seq
     FROM order_production_rounds
     WHERE order_id = $1 AND round_no = $2
     FOR UPDATE`,
    [orderId, roundNo],
  )).rows[0];
  if (!row) {
    throw new ApiError(404, 'ORDER_REWORK_ROUND_NOT_FOUND', 'Круг переделки не найден', { orderId, roundNo });
  }
  return row;
}

async function loadRoundDetailIds(tx: TransactionClient, roundId: number): Promise<Set<number>> {
  const rows = await tx.query<{ detail_id: string }>(
    'SELECT detail_id FROM order_production_round_details WHERE order_production_round_id = $1',
    [roundId],
  );
  return new Set(rows.rows.map((row) => Number(row.detail_id)));
}

async function lockDetails(tx: TransactionClient, detailIds: readonly number[]): Promise<Map<number, DetailRow>> {
  const rows = await tx.query<DetailRow>(
    `SELECT d.detail_id, d.order_id, COALESCE(d.delete_flag, false) AS deleted, d.production_status_id,
            d.production_round, ps.sort_order AS status_sort
     FROM order_details d
     LEFT JOIN production_statuses ps ON ps.production_status_id = d.production_status_id
     WHERE d.detail_id = ANY($1::bigint[])
     ORDER BY d.detail_id
     FOR NO KEY UPDATE OF d`,
    [[...detailIds]],
  );
  return new Map(rows.rows.map((row) => [Number(row.detail_id), row]));
}

async function loadStatuses(tx: TransactionClient, ids: readonly number[]): Promise<Map<number, StatusRow>> {
  const rows = await tx.query<StatusRow>(
    `SELECT production_status_id, production_status_code, production_status_name, sort_order, is_active
     FROM production_statuses WHERE production_status_id = ANY($1::int[])`,
    [[...new Set(ids)]],
  );
  return new Map(rows.rows.map((row) => [Number(row.production_status_id), row]));
}

async function loadIssuedSort(tx: TransactionClient): Promise<number | null> {
  const row = (await tx.query<{ sort_order: string | number | null }>(
    "SELECT sort_order FROM production_statuses WHERE production_status_code = 'issued'",
  )).rows[0];
  return row ? toNullableNumber(row.sort_order) : null;
}

function assertReworkTarget(detailId: number, detail: DetailRow, target: StatusRow | undefined, issuedSort: number | null): void {
  const currentSort = toNullableNumber(detail.status_sort);
  if (currentSort === null) {
    throw new ApiError(422, 'ORDER_REWORK_DETAIL_WITHOUT_STAGE', 'У детали нет производственного этапа', { detailId });
  }
  const targetSort = target ? toNullableNumber(target.sort_order) : null;
  if (!target || !target.is_active || targetSort === null || targetSort >= currentSort
      || (issuedSort !== null && targetSort >= issuedSort)) {
    throw new ApiError(422, 'ORDER_REWORK_TARGET_STAGE_INVALID', 'Этап возврата должен быть раньше текущего этапа детали и не «Выдан»/«Завершено»', {
      detailId,
      productionStatusId: target ? Number(target.production_status_id) : null,
    });
  }
}

async function loadManualReason(tx: TransactionClient, reasonId: number): Promise<ReasonRow> {
  const row = (await tx.query<ReasonRow>(
    `SELECT order_rework_reason_id, code, name, requires_comment, is_system, is_active, sort_order
     FROM order_rework_reasons WHERE order_rework_reason_id = $1`,
    [reasonId],
  )).rows[0];
  if (!row || !row.is_active || row.is_system) {
    throw new ApiError(422, 'ORDER_REWORK_REASON_INVALID', 'Выберите причину переделки из списка', { reasonId });
  }
  return row;
}

async function loadRoundReasonMeta(tx: TransactionClient, roundId: number): Promise<{ reasonId: number; reasonCode: string }> {
  const row = (await tx.query<{ reason_id: string; code: string }>(
    `SELECT r.reason_id, rr.code FROM order_production_rounds r
     JOIN order_rework_reasons rr ON rr.order_rework_reason_id = r.reason_id
     WHERE r.order_production_round_id = $1`,
    [roundId],
  )).rows[0];
  return { reasonId: Number(row.reason_id), reasonCode: row.code };
}

async function loadReworkStatusId(tx: TransactionClient): Promise<number> {
  const row = (await tx.query<{ order_status_id: string }>(
    'SELECT order_status_id FROM order_statuses WHERE order_status_code = $1',
    [REWORK_STATUS_CODE],
  )).rows[0];
  if (!row) {
    throw new ApiError(503, 'ORDER_REWORK_SCHEMA_NOT_READY', 'Статус «Переделка» не найден');
  }
  return Number(row.order_status_id);
}

async function bumpEventSeq(tx: TransactionClient, roundId: number): Promise<number> {
  return Number((await tx.query<{ event_seq: string }>(
    'UPDATE order_production_rounds SET event_seq = event_seq + 1 WHERE order_production_round_id = $1 RETURNING event_seq',
    [roundId],
  )).rows[0].event_seq);
}

async function bumpOrderVersion(tx: TransactionClient, orderId: number): Promise<number> {
  return Number((await tx.query<{ version: string }>(
    'UPDATE orders SET version = version + 1 WHERE order_id = $1 RETURNING version',
    [orderId],
  )).rows[0].version);
}

async function enqueueOutbox(
  tx: TransactionClient,
  eventType: string,
  order: LockedOrder,
  idempotencyKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ($1, 'order', $2, $3::jsonb, $4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      eventType,
      String(order.orderId),
      JSON.stringify({
        source: SOURCE,
        eventType,
        entityType: 'order',
        entityId: String(order.orderId),
        orderId: order.orderId,
        clientId: order.clientId,
        outboxIdempotencyKey: idempotencyKey,
        ...payload,
      }),
      idempotencyKey,
    ],
  );
}

/**
 * Side effects of an order status transition done directly by a round command
 * (§5.7 п.3): the status-change audit row and the `order.status_changed` outbox
 * event (notifications). In-transaction status automation is intentionally not run.
 * The Bitrix stage sync is enqueued by its DB trigger on `orders`.
 */
async function recordStatusTransition(
  tx: TransactionClient,
  currentUser: CurrentUser,
  order: LockedOrder,
  nextStatusId: number,
  requestId: string,
  idempotencyKey: string,
): Promise<void> {
  const next = (await tx.query<{ order_status_name: string; order_status_code: string }>(
    'SELECT order_status_name, order_status_code FROM order_statuses WHERE order_status_id = $1',
    [nextStatusId],
  )).rows[0];
  await auditService.record(tx, {
    event: 'orders.status_change',
    entityType: 'order',
    entityId: order.orderId,
    ...actorAudit(currentUser),
    requestId,
    source: SOURCE,
    relatedOrderId: order.orderId,
    relatedClientId: order.clientId,
    statusField: 'orderStatus',
    statusId: nextStatusId,
    statusName: next?.order_status_name ?? null,
    statusCode: next?.order_status_code ?? null,
    before: { orderStatusId: order.orderStatusId },
    after: { orderStatusId: nextStatusId },
    diff: { orderStatusId: { before: order.orderStatusId, after: nextStatusId } },
    metadata: { origin: 'order_rework', outboxIdempotencyKey: idempotencyKey },
  });
  await enqueueOutbox(tx, 'order.status_changed', order, idempotencyKey, {
    actorUserId: currentUser.id,
    requestId,
    orderStatusId: nextStatusId,
    orderStatusIdBefore: order.orderStatusId,
    orderStatusIdAfter: nextStatusId,
    action: 'order_status_change',
    origin: 'order_rework',
  });
}

async function reconcileIdempotency(
  tx: TransactionClient,
  command: CommandBase,
  commandName: string,
  requestShape: Record<string, unknown>,
): Promise<OrderReworkCommandResultDto | null> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ actorUserId: command.currentUser.id, commandName, ...requestShape }))
    .digest('hex');
  const inserted = await tx.query(
    `INSERT INTO command_idempotency_keys (
       idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
     ) VALUES ($1, $2, $3, 'order', $4, $5, 'processing')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [command.idempotencyKey, commandName, actorId(command.currentUser), String(command.orderId), requestHash],
  );
  if (inserted.rows[0]) return null;
  const row = (await tx.query<IdempotencyRow>(
    `SELECT request_hash, response_json, status, created_at
     FROM command_idempotency_keys WHERE idempotency_key = $1 FOR UPDATE`,
    [command.idempotencyKey],
  )).rows[0];
  if (!row) {
    throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', { idempotencyKey: command.idempotencyKey });
  }
  if (row.request_hash !== requestHash) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', { idempotencyKey: command.idempotencyKey });
  }
  if (row.status === 'completed' && row.response_json) {
    return typeof row.response_json === 'string' ? JSON.parse(row.response_json) : row.response_json;
  }
  if (row.status === 'failed' || (row.created_at && Date.now() - new Date(row.created_at).getTime() > IDEMPOTENCY_STALE_MS)) {
    throw new ApiError(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', { idempotencyKey: command.idempotencyKey });
  }
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', { idempotencyKey: command.idempotencyKey });
}

async function completeIdempotency(tx: TransactionClient, key: string, response: OrderReworkCommandResultDto): Promise<void> {
  await tx.query(
    `UPDATE command_idempotency_keys
     SET status = 'completed', response_json = $2::jsonb, completed_at = now()
     WHERE idempotency_key = $1`,
    [key, JSON.stringify(response)],
  );
}

// ---------------------------------------------------------------- mapping

function requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
  if (!currentUser.permissions.includes(permission)) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
      requiredPermissions: [permission],
    });
  }
}

function policySubject(row: { order_id: string | number; created_by: string | number | null; manager_id: string | number | null }) {
  return {
    orderId: Number(row.order_id),
    createdByUserId: row.created_by === null ? null : String(row.created_by),
    managerUserId: row.manager_id === null ? null : String(row.manager_id),
  };
}

function mapReason(row: ReasonRow): OrderReworkReasonDto {
  return {
    reasonId: Number(row.order_rework_reason_id),
    code: row.code,
    name: row.name,
    requiresComment: row.requires_comment === true,
    sortOrder: Number(row.sort_order),
  };
}

function actorId(currentUser: CurrentUser): number | null {
  const id = Number(currentUser.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function actorAudit(currentUser: CurrentUser) {
  return {
    actorUserId: currentUser.id,
    actorUsername: currentUser.username ?? null,
    actorRole: currentUser.role ?? null,
  };
}

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
