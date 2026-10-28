import { z } from 'zod';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import {
  ORDER_SNAPSHOT_FORMAT_VERSION,
  type OrderSnapshotDto,
  type OrderSnapshotProductionRoundDto,
  type OrderSnapshotProductionRoundsDto,
} from '../dto/order-snapshot.dto';

/**
 * «Переделка» (plan §6.2): production rounds in the order JSON snapshot.
 * Export carries rounds only for orders that have them (format 1.1.0); import
 * restores them only when a NEW order is created from the snapshot.
 */

type AnyRow = QueryResultRow & Record<string, unknown>;

const smallint = z.number().int().min(1).max(32767);
const isoTimestamp = z.string().min(1).max(64).refine((value) => !Number.isNaN(Date.parse(value)));
const sourceId = z.string().min(1).max(200);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const userId = z.number().int().positive().nullable();

const roundSchema = z.object({
  roundNo: smallint.min(2),
  mode: z.enum(['after_ready', 'in_production']),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  reasonName: z.string().max(100),
  reasonComment: z.string().max(2000).nullable(),
  fromOrderStatusId: z.number().int().positive(),
  fromOrderProductionRound: smallint,
  source: z.enum(['manual', 'auto_cut_repeat', 'import']),
  sourceCutJobId: z.string().max(40).nullable(),
  sourcePacketId: z.string().max(40).nullable(),
  startedAt: isoTimestamp,
  startedBy: userId,
  reasonClarifiedAt: isoTimestamp.nullable(),
  reasonClarifiedBy: userId,
  closedAt: isoTimestamp.nullable(),
  closedBy: userId,
  closeReason: z.enum(['ready', 'issued', 'completed', 'false_positive']).nullable(),
  eventSeq: z.number().int().min(0).max(32767),
  // «Переделка» 1.1 — optional (older snapshots have none).
  plannedCompletionDate: dateOnly.nullable().optional(),
  plannedCompletionSource: z.enum(['schedule', 'manual']).nullable().optional(),
  suggestedPlannedCompletionDate: dateOnly.nullable().optional(),
  fromPlannedCompletionDate: dateOnly.nullable().optional(),
  fromCompletionDate: dateOnly.nullable().optional(),
  details: z.array(z.object({
    detailSourceId: sourceId,
    fromProductionStatusId: z.number().int().positive().nullable(),
    fromProductionRound: smallint,
    fromProductionStatusSort: z.number().int().min(-32768).max(32767).nullable(),
    toProductionStatusId: z.number().int().positive(),
    addedAt: isoTimestamp,
    addedBySource: z.enum(['start', 'extend']),
  }).strict()).max(5000),
  sources: z.array(z.object({
    detailSourceId: sourceId,
    sourceKind: z.string().min(1).max(100),
    sourceId: z.string().min(1).max(200),
    sourceRevision: z.string().min(1).max(200),
    createdAt: isoTimestamp,
  }).strict()).max(5000),
}).strict();

const roundsSchema = z.object({
  productionRound: smallint,
  lastRoundNo: smallint,
  detailRounds: z.array(z.object({ detailSourceId: sourceId, productionRound: smallint.min(2) }).strict()).max(5000),
  rounds: z.array(roundSchema).max(500),
}).strict();

function invalid(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(422, 'SNAPSHOT_ROUNDS_INVALID', message, details);
}

/** True when the snapshot restores production rounds (fence + markers are required). */
export function snapshotHasProductionRounds(snapshot: OrderSnapshotDto): boolean {
  return (snapshot.data.productionRounds?.rounds.length ?? 0) > 0;
}

/**
 * Pure structural validation against the round model (§5.4): unique rounds, at most
 * one open round and the order's current round equal to it, every round/detail/event
 * round number either 1 or an exported round. Runs before any database write.
 */
