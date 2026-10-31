import { createHash } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { AuditRelatedEntity } from '../../../common/audit/audit-event.types';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  bathOwnerOrderIds,
  canonicalPair,
  pairDigest,
  parseBathCardId,
  sharedDetails,
  type MdfBathSideFacts,
} from '../domain/mdf-bath-duplicates';
import type {
  ListMdfBathDuplicatesCommand,
  MdfBathDuplicateRepositoryPort,
  ResolveMdfBathDuplicateCommand,
} from '../application/mdf-bath-duplicate.types';
import type {
  MdfBathDuplicateActionDto,
  MdfBathDuplicatesResponseDto,
  ResolveMdfBathDuplicateResponseDto,
} from '../dto/mdf-bath-duplicate.dto';
import {
  loadActiveBathIdsForJobs,
  loadBathDuplicatesForCards,
  loadBathSideFacts,
  loadVisibleOrderIds,
} from './mdf-bath-duplicate-facts';

const SOURCE = 'backend-mdf-board';
const EVENT = 'mdf_board.bath_duplicate_resolved';

interface ResolutionRow {
  resolution_id: string;
  action: MdfBathDuplicateActionDto;
  bath_a: string;
  bath_b: string;
  target_bath: string;
  digest: string;
  shared_json: unknown;
  order_ids: Array<string | number>;
  created_at: string | Date;
  request_digest: string;
  audit_id: string | null;
}

/**
 * «Разобрать дубль» (plan r8 §3): records a keep_both / rework_mark decision for a pair of ACTIVE baths. Cut data is
 * never changed. Locking protocol (r6/r7): only a per-bath advisory lock ('mdf-bath:' || cut_result_id), both baths
 * ascending; it serializes decisions on the same baths only — no other command takes it yet (the shared barrier with
 * the bath manual move is stage 2). No row locks on cut_job/orders (cut commands take those in different orders). A
 * concurrent re-cut, item change or archive changes the pair digest, so the decision simply stops applying.
 */
export class PgMdfBathDuplicateRepository implements MdfBathDuplicateRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  async list(command: ListMdfBathDuplicatesCommand): Promise<MdfBathDuplicatesResponseDto> {
    return { generatedAt: new Date().toISOString(),
      baths: await loadBathDuplicatesForCards(this.database, command.currentUser, command.bathCardIds) };
  }

  async resolve(command: ResolveMdfBathDuplicateCommand): Promise<ResolveMdfBathDuplicateResponseDto> {
    const hereId = parseBathCardId(command.bathCardId);
    const otherId = parseBathCardId(command.otherBathCardId);
    if (hereId === null || otherId === null || hereId === otherId) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Нужны две разные ванны', { field: 'otherBathCardId' });
    }
    const commandKey = `${command.currentUser.id}:${command.idempotencyKey}`;
    const requestDigest = sha256(JSON.stringify([command.bathCardId, command.otherBathCardId, command.action,
      command.expectedDigest]));
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query('SET LOCAL jit=off');
        for (const id of [hereId, otherId].sort((a, b) => a - b)) {
          await tx.query("SELECT pg_advisory_xact_lock(hashtext('mdf-bath:' || $1::text))", [String(id)]);
        }
        const existing = await loadByCommandKey(tx, commandKey);
        if (existing) {
          if (existing.request_digest !== requestDigest) idempotencyConflict();
          // A replay answers only to someone who may still see every order of the decision.
          await assertOrderScope(tx, command.currentUser, existing.order_ids.map(Number));
          return { generatedAt: new Date().toISOString(), resolution: mapResolution(existing, command.bathCardId),
            auditId: existing.audit_id, replayed: true };
        }
        return applyResolution(tx, command, { commandKey, requestDigest });
      });
    } catch (error) {
      // Same key raced in another pair's barrier: the unique key decides, the loser gets the idempotency conflict.
      if (isUniqueViolation(error, 'uq_mdf_bath_duplicate_resolutions_command_key')) idempotencyConflict();
      throw error;
    }
  }
}

