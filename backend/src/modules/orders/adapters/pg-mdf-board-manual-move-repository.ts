import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { loadReturnSnapshot, returnSourceOwners } from './mdf-return-snapshot';
import { auditService } from '../../../common/audit/audit.service';
import type { AuditRelatedEntity } from '../../../common/audit/audit-event.types';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { observeMdfShadowCommand } from '../../mdf-board/application/mdf-shadow';
import { requireMdfCommandBoundary } from '../../mdf-board/application/mdf-command-boundary';
import { executeMdfManualCommand } from '../../mdf-board/adapters/mdf-manual-command';
import { loadCncBazisCutSetBoardColumn, loadCncPacketBoardColumn } from '../../cnc-telegram/adapters/pg-cnc-telegram-repository';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE,
  cncPacketCountsForMdfReadinessSql } from '../../../shared/cnc-material';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { allowsScopeSet, policyScopeSetsForUser, scopeSetHas } from '../../../permissions/policies/scope';
import type { MdfBoardEventInput } from '../../status-automation/application/mdf-board-event.types';
import {
  dispatchMdfBoardEvent,
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
    const mdf = { writer: 'mdf.manual.upsert',capability: 'queued' } as const;
    return this.database.transaction(async (tx) => {
      if ((await requireMdfCommandBoundary(tx,mdf)).queued) {
        // The new MDF board has no order cards (only packets, BASIS sets and baths): explicit refusal, not 503.
        if (command.cardKind === 'order') throw new ApiError(409, 'MDF_ORDER_CARD_NOT_SUPPORTED',
          'В новом производственном учёте заказ не является карточкой МДФ-доски — переносите файлы, наборы и ванны');
        const route = await routeQueuedCommand(tx, command);
        if (route.route === 'replay') return route.response;
        if (route.route === 'non_mdf') return executeNonMdfPlacement(tx, command);
        return executeMdfManualCommand(tx,command);
      }
      await setSessionUser(tx, command.currentUser.id);
      if (command.cardKind !== 'order') {
        await tx.query('SET LOCAL jit=off');
        const source = { kind: command.cardKind, id: command.cardId };
        let card: {column:string} | undefined;
        try {
          const owners = await returnSourceOwners(tx, source.kind, source.id);
          const snapshot = await loadReturnSnapshot(tx, source, owners);
          card = snapshot.cards.find(c => c.kind === source.kind && c.id === source.id);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'MDF_RETURN_UNRESOLVED') throw error;
          // A completely unlinked card cannot auto-complete from ERP details. Preserve its
          // existing forward/manual workflow without weakening the correction endpoint.
          const unresolved=await tx.query<{column:string}>(`WITH source AS (
            SELECT 'packet' AS kind,packet_id::text AS id,
              CASE WHEN completion_status='completed' OR thumbs_up=true THEN 'completed' ELSE 'parsed' END AS automatic
              FROM cnc_telegram_packets WHERE $1='packet' AND packet_id::text=$2
            UNION ALL SELECT 'bazisCutSet',bazis_cut_set_id::text,'parsed' FROM bazis_cut_sets
              WHERE $1='bazisCutSet' AND bazis_cut_set_id::text=$2
            UNION ALL SELECT 'bath','cut-result:' || cut_result_id::text,'baths' FROM cut_result
              WHERE $1='bath' AND ('cut-result:' || cut_result_id::text)=$2)
            SELECT COALESCE(m.target_column,s.automatic) AS column FROM source s LEFT JOIN mdf_board_manual_moves m
              ON m.card_kind=s.kind AND m.card_id=s.id`,[source.kind,source.id]);
          card=unresolved.rows[0];
        }
        if (!card) throw new ApiError(422, 'MDF_RETURN_SOURCE_UNAVAILABLE', 'Карточка не найдена');
        const sequence = source.kind === 'bath'
          ? ['baths', 'baths_ready', 'baths_laminated', 'completed_baths']
          : ['parsed', 'completed', 'completed_laminated'];
        if (sequence.indexOf(command.targetColumn) < sequence.indexOf(card.column)) {
          throw new ApiError(409, 'MDF_RETURN_CONFIRMATION_REQUIRED', 'Возврат требует предпросмотра и подтверждения изменения производственных данных');
        }
      }
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
      if (command.cardKind !== 'order') {
        if (command.cardKind === 'packet' && ['completed', 'completed_laminated'].includes(command.targetColumn)) {
          await tx.query(`UPDATE cnc_telegram_packets SET mdf_completion_returned=false
            WHERE packet_id::text=$1 AND mdf_completion_returned=true`, [command.cardId]);
        }
        const event: MdfBoardEventInput = {
          source: { kind: command.cardKind, id: command.cardId },
          actor: command.currentUser,
          requestId: command.requestId ?? 'mdf-board-manual-move',
          sourceIdempotencyKey: `mdf-board:manual:${command.cardKind}:${command.cardId}:version-${saved.version}:${command.targetColumn}:audit-${auditId}`,
        };
        await observeMdfShadowCommand(tx, event, { kind: 'manual_move', targetColumn: command.targetColumn, auditId });
        await dispatchMdfBoardEvent(tx, event);
      }
      return {
        generatedAt: new Date().toISOString(),
        changed: true,
        move: saved,
        auditId,
      };
    }, { mdf });
  }

  async delete(command: DeleteMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveDeleteResponseDto> {
    const mdf = { writer: 'mdf.manual.clear',capability: 'queued' } as const;
    return this.database.transaction(async (tx) => {
      if ((await requireMdfCommandBoundary(tx,mdf)).queued) {
        // The new MDF board has no order cards (only packets, BASIS sets and baths): explicit refusal, not 503.
        if (command.cardKind === 'order') throw new ApiError(409, 'MDF_ORDER_CARD_NOT_SUPPORTED',
          'В новом производственном учёте заказ не является карточкой МДФ-доски — переносите файлы, наборы и ванны');
        if ((await routeQueuedCommand(tx, command)).route !== 'engine') {
          throw new ApiError(409, 'MDF_NON_MDF_RETURN_UNSUPPORTED', NON_MDF_RETURN_MESSAGE);
        }
        return executeMdfManualCommand(tx,command);
      }
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
        relatedEntities: relatedEntities(command.cardKind, command.cardId,
          await loadRelatedOrderIds(tx, command.cardKind, command.cardId)),
      });
      if (command.cardKind !== 'order') {
        const event: MdfBoardEventInput = {
          source: { kind: command.cardKind, id: command.cardId }, actor: command.currentUser,
          requestId: command.requestId ?? 'mdf-board-manual-move',
          sourceIdempotencyKey: `mdf-board:manual-delete:${command.cardKind}:${command.cardId}:${auditId}`,
        };
        await observeMdfShadowCommand(tx, event, { kind: 'manual_clear', targetColumn: null, auditId });
        await dispatchMdfBoardEvent(tx, event);
      }
      return {
        generatedAt: new Date().toISOString(),
        cardKind: command.cardKind,
        cardId: command.cardId,
        deleted: true,
        auditId,
      };
    }, { mdf });
  }
}