export function validateSnapshotProductionRounds(snapshot: OrderSnapshotDto): void {
  const data = snapshot.data;
  const eventRounds = data.productionStatusEvents.filter((event) => event.roundNo !== undefined);
  if (snapshot.formatVersion === ORDER_SNAPSHOT_FORMAT_VERSION) {
    if (data.productionRounds !== undefined || eventRounds.length > 0) {
      throw invalid('Круги производства допустимы только в формате 1.1.0');
    }
    return;
  }
  const parsed = roundsSchema.safeParse(data.productionRounds ?? { productionRound: 1, lastRoundNo: 1, detailRounds: [], rounds: [] });
  if (!parsed.success) throw invalid('Некорректные круги производства в снимке заказа');
  const state = parsed.data;
  const roundNos = new Set<number>();
  for (const round of state.rounds) {
    if (roundNos.has(round.roundNo)) throw invalid('Повтор номера круга', { roundNo: round.roundNo });
    roundNos.add(round.roundNo);
    if ((round.closedAt === null) !== (round.closeReason === null)) throw invalid('Закрытие круга без причины', { roundNo: round.roundNo });
  }
  const known = (round: number) => round === 1 || roundNos.has(round);
  const byNo = new Map(state.rounds.map((round) => [round.roundNo, round]));
  // A live (non «Это не переделка») round: false_positive returns order and details to their previous round.
  const live = (round: number) => round === 1 || (byNo.has(round) && byNo.get(round)?.closeReason !== 'false_positive');
  for (const round of state.rounds) {
    // Before-state (what «Это не переделка» restores) references only live earlier rounds:
    // a round only starts from the order's live round and only the open round is cancelled.
    if (round.fromOrderProductionRound >= round.roundNo || !live(round.fromOrderProductionRound)) {
      throw invalid('Круг ссылается на несуществующий, отменённый или более поздний круг', { roundNo: round.roundNo });
    }
  }
  const open = state.rounds.filter((round) => round.closedAt === null);
  if (open.length > 1) throw invalid('Больше одного открытого круга');
  if (open.length === 1 && state.productionRound !== open[0].roundNo) {
    throw invalid('Текущий круг заказа не совпадает с открытым кругом', { productionRound: state.productionRound });
  }
  if (!live(state.productionRound)) throw invalid('Текущий круг заказа не описан', { productionRound: state.productionRound });
  const maxRound = Math.max(1, ...roundNos);
  if (state.lastRoundNo < state.productionRound) throw invalid('lastRoundNo меньше текущего круга');

  const details = new Set(data.details.map((detail) => detail.sourceId));
  const seenDetails = new Set<string>();
  for (const detail of state.detailRounds) {
    if (!details.has(detail.detailSourceId) || seenDetails.has(detail.detailSourceId)) {
      throw invalid('Круг указан для неизвестной или повторной детали', { detailSourceId: detail.detailSourceId });
    }
    seenDetails.add(detail.detailSourceId);
    if (!live(detail.productionRound) || detail.productionRound > state.productionRound) {
      throw invalid('Некорректный круг детали', { detailSourceId: detail.detailSourceId });
    }
  }
  // Effective current round of every exported detail (omitted → 1), reconciled with membership.
  const currentRound = new Map(state.detailRounds.map((detail) => [detail.detailSourceId, detail.productionRound]));
  const members = new Map<number, Set<string>>();
  for (const round of state.rounds) {
    const roundDetails = new Set<string>();
    for (const detail of round.details) {
      if (!details.has(detail.detailSourceId) || roundDetails.has(detail.detailSourceId)) {
        throw invalid('Деталь круга не найдена в снимке или повторяется', { roundNo: round.roundNo, detailSourceId: detail.detailSourceId });
      }
      roundDetails.add(detail.detailSourceId);
      if (detail.fromProductionRound >= round.roundNo || !live(detail.fromProductionRound)) {
        throw invalid('Деталь круга ссылается на несуществующий, отменённый или более поздний круг', { roundNo: round.roundNo });
      }
      // A member of a live round is at least in that round (a later round may carry it further).
      if (round.closeReason !== 'false_positive' && (currentRound.get(detail.detailSourceId) ?? 1) < round.roundNo) {
        throw invalid('Деталь круга не находится в этом круге', { roundNo: round.roundNo, detailSourceId: detail.detailSourceId });
      }
    }
    members.set(round.roundNo, roundDetails);
    for (const source of round.sources) {
      if (!details.has(source.detailSourceId)) throw invalid('Источник круга ссылается на неизвестную деталь', { roundNo: round.roundNo });
    }
  }
  for (const [detailSourceId, round] of currentRound) {
    if (!members.get(round)?.has(detailSourceId)) {
      throw invalid('Деталь указана в круге, в который она не добавлялась', { detailSourceId, productionRound: round });
    }
  }
  for (const round of state.rounds) {
    for (const detail of round.details) {
      // The detail's previous round (restored by «Это не переделка») must be a round it belonged to.
      if (detail.fromProductionRound > 1 && !members.get(detail.fromProductionRound)?.has(detail.detailSourceId)) {
        throw invalid('Прежний круг детали не содержит эту деталь', { roundNo: round.roundNo, detailSourceId: detail.detailSourceId });
      }
    }
  }
  // «Это не переделка» of the open round must itself leave a valid state: validate the
  // cancelled state (order/details back to their before-state, round closed false_positive)
  // with the same rules (membership in every remaining live round, lower bounds included).
  if (open.length === 1) {
    const cancelled = open[0];
    const restored = new Map(currentRound);
    for (const detail of cancelled.details) restored.set(detail.detailSourceId, detail.fromProductionRound);
    try {
      validateSnapshotProductionRounds({
        ...snapshot,
        data: {
          ...data,
          productionStatusEvents: [],
          productionRounds: {
            ...state,
            productionRound: cancelled.fromOrderProductionRound,
            detailRounds: [...restored].filter(([, round]) => round > 1)
              .map(([detailSourceId, productionRound]) => ({ detailSourceId, productionRound })),
            rounds: state.rounds.map((round) => round === cancelled
              ? { ...round, closedAt: round.startedAt, closeReason: 'false_positive' as const }
              : round),
          },
        },
      });
    } catch (error) {
      throw invalid('Отмена открытого круга («Это не переделка») даст несогласованное состояние', {
        cause: error instanceof ApiError ? error.message : 'invalid',
      });
    }
  }
  for (const event of eventRounds) {
    if (!Number.isInteger(event.roundNo) || !known(event.roundNo as number) || (event.roundNo as number) > maxRound) {
      throw invalid('Событие этапа ссылается на неизвестный круг', { eventSourceId: event.sourceId });
    }
  }
}