async function applyResolution(tx: TransactionClient, command: ResolveMdfBathDuplicateCommand,
  keys: { commandKey: string; requestDigest: string }): Promise<ResolveMdfBathDuplicateResponseDto> {
  const facts = await loadBathSideFacts(tx, [parseBathCardId(command.bathCardId)!, parseBathCardId(command.otherBathCardId)!]);
  const here = facts.get(command.bathCardId);
  const there = facts.get(command.otherBathCardId);
  if (!here || !there) stale();
  // Every owner of both baths (HDF and non-effective placements too), not only the shared MDF details' orders.
  const owners = [...new Set([...bathOwnerOrderIds(here), ...bathOwnerOrderIds(there)])].sort((a, b) => a - b);
  // Scope before any staleness answer: a foreign pair gets 403, never a hint about its digest.
  await assertOrderScope(tx, command.currentUser, owners);
  const active = new Set(await loadActiveBathIdsForJobs(tx, [here.cutJobId, there.cutJobId]));
  if (here.cutJobId === there.cutJobId || !active.has(here.cutResultId) || !active.has(there.cutResultId)) stale();
  const shared = sharedDetails(here, there);
  const digest = pairDigest(here, there);
  if (!shared.length || digest !== command.expectedDigest) stale();
  const [low, high] = canonicalPair(here, there);
  const sharedSnapshot = sharedDetails(low, high).map(s => ({ orderId: s.orderId, detailId: s.detailId,
    detailNumber: s.detailNumber, quantityA: s.here, quantityB: s.there }));
  const actorUserId = toNullableUserId(command.currentUser.id);
  const requestId = command.requestId ?? 'mdf-bath-duplicate-resolve';
  const inserted = (await tx.query<ResolutionRow>(`INSERT INTO mdf_bath_duplicate_resolutions (
      bath_a, bath_b, target_bath, action, digest, shared_json, order_ids, created_by, request_id, command_key, request_digest)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::bigint[], $8, $9, $10, $11)
    RETURNING resolution_id::text, action, bath_a, bath_b, target_bath, digest, shared_json, order_ids, created_at,
      request_digest, audit_id::text`,
  [low.bathCardId, high.bathCardId, here.bathCardId, command.action, digest, JSON.stringify(sharedSnapshot), owners,
    actorUserId, requestId, keys.commandKey, keys.requestDigest])).rows[0];
  const resolutionId = Number(inserted.resolution_id);
  const side = (bath: MdfBathSideFacts) => ({ bathCardId: bath.bathCardId, cutResultId: bath.cutResultId,
    cutJobId: bath.cutJobId, resultNo: bath.resultNo, revisionNo: bath.revisionNo, jobVersion: bath.jobVersion,
    manualColumn: bath.manualColumn, active: true,
    placementQuantity: bath.placements.reduce((sum, p) => sum + p.quantity, 0) });
  const relatedEntities: AuditRelatedEntity[] = [
    ...owners.map(entityId => ({ entityType: 'order', entityId })),
    ...sharedSnapshot.map(s => ({ entityType: 'order_detail', entityId: s.detailId })),
    ...[low, high].map(bath => ({ entityType: 'cut_result', entityId: bath.cutResultId })),
    ...[low, high].map(bath => ({ entityType: 'cut_job', entityId: bath.cutJobId })),
  ];
  // No client names or order titles: ids and quantities only.
  const auditId = await auditService.record(tx, {
    event: EVENT,
    entityType: 'mdf_bath_duplicate',
    entityId: resolutionId,
    actorUserId: command.currentUser.id,
    actorUsername: command.currentUser.username,
    actorRole: command.currentUser.role,
    requestId,
    source: SOURCE,
    relatedOrderId: owners.length === 1 ? owners[0] : null,
    statusField: 'action',
    statusCode: command.action,
    before: { baths: [side(low), side(high)], decision: null },
    after: { resolutionId, action: command.action, targetBath: here.bathCardId, digest, shared: sharedSnapshot },
    diff: { decision: { before: null, after: command.action } },
    metadata: {
      action: command.action,
      targetBath: here.bathCardId,
      otherBath: there.bathCardId,
      bathA: low.bathCardId,
      bathB: high.bathCardId,
      sharedCount: shared.length,
      orderIds: owners,
      commandKeySha256: sha256(keys.commandKey),
      notificationEventDecision: 'domain_outbox_only_no_user_notification',
    },
    relatedEntities,
  });
  if (!auditId) throw new Error('MDF_BATH_DUPLICATE_AUDIT_FAILED');
  await tx.query('UPDATE mdf_bath_duplicate_resolutions SET audit_id = $2 WHERE resolution_id = $1', [resolutionId, auditId]);
  await tx.query(`INSERT INTO outbox_events(event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ($1, 'mdf_bath_duplicate', $2, $3::jsonb, $4) ON CONFLICT (idempotency_key) DO NOTHING`,
  [EVENT, String(resolutionId), JSON.stringify({ actorUserId, requestId, auditId, resolutionId, action: command.action,
    bathA: low.bathCardId, bathB: high.bathCardId, targetBath: here.bathCardId, digest, orderIds: owners }),
  `mdf-bath-duplicate:${sha256(keys.commandKey)}`]);
  return { generatedAt: new Date().toISOString(),
    resolution: mapResolution({ ...inserted, audit_id: auditId }, command.bathCardId), auditId, replayed: false };
}

async function loadByCommandKey(tx: TransactionClient, commandKey: string): Promise<ResolutionRow | undefined> {
  return (await tx.query<ResolutionRow>(`SELECT resolution_id::text, action, bath_a, bath_b, target_bath, digest,
      shared_json, order_ids, created_at, request_digest, audit_id::text
    FROM mdf_bath_duplicate_resolutions WHERE command_key = $1`, [commandKey])).rows[0];
}

/** Backend order view scope over EVERY owner (the decision is about both baths as a whole). */
async function assertOrderScope(tx: TransactionClient, user: CurrentUser, owners: readonly number[]): Promise<void> {
  const visible = await loadVisibleOrderIds(tx, user, owners);
  if (owners.some(orderId => !visible.has(orderId))) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Нет доступа ко всем заказам обеих ванн');
  }
}

function mapResolution(row: ResolutionRow, bathCardId: string): ResolveMdfBathDuplicateResponseDto['resolution'] {
  const shared = Array.isArray(row.shared_json) ? row.shared_json : [];
  return {
    resolutionId: Number(row.resolution_id),
    action: row.action,
    bathA: row.bath_a,
    bathB: row.bath_b,
    targetBath: row.target_bath,
    otherBathCardId: row.bath_a === bathCardId ? row.bath_b : row.bath_a,
    digest: row.digest,
    sharedCount: shared.length,
    orderIds: row.order_ids.map(Number),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

function stale(): never {
  throw new ApiError(409, 'MDF_BATH_DUPLICATE_STALE', 'Ванны изменились — обновите доску и откройте дубль заново');
}

function idempotencyConflict(): never {
  throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ повтора уже использован для другого разбора дубля');
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const record = error as { code?: unknown; constraint?: unknown } | null;
  return record?.code === '23505' && record.constraint === constraint;
}

function toNullableUserId(value: string | number): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