const NON_MDF_RETURN_MESSAGE = 'Возврат карточки не из МДФ при новом учёте недоступен — обратитесь к администратору';
const NON_MDF_PACKET_COLUMNS = ['parsed', 'completed', 'completed_laminated'] as const;
type NonMdfPacketColumn = typeof NON_MDF_PACKET_COLUMNS[number];
type QueuedPacketRoute =
  | { route: 'engine' }
  | { route: 'non_mdf' }
  | { route: 'replay'; response: MdfBoardManualMoveUpsertResponseDto };

interface NonMdfReplayPayload {
  nonMdf: true; requestDigest: string; orderIds: number[]; response: MdfBoardManualMoveUpsertResponseDto;
}

/** Engine active (queued boundary): a machine file of another material (HDF, chipboard…) is outside the engine. It
 * keeps its forward manual placement through `executeNonMdfPlacement` (a BASIS set with no MDF detail likewise);
 * everything else stays the engine's.
 * The replay of an earlier command is resolved BEFORE routing and for EVERY card kind (both replay stores share the
 * actor's key space), so a lost response survives a later material/head change and a key never runs twice. No source
 * lock is taken here (lock order: owners → source, see the command). */
async function routeQueuedCommand(
  tx: TransactionClient,
  command: UpsertMdfBoardManualMoveCommand | DeleteMdfBoardManualMoveCommand,
): Promise<QueuedPacketRoute> {
  const key = command.idempotencyKey;
  if (key && /^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    // Same command-key lock as the engine command: equal keys serialize across both paths.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `mdf-manual-command:${JSON.stringify([command.currentUser.id, key])}`]);
    const engineReplay = await tx.query(`SELECT 1 FROM mdf_manual_command_results
      WHERE actor_user_id=$1 AND command_key=$2`, [command.currentUser.id, key]);
    if (engineReplay.rows.length) return { route: 'engine' };
    const replay = (await tx.query<{ payload: NonMdfReplayPayload }>(`SELECT payload_json payload FROM outbox_events
      WHERE idempotency_key=$1`, [nonMdfPlacementKey(command.currentUser, key)])).rows[0]?.payload;
    if (replay?.nonMdf === true) {
      if ((command.cardKind !== 'packet' && command.cardKind !== 'bazisCutSet') || !('targetColumn' in command)
        || replay.requestDigest !== nonMdfRequestDigest(command)) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Ключ повтора уже использован для другой команды');
      }
      // Authorization is rechecked for every replay; the recorded owners, not the current ones.
      await authorizeNonMdfOwners(tx, command.currentUser, replay.orderIds);
      return { route: 'replay', response: replay.response };
    }
  }
  if (command.cardKind !== 'packet' && command.cardKind !== 'bazisCutSet') return { route: 'engine' };
  return (await classifyQueuedNonMdf(tx, command.cardKind, command.cardId)) === 'non_mdf'
    ? { route: 'non_mdf' } : { route: 'engine' };
}