/** Reads the round state of an exported order; undefined for an order that never had rounds. */
export async function readSnapshotProductionRounds(
  tx: TransactionClient,
  orderId: number,
  header: AnyRow,
  exportedDetails: AnyRow[],
): Promise<OrderSnapshotProductionRoundsDto | undefined> {
  const lastRoundNo = Number(header.last_round_no ?? 1);
  const rounds = (await tx.query<AnyRow>(
    `SELECT r.*, reason.code AS reason_code, reason.name AS reason_name,
            r.planned_completion_date::text AS planned_completion_text,
            r.suggested_planned_completion_date::text AS suggested_planned_completion_text,
            r.from_planned_completion_date::text AS from_planned_completion_text,
            r.from_completion_date::text AS from_completion_text
     FROM order_production_rounds r
     JOIN order_rework_reasons reason ON reason.order_rework_reason_id = r.reason_id
     WHERE r.order_id = $1
     ORDER BY r.round_no`,
    [orderId],
  )).rows;
  if (rounds.length === 0 && lastRoundNo <= 1) return undefined;

  // Soft-deleted details are not exported, so their round rows are not either.
  const exported = new Set(exportedDetails.map((detail) => String(detail.detail_id)));
  const roundIds = rounds.map((round) => Number(round.order_production_round_id));
  const roundDetails = roundIds.length === 0 ? [] : (await tx.query<AnyRow>(
    `SELECT * FROM order_production_round_details
     WHERE order_production_round_id = ANY($1::bigint[])
     ORDER BY order_production_round_id, detail_id`,
    [roundIds],
  )).rows.filter((row) => exported.has(String(row.detail_id)));
  const roundSources = roundIds.length === 0 ? [] : (await tx.query<AnyRow>(
    `SELECT * FROM order_production_round_sources
     WHERE order_production_round_id = ANY($1::bigint[])
     ORDER BY order_production_round_id, detail_id, source_kind, source_id, source_revision`,
    [roundIds],
  )).rows.filter((row) => exported.has(String(row.detail_id)));

  return {
    productionRound: Number(header.production_round ?? 1),
    lastRoundNo,
    detailRounds: exportedDetails
      .filter((detail) => Number(detail.production_round ?? 1) > 1)
      .map((detail) => ({ detailSourceId: String(detail.detail_id), productionRound: Number(detail.production_round) })),
    rounds: rounds.map((round): OrderSnapshotProductionRoundDto => {
      const id = String(round.order_production_round_id);
      return {
        roundNo: Number(round.round_no),
        mode: round.mode as OrderSnapshotProductionRoundDto['mode'],
        reasonCode: String(round.reason_code),
        reasonName: String(round.reason_name),
        reasonComment: nullableString(round.reason_comment),
        fromOrderStatusId: Number(round.from_order_status_id),
        fromOrderProductionRound: Number(round.from_order_production_round),
        source: round.source as OrderSnapshotProductionRoundDto['source'],
        sourceCutJobId: nullableString(round.source_cut_job_id),
        sourcePacketId: nullableString(round.source_packet_id),
        startedAt: isoString(round.started_at),
        startedBy: nullableNumber(round.started_by),
        reasonClarifiedAt: nullableIso(round.reason_clarified_at),
        reasonClarifiedBy: nullableNumber(round.reason_clarified_by),
        closedAt: nullableIso(round.closed_at),
        closedBy: nullableNumber(round.closed_by),
        closeReason: (round.close_reason ?? null) as OrderSnapshotProductionRoundDto['closeReason'],
        eventSeq: Number(round.event_seq),
        plannedCompletionDate: nullableString(round.planned_completion_text),
        plannedCompletionSource: (round.planned_completion_source ?? null) as OrderSnapshotProductionRoundDto['plannedCompletionSource'],
        suggestedPlannedCompletionDate: nullableString(round.suggested_planned_completion_text),
        fromPlannedCompletionDate: nullableString(round.from_planned_completion_text),
        fromCompletionDate: nullableString(round.from_completion_text),
        details: roundDetails.filter((row) => String(row.order_production_round_id) === id).map((row) => ({
          detailSourceId: String(row.detail_id),
          fromProductionStatusId: nullableNumber(row.from_production_status_id),
          fromProductionRound: Number(row.from_production_round),
          fromProductionStatusSort: nullableNumber(row.from_production_status_sort),
          toProductionStatusId: Number(row.to_production_status_id),
          addedAt: isoString(row.added_at),
          addedBySource: row.added_by_source as 'start' | 'extend',
        })),
        sources: roundSources.filter((row) => String(row.order_production_round_id) === id).map((row) => ({
          detailSourceId: String(row.detail_id),
          sourceKind: String(row.source_kind),
          sourceId: String(row.source_id),
          sourceRevision: String(row.source_revision),
          createdAt: isoString(row.created_at),
        })),
      };
    }),
  };
}

