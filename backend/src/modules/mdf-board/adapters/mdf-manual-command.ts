import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { TransactionClient } from '../../../database/database.types';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { allowsScope, rolePolicyForUser } from '../../../permissions/policies/scope';
import type { DeleteMdfBoardManualMoveCommand, UpsertMdfBoardManualMoveCommand } from '../../orders/application/mdf-board-manual-move.types';
import type { MdfBoardManualMoveDto, MdfBoardManualMoveUpsertResponseDto, MdfBoardManualMoveDeleteResponseDto } from '../../orders/dto/mdf-board-manual-move.dto';
import { requireMdfCommandBoundary } from '../application/mdf-command-boundary';
import { recordMdfLineageReceipt, recordMdfReceipt, type MdfReceiptLine } from '../application/mdf-receipt';
import { buildMdfForwardLineageManifest } from '../application/mdf-forward-lineage';
import { addMdfManualProof, mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { mdfDemandDigest } from '../domain/mdf-execution-context';
import { mdfSum } from '../domain/mdf-quantities';
import { matchesMdfValidatedPhysicalLineage, mdfLineageRevisionKey } from '../domain/mdf-physical-lineage';
import { loadMdfExecutionSnapshot } from './mdf-execution-snapshot';
import { loadMdfShadowSource } from './mdf-shadow-source';

interface Head { received: string; accepted: string|null; version: string; epoch: string }
interface Owner { id: number; createdBy: string|null; managerId: string|null; assigned: string[] }
function conflict(code: string, message: string): never { throw new ApiError(409,code,message); }

/** Active command adapter. No legacy dispatch/manual-table writes. A complete
 * accepted baseline is required: this is NOT implicit acceptance of old visual
 * facts. The separate reconciliation command owns unverified history.
 * Lock order: transaction fence → all owners → exact source/head → audit/receipt.
 */
export function executeMdfManualCommand(tx: TransactionClient, command: UpsertMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveUpsertResponseDto>;
export function executeMdfManualCommand(tx: TransactionClient, command: DeleteMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveDeleteResponseDto>;
export async function executeMdfManualCommand(tx: TransactionClient,
  command: UpsertMdfBoardManualMoveCommand | DeleteMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveUpsertResponseDto | MdfBoardManualMoveDeleteResponseDto> {
  const boundary = await requireMdfCommandBoundary(tx,{ writer: 'mdf.manual',capability: 'queued' });
  if (boundary.mode !== 'active') throw new Error('MDF_ACTIVE_COMMAND_REQUIRED');
  if (command.cardKind === 'order') conflict('MDF_ORDER_MOVE_REQUIRES_STATUS_CHANGE','Перемещение заказа требует изменения статуса');
  const source = { kind: command.cardKind, id: command.cardId } as { kind: 'packet'|'bazisCutSet'|'bath'; id: string };
  const target = 'targetColumn' in command ? command.targetColumn : null;
  if (!command.sourceToken || !/^[a-f0-9]{64}$/.test(command.sourceToken)) {
    conflict('MDF_SOURCE_TOKEN_REQUIRED','Обновите карточку перед перемещением');
  }
  if (!command.currentUser.permissions.includes('production.tasks.update')) {
    throw new ApiError(403,'PERMISSION_DENIED','Нет права изменять производственные карточки');
  }
  if (!command.idempotencyKey || !/^[A-Za-z0-9._:-]{1,128}$/.test(command.idempotencyKey)) {
    conflict('MDF_IDEMPOTENCY_KEY_REQUIRED','Команда требует уникального ключа повтора');
  }
  const requestDigest = createHash('sha256').update(JSON.stringify([source.kind,source.id,target,command.sourceToken])).digest('hex');
  // Command-key lock precedes all owner/source locks. Equal keys on different
  // sources must conflict instead of racing the last response INSERT.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
    `mdf-manual-command:${JSON.stringify([command.currentUser.id,command.idempotencyKey])}`]);
  const replay = (await tx.query<{ request_digest: string; order_ids: string[];
    response: MdfBoardManualMoveUpsertResponseDto | MdfBoardManualMoveDeleteResponseDto }>(`SELECT request_digest,order_ids,response
    FROM mdf_manual_command_results WHERE actor_user_id=$1 AND command_key=$2`,
  [command.currentUser.id,command.idempotencyKey])).rows[0];
  if (replay && replay.request_digest !== requestDigest) conflict('IDEMPOTENCY_CONFLICT','Ключ повтора уже использован для другой команды');
  const args = [source.kind,source.id];
  const headSql = `SELECT received_revision_key received,accepted_revision_key accepted,version::text,correction_epoch::text epoch
    FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`;
  const initial = (await tx.query<Head>(headSql,args)).rows[0];
  if (!replay) assertToken(initial);
  const owners = replay ? replay.order_ids.map(Number).sort((a,b) => a-b)
    : (await tx.query<{ id: number }>(`SELECT DISTINCT order_id::float8 id FROM mdf_revision_demand
      WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3 ORDER BY id LIMIT 101`,[...args,initial!.received])).rows.map(r => r.id);
  if (!owners.length || owners.length > 100) conflict('MDF_COMMAND_RECONCILIATION_REQUIRED','Состав карточки требует проверки');
  const locked = (await tx.query<Owner>(`SELECT o.order_id::float8 id,o.created_by::text "createdBy",o.manager_id::text "managerId",
    ARRAY(SELECT u.user_id::text FROM order_workshops w JOIN users u ON u.employee_id=w.responsible_employee_id
      WHERE w.order_id=o.order_id AND NOT w.delete_flag AND u.is_active ORDER BY u.user_id) assigned
    FROM orders o WHERE o.order_id=ANY($1::bigint[]) AND NOT o.delete_flag AND o.order_kind='production_order'
    ORDER BY o.order_id FOR UPDATE OF o`,[owners])).rows;
  if (locked.length !== owners.length) conflict('MDF_COMMAND_RECONCILIATION_REQUIRED','Состав заказов изменился');
  const policy = new OrderAccessPolicy(), user = command.currentUser;
  for (const o of locked) {
    const subject = { orderId: o.id,createdByUserId: o.createdBy,managerUserId: o.managerId,assignedUserIds: o.assigned };
    if (!policy.canView(user,subject) || !(policy.canUpdate(user,subject)
      || allowsScope(user,rolePolicyForUser(user).productionTasks.update,subject))) {
      throw new ApiError(403,'PERMISSION_DENIED','Нет доступа ко всем заказам карточки');
    }
  }
  if (replay) return replay.response; // Authorization rechecked; no stale-token exception for a NEW command.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`mdf-source:${JSON.stringify(args)}`]);
  const head = (await tx.query<Head>(`${headSql} FOR UPDATE`,args)).rows[0];
  assertToken(head);
  if (!head.accepted || head.accepted !== head.received) {
    conflict('MDF_COMMAND_RECONCILIATION_REQUIRED','Изменения состава ещё не подтверждены');
  }
  const snapshot = await loadMdfExecutionSnapshot(tx,[{ ...source,...head }],owners);
  const key = JSON.stringify(args), metadata = snapshot.metadata.get(key);
  if (!metadata || snapshot.issues.get(key)?.length) conflict('MDF_COMMAND_RECONCILIATION_REQUIRED','Состав или количество деталей изменились');
  const lines = (await tx.query<MdfReceiptLine & { evidenceLineId: string; revision: string }>(`SELECT evidence_line_id::text "evidenceLineId",
    revision_key revision,line_key "lineKey",order_id::float8 "orderId",detail_id::float8 "detailId",
    quantity::float8 quantity,stage_code "stageCode",evidence_kind "evidenceKind",rework FROM mdf_evidence_lines
    WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3 ORDER BY line_key LIMIT 10001`,[...args,head.received])).rows;
  if (!lines.length || lines.length > 10000) conflict('MDF_COMMAND_RECONCILIATION_REQUIRED','Неполный состав карточки');
  // Diagnostic loader is used solely as a negative live-membership check. Its
  // cut/laminated/manual/whole-order fields NEVER enter accepted evidence.
  const raw = await loadMdfShadowSource(tx,source,5001);
  const members = raw.filter(r => r.relevant);
  if (raw.length > 5000 || !members.length || members.some(r => r.unresolved || !r.line_key
    || ![r.order_id,r.detail_id,r.quantity].every(n => Number.isSafeInteger(Number(n)) && Number(n)>0))) {
    conflict('MDF_COMMAND_RECONCILIATION_REQUIRED','Не все детали карточки сопоставлены');
  }
  const normalized = members.map(r => ({ orderId: Number(r.order_id),detailId: Number(r.detail_id),quantity: Number(r.quantity),rework: r.rework }));
  if (composition(normalized) !== composition(lines.filter(l => l.stageCode === 'membership'))) {
    conflict('MDF_COMMAND_RECONCILIATION_REQUIRED','Состав файла изменился после подтверждения');
  }
  const lineageKey = mdfLineageRevisionKey(source,head.accepted);
  const lineage = snapshot.lineage.get(lineageKey);
  const lineageIssue = snapshot.lineageIssues.get(lineageKey)?.[0];
  if (lineageIssue || (lineage && !matchesMdfValidatedPhysicalLineage({ sourceKind: source.kind,sourceId: source.id,
    revisionKey: head.accepted,lines: lines.map(line => ({ ...line,stage: line.stageCode,evidence: line.evidenceKind })),lineage }))) {
    conflict('MDF_COMMAND_RECONCILIATION_REQUIRED','Проверенная история производства карточки изменилась');
  }
  const published = (await tx.query<{ column: string|null }>(`SELECT column_key "column" FROM mdf_published_sources
    WHERE source_kind=$1 AND source_id=$2 AND received_revision_key=$3 AND accepted_revision_key=$3
      AND cardinality(issues)=0`,[...args,head.received])).rows[0];
  if (!published?.column) conflict('MDF_COMMAND_PENDING','Дождитесь публикации карточки');
  const sequence = source.kind === 'bath' ? ['baths','baths_ready','baths_laminated','completed_baths']
    : ['parsed','completed','completed_laminated'];
  if (target !== null && (!sequence.includes(target) || sequence.indexOf(target) < sequence.indexOf(published.column!))) {
    conflict('MDF_RETURN_CONFIRMATION_REQUIRED','Возврат требует предпросмотра последствий');
  }
  const causeKey = `mdf-manual:${randomUUID()}`, revisionKey = causeKey;
  let proof: ReturnType<typeof addMdfManualProof>;
  try {
    proof = addMdfManualProof(source,lines,target,causeKey,lineage ? { revisionKey: head.accepted,lineage } : undefined);
  } catch (error) {
    if (error instanceof Error && error.message === 'MDF_MANUAL_EVIDENCE_INVALID') {
      conflict('MDF_COMMAND_RECONCILIATION_REQUIRED','Физические данные карточки требуют проверки');
    }
    throw error;
  }
  const changed = metadata.manualPlacementColumn !== target || proof.added.length > 0;
  const now = new Date().toISOString();
  const move = (version: string): MdfBoardManualMoveDto => ({ cardKind: source.kind,cardId: source.id,
    targetColumn: target as MdfBoardManualMoveDto['targetColumn'],version: Number(version),
    createdAt: now,updatedAt: now,createdByUserId: Number(user.id),updatedByUserId: Number(user.id) });
  if (!changed) return remember(target === null ? { generatedAt: now,cardKind: source.kind,cardId: source.id,deleted: false }
    : { generatedAt: now,changed: false,move: move(head.version) });
  const requestId = command.requestId ?? 'mdf-board-manual-move';
  await tx.query("SELECT set_config('erp.current_user_id',$1,true)",[user.id]);
  const rules = (await tx.query<{ id: string; version: number }>(`SELECT id,version FROM status_automation_rules
    WHERE is_enabled ORDER BY id`)).rows.map(r => ({ ruleId: Number(r.id),version: Number(r.version) }));
  const demand = snapshot.frozenDemand.get(key)!;
  const auditId = await auditService.record(tx,{
    event: target === null ? 'mdf_board.manual_move.deleted' : metadata.manualPlacementColumn === null
      ? 'mdf_board.manual_move.created' : 'mdf_board.manual_move.updated',
    entityType: 'mdf_board_manual_move',entityId: `${source.kind}:${source.id}`,actorUserId: user.id,
    actorUsername: user.username,actorRole: user.role,requestId,source: 'mdf-active-manual-command',
    statusField: 'target_column',statusCode: target,before: { targetColumn: metadata.manualPlacementColumn,revision: head.received },
    after: { targetColumn: target,revision: revisionKey },
    metadata: { engineMode: 'active',sourceKind: source.kind,sourceId: source.id,sourceToken: command.sourceToken,
      receivedRevision: head.received,correctionEpoch: head.epoch,headVersion: head.version,
      demandDigest: mdfDemandDigest(demand),receiptRevision: revisionKey,causeKey,
      physicalProofEmitted: proof.added.length > 0,notificationEventEmitted: false,
      notificationEventDecision: 'queued_production_events',relatedOrderIds: owners },
    relatedEntities: owners.map(entityId => ({ entityType: 'order' as const,entityId })),
  });
  const previousPhysicalRows = lines.filter(line => line.evidenceKind === 'physical');
  const useLineageReceipt = Boolean(lineage || (!previousPhysicalRows.length && proof.added.length));
  const receiptInput = { sourceKind: source.kind,sourceId: source.id,revisionKey,origin: 'manual' as const,
    actorUserId: Number(user.id),requestId,causeKey,expectedFence: { version: head.version,correctionEpoch: head.epoch },
    accept: true,lines: proof.lines,rules,executionContext: { sourceCreatedAt: metadata.sourceCreatedAt,
      displayName: metadata.displayName,priorColumn: published.column!,manualPlacementColumn: target,
      compositionComplete: true,demand } };
  const saved = useLineageReceipt
    ? await recordLineageReceipt()
    : await recordMdfReceipt(tx,receiptInput);
  return remember(target === null ? { generatedAt: now,cardKind: source.kind,cardId: source.id,deleted: true,auditId,jobId: saved.jobId }
    : { generatedAt: now,changed: true,move: move(saved.version),auditId,jobId: saved.jobId });

  async function remember(response: MdfBoardManualMoveUpsertResponseDto | MdfBoardManualMoveDeleteResponseDto) {
    await tx.query(`INSERT INTO mdf_manual_command_results(actor_user_id,command_key,request_digest,source_kind,source_id,order_ids,response)
      VALUES($1,$2,$3,$4,$5,$6::bigint[],$7::jsonb)`,[user.id,command.idempotencyKey,requestDigest,...args,owners,JSON.stringify(response)]);
    return response;
  }

  async function recordLineageReceipt() {
    let manifest: ReturnType<typeof buildMdfForwardLineageManifest>;
    try {
      manifest = buildMdfForwardLineageManifest({ sourceKind: source.kind,sourceId: source.id,
        predecessorRevisionKey: head.accepted,previousPhysicalRows,previousLineage: lineage,
        nextLines: proof.lines,rootLineKeys: proof.added.map(line => line.lineKey) });
    } catch (error) {
      if (error instanceof Error && (error.message === 'MDF_LINEAGE_INVALID' || error.message === 'MDF_LINEAGE_REQUIRED')) {
        conflict('MDF_COMMAND_RECONCILIATION_REQUIRED','Происхождение физических данных требует проверки');
      }
      throw error;
    }
    return recordMdfLineageReceipt(tx,{ ...receiptInput,lineage: manifest });
  }

  function assertToken(head: Head | undefined): asserts head is Head {
    if (!head || mdfSourceCommandToken(source,head) !== command.sourceToken) {
      conflict('MDF_SOURCE_STALE','Карточка изменилась. Обновите доску');
    }
  }
}

function composition(rows: readonly { orderId: number; detailId: number; quantity: number; rework: boolean }[]): string {
  const totals = new Map<string,number>();
  for (const r of rows) {
    const key = JSON.stringify([r.orderId,r.detailId,r.rework]);
    totals.set(key,mdfSum(totals.get(key) ?? 0,r.quantity));
  }
  return JSON.stringify([...totals].sort(([a],[b]) => a.localeCompare(b)));
}