type NonMdfCardKind = 'packet' | 'bazisCutSet';

async function classifyQueuedNonMdf(tx: TransactionClient, kind: NonMdfCardKind, id: string): Promise<'engine' | 'non_mdf'> {
  return kind === 'packet' ? classifyQueuedPacket(tx, id) : classifyQueuedBazisCutSet(tx, id);
}

/** `non_mdf`: a BASIS set with no MDF detail (e.g. ХДФ only) AND no engine ownership — the same rule as the board's
 * non-MDF set card. A set with any MDF detail, or with an engine head carrying demand (e.g. an intentional-empty set after
 * a composition command removed its last MDF row), belongs to the engine and is validated there. */
async function classifyQueuedBazisCutSet(tx: TransactionClient, setId: string): Promise<'engine' | 'non_mdf'> {
  const row = (await tx.query<{ mdf: boolean; owned: boolean }>(`SELECT EXISTS (SELECT 1 FROM bazis_cut_set_details d
        WHERE d.bazis_cut_set_id=s.bazis_cut_set_id
          AND COALESCE(d.material_name,'') ~* '${CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE}'
          AND COALESCE(d.material_name,'') !~* '${CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE}') mdf,
      EXISTS (SELECT 1 FROM mdf_source_heads h JOIN mdf_revision_demand d ON d.source_kind=h.source_kind
        AND d.source_id=h.source_id AND d.revision_key IN (h.received_revision_key, h.accepted_revision_key)
        WHERE h.source_kind='bazisCutSet' AND h.source_id=s.bazis_cut_set_id::text) owned
    FROM bazis_cut_sets s WHERE s.bazis_cut_set_id::text=$1`, [setId])).rows[0];
  return !row || row.mdf || row.owned ? 'engine' : 'non_mdf';
}

/** `non_mdf`: another material AND no engine ownership. A head whose revisions have no demand is diagnostic (shadow
 * capture of an excluded material), not ownership. A non-MDF file whose head carries demand needs reconciliation. */
async function classifyQueuedPacket(tx: TransactionClient, packetId: string): Promise<'engine' | 'non_mdf'> {
  const row = (await tx.query<{ mdf: boolean; owned: boolean }>(`SELECT ${cncPacketCountsForMdfReadinessSql('p')} mdf,
      EXISTS (SELECT 1 FROM mdf_source_heads h JOIN mdf_revision_demand d ON d.source_kind=h.source_kind
        AND d.source_id=h.source_id AND d.revision_key IN (h.received_revision_key, h.accepted_revision_key)
        WHERE h.source_kind='packet' AND h.source_id=p.packet_id::text) owned
    FROM cnc_telegram_packets p WHERE p.packet_id::text=$1`, [packetId])).rows[0];
  if (!row || row.mdf) return 'engine';
  if (row.owned) throw new ApiError(409, 'MDF_COMMAND_RECONCILIATION_REQUIRED', 'Состав карточки требует проверки');
  return 'non_mdf';
}