/**
 * §5.4 status model on the LOCAL (remapped) order status: an open round is allowed
 * with any status except «Готов к выдаче»/«Выдан»/«Завершен» (legacy_6/7/8);
 * «Переделка» requires an open round.
 */
export async function assertSnapshotRoundStatusModel(tx: TransactionClient, snapshot: OrderSnapshotDto): Promise<void> {
  const code = (await tx.query<{ code: string | null }>(
    'SELECT order_status_code AS code FROM order_statuses WHERE order_status_id = $1',
    [snapshot.data.order.orderStatusId],
  )).rows[0]?.code ?? null;
  const open = (snapshot.data.productionRounds?.rounds ?? []).some((round) => round.closedAt === null);
  if (open && (code === 'legacy_6' || code === 'legacy_7' || code === 'legacy_8')) {
    throw invalid('Открытый круг при статусе готового/выданного/завершённого заказа');
  }
  if (!open && code === 'rework') {
    throw invalid('Статус «Переделка» без открытого круга');
  }
  // A round never starts from «Переделка» (with an open round it is an extension), and
  // «Это не переделка» of an after_ready round restores fromOrderStatusId: that status
  // must be valid without an open round.
  const rounds = snapshot.data.productionRounds?.rounds ?? [];
  const fromIds = [...new Set(rounds.map((round) => round.fromOrderStatusId))];
  if (fromIds.length > 0) {
    const fromCodes = (await tx.query<{ id: string | number; code: string | null }>(
      'SELECT order_status_id AS id, order_status_code AS code FROM order_statuses WHERE order_status_id = ANY($1::int[])',
      [fromIds],
    )).rows;
    if (fromCodes.some((row) => row.code === 'rework')) {
      throw invalid('Круг начат из статуса «Переделка»: отмена круга оставит «Переделку» без открытого круга');
    }
  }
  // The status «Это не переделка» leaves (after_ready → fromOrderStatusId, in_production →
  // current status) must be valid without an open round, i.e. not «Переделка».
  const openRound = rounds.find((round) => round.closedAt === null);
  if (openRound && openRound.mode === 'in_production' && code === 'rework') {
    throw invalid('Открытый круг без смены статуса при статусе «Переделка»: отмена оставит «Переделку» без круга');
  }
}