/** Forward placement of a non-MDF machine file or BASIS set under the active engine. Lock order matches the engine
 * command: boundary → command key → owner orders → `mdf-source` → head → source row; routing is revalidated under the
 * locks and a changed source fails with `MDF_SOURCE_STALE` instead of switching paths inside the transaction. */
async function executeNonMdfPlacement(
  tx: TransactionClient,
  command: UpsertMdfBoardManualMoveCommand,
): Promise<MdfBoardManualMoveUpsertResponseDto> {
  const user = command.currentUser;
  if (!user.permissions.includes('production.tasks.update')) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Нет права изменять производственные карточки');
  }
  if (!command.idempotencyKey || !/^[A-Za-z0-9._:-]{1,128}$/.test(command.idempotencyKey)) {
    throw new ApiError(409, 'MDF_IDEMPOTENCY_KEY_REQUIRED', 'Команда требует уникального ключа повтора');
  }
  const target = command.targetColumn as NonMdfPacketColumn;
  const expected = command.expectedColumn;
  if (!NON_MDF_PACKET_COLUMNS.includes(target) || !expected) {
    throw new ApiError(409, 'MDF_SOURCE_STALE', 'Карточка изменилась. Обновите доску');
  }
  if (NON_MDF_PACKET_COLUMNS.indexOf(target) <= NON_MDF_PACKET_COLUMNS.indexOf(expected)) {
    throw new ApiError(409, 'MDF_NON_MDF_RETURN_UNSUPPORTED', NON_MDF_RETURN_MESSAGE);
  }
  const kind = command.cardKind as NonMdfCardKind;
  const loadOwners = () => kind === 'packet'
    ? loadPacketOrderIds(tx, command.cardId) : loadBazisCutSetBoardOrderIds(tx, command.cardId);
  const owners = await loadOwners();
  const liveOwners = await authorizeNonMdfOwners(tx, user, owners);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`mdf-source:${JSON.stringify([kind, command.cardId])}`]);
  await tx.query(`SELECT 1 FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2 FOR UPDATE`, [kind, command.cardId]);
  const locked = await tx.query(kind === 'packet'
    ? `SELECT 1 FROM cnc_telegram_packets WHERE packet_id::text=$1 FOR UPDATE`
    : `SELECT 1 FROM bazis_cut_sets WHERE bazis_cut_set_id::text=$1 FOR UPDATE`, [command.cardId]);
  const revalidated = locked.rows.length ? await classifyQueuedNonMdf(tx, kind, command.cardId) : 'engine';
  const ownersNow = await loadOwners();
  if (revalidated !== 'non_mdf' || JSON.stringify(ownersNow) !== JSON.stringify(owners)) {
    throw new ApiError(409, 'MDF_SOURCE_STALE', 'Карточка изменилась. Обновите доску');
  }
  const currentColumn = kind === 'packet'
    ? await loadCncPacketBoardColumn(tx, command.cardId) : await loadCncBazisCutSetBoardColumn(tx, command.cardId);
  if (currentColumn !== expected) {
    throw new ApiError(409, 'MDF_SOURCE_STALE', 'Карточка изменилась. Обновите доску');
  }
  await setSessionUser(tx, user.id);
  const current = await loadMoveForUpdate(tx, kind, command.cardId);
  const actorUserId = toNullableUserId(user.id);
  const saved = current ? await updateMove(tx, command, actorUserId) : await insertMove(tx, command, actorUserId);
  const requestId = command.requestId ?? 'mdf-board-manual-move';
  const auditId = await auditService.record(tx, {
    event: current ? 'mdf_board.manual_move.updated' : 'mdf_board.manual_move.created',
    entityType: 'mdf_board_manual_move',
    entityId: manualMoveEntityId(kind, command.cardId),
    actorUserId: user.id,
    actorUsername: user.username,
    actorRole: user.role,
    requestId,
    source: 'mdf-active-non-mdf-command',
    statusField: 'target_column',
    statusCode: target,
    before: current ? auditShape(current) : null,
    after: auditShape(saved),
    diff: { targetColumn: { before: current?.targetColumn ?? expected, after: saved.targetColumn } },
    metadata: auditMetadata(kind, command.cardId, {
      operation: current ? 'update' : 'create', engineMode: 'active', nonMdf: true, expectedColumn: expected,
      relatedOrderIds: liveOwners,
      // Engine active: MDF status automation belongs to the engine; an excluded material never yields MDF events.
      statusAutomationDecision: 'engine_active_non_mdf_skip',
      notificationEventEmitted: true, notificationEventDecision: 'card_placed_outbox',
    }),
    relatedEntities: relatedEntities(kind, command.cardId, liveOwners),
  });
  const response: MdfBoardManualMoveUpsertResponseDto = {
    generatedAt: new Date().toISOString(), changed: true, move: saved, auditId,
  };
  // Domain event and durable replay record in one idempotent row (any owner count, including none).
  const payload: NonMdfReplayPayload & Record<string, unknown> = {
    nonMdf: true, actorUserId: Number(user.id), requestId, auditId, sourceKind: kind, sourceId: command.cardId,
    targetColumn: target, orderIds: liveOwners, requestDigest: nonMdfRequestDigest(command), response,
  };
  await tx.query(`INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
    VALUES ('mdf_board.card_placed','mdf_board_card',$1,$2::jsonb,$3) ON CONFLICT (idempotency_key) DO NOTHING`,
  [`${kind}:${command.cardId}`, JSON.stringify(payload), nonMdfPlacementKey(user, command.idempotencyKey)]);
  return response;
}

/** Owner orders locked in id order (the engine's order), each viewable and updatable by the actor. A file without a
 * live production-order owner needs the unscoped production-task grant. Returns the live owners. */
async function authorizeNonMdfOwners(tx: TransactionClient, user: CurrentUser, orderIds: readonly number[]): Promise<number[]> {
  const locked = (await tx.query<{ id: number; createdBy: string | null; managerId: string | null; assigned: string[] }>(`
    SELECT o.order_id::float8 id,o.created_by::text "createdBy",o.manager_id::text "managerId",
      ARRAY(SELECT u.user_id::text FROM order_workshops w JOIN users u ON u.employee_id=w.responsible_employee_id
        WHERE w.order_id=o.order_id AND NOT w.delete_flag AND u.is_active ORDER BY u.user_id) assigned
    FROM orders o WHERE o.order_id=ANY($1::bigint[]) AND NOT o.delete_flag AND o.order_kind='production_order'
    ORDER BY o.order_id FOR NO KEY UPDATE OF o`, [[...orderIds]])).rows;
  const scopes = policyScopeSetsForUser(user).productionTasks.update;
  if (!locked.length) {
    if (!scopeSetHas(scopes, 'all')) throw new ApiError(403, 'PERMISSION_DENIED', 'Нет доступа к файлу без заказа');
    return [];
  }
  const policy = new OrderAccessPolicy();
  for (const o of locked) {
    const subject = { orderId: o.id, createdByUserId: o.createdBy, managerUserId: o.managerId, assignedUserIds: o.assigned };
    if (!policy.canView(user, subject) || !(policy.canUpdate(user, subject) || allowsScopeSet(user, scopes, subject))) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Нет доступа ко всем заказам карточки');
    }
  }
  return locked.map(o => o.id);
}

function nonMdfPlacementKey(user: CurrentUser, key: string): string {
  return `mdf-manual:${user.id}:${key}:placed`;
}

function nonMdfRequestDigest(command: UpsertMdfBoardManualMoveCommand): string {
  return createHash('sha256').update(JSON.stringify([command.cardKind, command.cardId, command.targetColumn,
    command.expectedColumn ?? null, 'nonMdf'])).digest('hex');
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

/** Every owner of a set as the board resolves it: the row's order, else the order of its source detail. The non-MDF
 * move authorizes, locks, audits and replays against this complete set. */
async function loadBazisCutSetBoardOrderIds(tx: TransactionClient, cardId: string): Promise<number[]> {
  const bazisCutSetId = toPositiveSafeInteger(cardId);
  if (bazisCutSetId === null) return [];
  const result = await tx.query<{ order_id: string | number | null }>(`SELECT DISTINCT
      COALESCE(detail.source_order_id, source_detail.order_id) AS order_id
    FROM bazis_cut_set_details detail
    LEFT JOIN order_details source_detail ON source_detail.detail_id = detail.source_order_detail_id
    WHERE detail.bazis_cut_set_id = $1 AND COALESCE(detail.source_order_id, source_detail.order_id) IS NOT NULL
    ORDER BY 1`, [bazisCutSetId]);
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