/** Resolves every round reason by code; an unknown code is a 422 (reasons are local catalogues). */
export async function resolveSnapshotReworkReasons(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
): Promise<Map<string, number>> {
  const codes = [...new Set((snapshot.data.productionRounds?.rounds ?? []).map((round) => round.reasonCode))];
  if (codes.length === 0) return new Map();
  const rows = (await tx.query<{ code: string; id: string | number }>(
    'SELECT code, order_rework_reason_id AS id FROM order_rework_reasons WHERE code = ANY($1::text[])',
    [codes],
  )).rows;
  const byCode = new Map(rows.map((row) => [row.code, Number(row.id)]));
  const missing = codes.filter((code) => !byCode.has(code));
  if (missing.length > 0) {
    throw new ApiError(422, 'SNAPSHOT_REWORK_REASON_UNKNOWN', 'В справочнике нет причины переделки из снимка', { reasonCodes: missing });
  }
  return byCode;
}

/** Sets the order's round counters right after the header insert (new order only). */
export async function restoreSnapshotOrderRound(tx: TransactionClient, snapshot: OrderSnapshotDto, orderId: number): Promise<void> {
  const state = snapshot.data.productionRounds;
  if (!state) return;
  const lastRoundNo = Math.max(state.lastRoundNo, state.productionRound, ...state.rounds.map((round) => round.roundNo));
  await tx.query(
    'UPDATE orders SET production_round = $2, last_round_no = $3 WHERE order_id = $1',
    [orderId, state.productionRound, lastRoundNo],
  );
}

/**
 * Restores detail rounds and round rows after details/events are imported. The
 * deferred round/status consistency constraint checks the result at commit.
 */
export async function restoreSnapshotProductionRounds(
  tx: TransactionClient,
  snapshot: OrderSnapshotDto,
  orderId: number,
  detailIds: Map<string, number>,
  reasonIds: Map<string, number>,
): Promise<number> {
  const state = snapshot.data.productionRounds;
  if (!state) return 0;
  const localDetail = (source: string) => {
    const id = detailIds.get(source);
    if (!id) throw invalid('Деталь круга не импортирована', { detailSourceId: source });
    return id;
  };
  for (const detail of state.detailRounds) {
    await tx.query(
      'UPDATE order_details SET production_round = $2 WHERE detail_id = $1 AND order_id = $3',
      [localDetail(detail.detailSourceId), detail.productionRound, orderId],
    );
  }
  for (const round of state.rounds) {
    const roundId = Number((await tx.query<{ id: string | number }>(
      `INSERT INTO order_production_rounds (
         order_id, round_no, mode, reason_id, reason_comment, from_order_status_id, from_order_production_round,
         source, source_cut_job_id, source_packet_id, started_at, started_by, reason_clarified_at,
         reason_clarified_by, closed_at, closed_by, close_reason, event_seq, request_id, idempotency_key,
         planned_completion_date, planned_completion_source, suggested_planned_completion_date,
         from_planned_completion_date, from_completion_date
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10::bigint, $11, $12, $13, $14, $15, $16, $17, $18, NULL, NULL,
         $19::date, $20, $21::date, $22::date, $23::date)
       RETURNING order_production_round_id AS id`,
      [
        orderId, round.roundNo, round.mode, reasonIds.get(round.reasonCode), round.reasonComment,
        round.fromOrderStatusId, round.fromOrderProductionRound, round.source, round.sourceCutJobId,
        round.sourcePacketId, round.startedAt, round.startedBy, round.reasonClarifiedAt,
        round.reasonClarifiedBy, round.closedAt, round.closedBy, round.closeReason, round.eventSeq,
        round.plannedCompletionDate ?? null, round.plannedCompletionDate ? round.plannedCompletionSource ?? 'manual' : null,
        round.suggestedPlannedCompletionDate ?? null, round.fromPlannedCompletionDate ?? null, round.fromCompletionDate ?? null,
      ],
    )).rows[0].id);
    for (const detail of round.details) {
      await tx.query(
        `INSERT INTO order_production_round_details (
           order_production_round_id, detail_id, from_production_status_id, from_production_round,
           from_production_status_sort, to_production_status_id, added_at, added_by_source
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [roundId, localDetail(detail.detailSourceId), detail.fromProductionStatusId, detail.fromProductionRound,
          detail.fromProductionStatusSort, detail.toProductionStatusId, detail.addedAt, detail.addedBySource],
      );
    }
    for (const source of round.sources) {
      await tx.query(
        `INSERT INTO order_production_round_sources (
           order_production_round_id, detail_id, source_kind, source_id, source_revision, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [roundId, localDetail(source.detailSourceId), source.sourceKind, source.sourceId, source.sourceRevision, source.createdAt],
      );
    }
  }
  return state.rounds.length;
}

/** Marks the order's newest round «final deadline to be reconciled» (281; a no-op on a database without it). */
export async function requestRoundDeadlineSync(tx: TransactionClient, orderId: number, actorUserId: string, requestId: string): Promise<void> {
  const present = await tx.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'order_production_rounds' AND column_name = 'deadline_sync_requested_by') AS present`,
  );
  if (!present.rows[0]?.present) return;
  const actor = Number(actorUserId);
  await tx.query(
    `UPDATE order_production_rounds
        SET deadline_sync_requested_at = now(), deadline_sync_request_id = $2, deadline_sync_requested_by = $3
      WHERE order_id = $1 AND round_no = (SELECT max(round_no) FROM order_production_rounds WHERE order_id = $1)`,
    [orderId, requestId, Number.isSafeInteger(actor) && actor > 0 ? actor : null],
  );
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function isoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : isoString(value);
}
