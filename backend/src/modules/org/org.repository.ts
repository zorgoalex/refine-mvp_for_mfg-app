import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../common/errors/api-error';
import { auditService } from '../../common/audit/audit.service';
import type { AuditEvent } from '../../common/audit/audit-event.types';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import type { DirectionDetailDto, DirectionSummaryDto, HeadDto } from './org.types';

export const SOURCE = 'org-management';

type OrgDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

export interface ListDirectionsCommand {
  currentUser: CurrentUser;
  requestId?: string;
}
export interface GetDirectionCommand {
  currentUser: CurrentUser;
  directionId: number;
  requestId?: string;
}
export interface CreateDirectionCommand {
  currentUser: CurrentUser;
  name: string;
  description: string | null;
  isActive: boolean;
  requestId?: string;
}
export interface UpdateDirectionCommand {
  currentUser: CurrentUser;
  directionId: number;
  patch: { name?: string; description?: string | null; isActive?: boolean };
  requestId?: string;
}
export interface DeleteDirectionCommand {
  currentUser: CurrentUser;
  directionId: number;
  requestId?: string;
}
export interface ReplaceDirectionIdSetCommand {
  currentUser: CurrentUser;
  directionId: number;
  idempotencyKey: string;
  ids: number[];
  reason: string | null;
  requestId?: string;
}
export interface ReplaceWorkshopHeadsCommand {
  currentUser: CurrentUser;
  workshopId: number;
  idempotencyKey: string;
  ids: number[];
  reason: string | null;
  requestId?: string;
}
export interface ListWorkshopHeadsCommand {
  currentUser: CurrentUser;
  workshopId: number;
  requestId?: string;
}
export interface LookupCommand {
  currentUser: CurrentUser;
  requestId?: string;
}

export interface OrgRepositoryPort {
  listDirections(c: ListDirectionsCommand): Promise<DirectionSummaryDto[]>;
  getDirection(c: GetDirectionCommand): Promise<DirectionDetailDto>;
  createDirection(c: CreateDirectionCommand): Promise<DirectionDetailDto>;
  updateDirection(c: UpdateDirectionCommand): Promise<DirectionDetailDto>;
  deleteDirection(c: DeleteDirectionCommand): Promise<{ directionId: number }>;
  replaceDirectionWorkshops(c: ReplaceDirectionIdSetCommand): Promise<DirectionDetailDto>;
  replaceDirectionWorkCenters(c: ReplaceDirectionIdSetCommand): Promise<DirectionDetailDto>;
  replaceDirectionHeads(c: ReplaceDirectionIdSetCommand): Promise<DirectionDetailDto>;
  listWorkshopHeads(c: ListWorkshopHeadsCommand): Promise<HeadDto[]>;
  replaceWorkshopHeads(c: ReplaceWorkshopHeadsCommand): Promise<HeadDto[]>;
  assignableUsers(c: LookupCommand): Promise<Array<{ userId: number; displayName: string | null }>>;
  lookupWorkshops(c: LookupCommand): Promise<Array<{ workshopId: number; name: string; isActive: boolean }>>;
  lookupWorkCenters(
    c: LookupCommand,
  ): Promise<Array<{ workcenterId: number; workshopId: number; name: string; isActive: boolean }>>;
}

export class PgOrgRepository implements OrgRepositoryPort {
  constructor(private readonly database: OrgDatabase) {}

  async listDirections(): Promise<DirectionSummaryDto[]> {
    const result = await this.database.query<DirectionSummaryRow>(`
      SELECT d.direction_id, d.direction_name, d.description, d.is_active,
        (SELECT count(*) FROM public.direction_workshops dw WHERE dw.direction_id = d.direction_id) AS workshop_count,
        (SELECT count(*) FROM public.direction_work_centers dwc WHERE dwc.direction_id = d.direction_id) AS work_center_count,
        (SELECT count(*) FROM public.direction_heads dh WHERE dh.direction_id = d.direction_id AND dh.is_active = true) AS head_count
      FROM public.directions d
      ORDER BY d.direction_name ASC
    `);
    return result.rows.map(mapDirectionSummary);
  }

  async getDirection(c: GetDirectionCommand): Promise<DirectionDetailDto> {
    return loadDirectionDetail(this.database, c.directionId);
  }

  async listWorkshopHeads(c: ListWorkshopHeadsCommand): Promise<HeadDto[]> {
    await ensureWorkshopExists(this.database, c.workshopId);
    return loadWorkshopHeads(this.database, c.workshopId);
  }

  async assignableUsers(): Promise<Array<{ userId: number; displayName: string | null }>> {
    const result = await this.database.query<{ user_id: number; display_name: string | null }>(`
      SELECT u.user_id,
             COALESCE(e.full_name, u.full_name, u.username) AS display_name
      FROM public.users u
      LEFT JOIN public.employees e ON e.employee_id = u.employee_id
      WHERE u.is_active = true
      ORDER BY display_name ASC, u.user_id ASC
    `);
    return result.rows.map((r) => ({ userId: Number(r.user_id), displayName: r.display_name }));
  }

  async lookupWorkshops(): Promise<Array<{ workshopId: number; name: string; isActive: boolean }>> {
    const result = await this.database.query<{ workshop_id: number; name: string; is_active: boolean }>(`
      SELECT workshop_id, workshop_name AS name, is_active
      FROM public.workshops
      ORDER BY workshop_name ASC
    `);
    return result.rows.map((r) => ({ workshopId: Number(r.workshop_id), name: r.name, isActive: r.is_active }));
  }

  async lookupWorkCenters(): Promise<
    Array<{ workcenterId: number; workshopId: number; name: string; isActive: boolean }>
  > {
    const result = await this.database.query<{
      workcenter_id: number;
      workshop_id: number;
      name: string;
      is_active: boolean;
    }>(`
      SELECT workcenter_id, workshop_id, workcenter_name AS name, is_active
      FROM public.work_centers
      ORDER BY workcenter_name ASC
    `);
    return result.rows.map((r) => ({
      workcenterId: Number(r.workcenter_id),
      workshopId: Number(r.workshop_id),
      name: r.name,
      isActive: r.is_active,
    }));
  }

  async createDirection(c: CreateDirectionCommand): Promise<DirectionDetailDto> {
    return this.database.transaction(async (tx) => {
      const inserted = await tx
        .query<{ direction_id: number }>(
          `INSERT INTO public.directions (direction_name, description, is_active, created_by, edited_by)
           VALUES ($1, $2, $3, $4, $4) RETURNING direction_id`,
          [c.name, c.description, c.isActive, toNullableUserId(c.currentUser.id)],
        )
        .catch(rethrowUniqueName);
      const directionId = Number(inserted.rows[0].direction_id);
      await auditService.record(
        tx,
        buildDirectionAuditEvent('ORG_DIRECTION_CREATED', {
          directionId,
          currentUser: c.currentUser,
          requestId: c.requestId,
          before: null,
          after: { directionName: c.name, description: c.description, isActive: c.isActive },
        }),
      );
      return loadDirectionDetail(tx, directionId);
    });
  }

  async updateDirection(c: UpdateDirectionCommand): Promise<DirectionDetailDto> {
    return this.database.transaction(async (tx) => {
      const current = await tx.query<DirectionSummaryRow>(
        `SELECT direction_id, direction_name, description, is_active FROM public.directions WHERE direction_id = $1::smallint FOR UPDATE`,
        [c.directionId],
      );
      if (!current.rows[0]) {
        throw new ApiError(404, 'ORG_DIRECTION_NOT_FOUND', 'Direction not found', { directionId: c.directionId });
      }
      const before = current.rows[0];
      const nextName = c.patch.name ?? before.direction_name;
      const nextDescription = c.patch.description !== undefined ? c.patch.description : before.description;
      const nextActive = c.patch.isActive !== undefined ? c.patch.isActive : before.is_active;
      await tx
        .query(
          `UPDATE public.directions SET direction_name=$2, description=$3, is_active=$4, edited_by=$5, updated_at=now()
           WHERE direction_id=$1::smallint`,
          [c.directionId, nextName, nextDescription, nextActive, toNullableUserId(c.currentUser.id)],
        )
        .catch(rethrowUniqueName);
      const deactivated = before.is_active === true && nextActive === false;
      await auditService.record(
        tx,
        buildDirectionAuditEvent(deactivated ? 'ORG_DIRECTION_DEACTIVATED' : 'ORG_DIRECTION_UPDATED', {
          directionId: c.directionId,
          currentUser: c.currentUser,
          requestId: c.requestId,
          before: { directionName: before.direction_name, description: before.description, isActive: before.is_active },
          after: { directionName: nextName, description: nextDescription, isActive: nextActive },
        }),
      );
      return loadDirectionDetail(tx, c.directionId);
    });
  }

  async deleteDirection(c: DeleteDirectionCommand): Promise<{ directionId: number }> {
    return this.database.transaction(async (tx) => {
      const current = await tx.query<DirectionSummaryRow>(
        `SELECT direction_id, direction_name, description, is_active FROM public.directions WHERE direction_id = $1::smallint FOR UPDATE`,
        [c.directionId],
      );
      if (!current.rows[0]) {
        throw new ApiError(404, 'ORG_DIRECTION_NOT_FOUND', 'Direction not found', { directionId: c.directionId });
      }
      const counts = await tx.query<{ workshops: string; work_centers: string; heads: string }>(
        `SELECT (SELECT count(*) FROM public.direction_workshops WHERE direction_id=$1::smallint) AS workshops,
                (SELECT count(*) FROM public.direction_work_centers WHERE direction_id=$1::smallint) AS work_centers,
                (SELECT count(*) FROM public.direction_heads WHERE direction_id=$1::smallint) AS heads`,
        [c.directionId],
      );
      await tx.query(`DELETE FROM public.directions WHERE direction_id = $1::smallint`, [c.directionId]);
      await auditService.record(
        tx,
        buildDirectionAuditEvent('ORG_DIRECTION_DELETED', {
          directionId: c.directionId,
          currentUser: c.currentUser,
          requestId: c.requestId,
          before: { directionName: current.rows[0].direction_name, isActive: current.rows[0].is_active },
          after: null,
          metadata: {
            cascadedCounts: {
              workshops: Number(counts.rows[0].workshops),
              workCenters: Number(counts.rows[0].work_centers),
              heads: Number(counts.rows[0].heads),
            },
          },
        }),
      );
      return { directionId: c.directionId };
    });
  }

  async replaceDirectionWorkshops(c: ReplaceDirectionIdSetCommand): Promise<DirectionDetailDto> {
    return this.replaceDirectionMembership(c, {
      table: 'direction_workshops',
      idColumn: 'workshop_id',
      refTable: 'workshops',
      refId: 'workshop_id',
      commandName: 'org.directions.replace_workshops',
      addedKey: 'addedWorkshops',
      removedKey: 'removedWorkshops',
      notFound: ['ORG_WORKSHOP_NOT_FOUND', 'Workshop not found'],
    });
  }

  async replaceDirectionWorkCenters(c: ReplaceDirectionIdSetCommand): Promise<DirectionDetailDto> {
    return this.replaceDirectionMembership(c, {
      table: 'direction_work_centers',
      idColumn: 'workcenter_id',
      refTable: 'work_centers',
      refId: 'workcenter_id',
      commandName: 'org.directions.replace_work_centers',
      addedKey: 'addedWorkCenters',
      removedKey: 'removedWorkCenters',
      notFound: ['ORG_WORKCENTER_NOT_FOUND', 'Work center not found'],
    });
  }

  private async replaceDirectionMembership(
    c: ReplaceDirectionIdSetCommand,
    cfg: MembershipConfig,
  ): Promise<DirectionDetailDto> {
    return this.database.transaction(async (tx) => {
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: c.idempotencyKey,
        commandName: cfg.commandName,
        actorUserId: c.currentUser.id,
        entityType: 'direction',
        entityId: String(c.directionId),
        requestHash: hashIdSet(c.currentUser.id, c.directionId, c.ids),
      });
      if (idempotency.completed) return idempotency.response as DirectionDetailDto;
      await ensureDirectionExistsForUpdate(tx, c.directionId);
      await validateIdSet(tx, cfg.refTable, cfg.refId, c.ids, cfg.notFound);
      const currentRows = await tx.query<{ id: number }>(
        `SELECT ${cfg.idColumn} AS id FROM public.${cfg.table} WHERE direction_id = $1::smallint`,
        [c.directionId],
      );
      const current = currentRows.rows.map((r) => Number(r.id));
      const { added, removed } = computeIdDelta(current, c.ids);
      if (added.length || removed.length) {
        if (removed.length) {
          await tx.query(
            `DELETE FROM public.${cfg.table} WHERE direction_id=$1::smallint AND ${cfg.idColumn} = ANY($2::smallint[])`,
            [c.directionId, removed],
          );
        }
        for (const id of added) {
          await tx.query(
            `INSERT INTO public.${cfg.table} (direction_id, ${cfg.idColumn}, created_by) VALUES ($1::smallint, $2::smallint, $3)
             ON CONFLICT DO NOTHING`,
            [c.directionId, id, toNullableUserId(c.currentUser.id)],
          );
        }
        await auditService.record(tx, {
          event: 'ORG_DIRECTION_MEMBERSHIP_REPLACED',
          entityType: 'direction',
          entityId: c.directionId,
          actorUserId: c.currentUser.id,
          actorUsername: c.currentUser.username,
          actorRole: c.currentUser.role,
          requestId: c.requestId ?? SOURCE,
          source: SOURCE,
          diff: { [cfg.addedKey]: added, [cfg.removedKey]: removed },
          metadata: { idempotencyKey: c.idempotencyKey, reason: c.reason },
        });
      }
      const detail = await loadDirectionDetail(tx, c.directionId);
      await completeIdempotency(tx, c.idempotencyKey, detail);
      return detail;
    });
  }

  async replaceDirectionHeads(c: ReplaceDirectionIdSetCommand): Promise<DirectionDetailDto> {
    return this.database.transaction(async (tx) => {
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: c.idempotencyKey,
        commandName: 'org.directions.replace_heads',
        actorUserId: c.currentUser.id,
        entityType: 'direction',
        entityId: String(c.directionId),
        requestHash: hashIdSet(c.currentUser.id, c.directionId, c.ids),
      });
      if (idempotency.completed) return idempotency.response as DirectionDetailDto;
      await ensureDirectionExistsForUpdate(tx, c.directionId);
      await validateActiveUsers(tx, c.ids);
      const current = (
        await tx.query<{ user_id: number }>(
          `SELECT user_id FROM public.direction_heads WHERE direction_id=$1::smallint AND is_active=true`,
          [c.directionId],
        )
      ).rows.map((r) => Number(r.user_id));
      const { added, removed } = computeIdDelta(current, c.ids);
      if (added.length || removed.length) {
        if (removed.length) {
          await tx.query(
            `UPDATE public.direction_heads SET is_active=false WHERE direction_id=$1::smallint AND user_id=ANY($2::bigint[])`,
            [c.directionId, removed],
          );
        }
        for (const userId of added) {
          await tx.query(
            `INSERT INTO public.direction_heads (direction_id, user_id, is_active, created_by)
             VALUES ($1::smallint, $2::bigint, true, $3)
             ON CONFLICT (direction_id, user_id) DO UPDATE SET is_active=true`,
            [c.directionId, userId, toNullableUserId(c.currentUser.id)],
          );
        }
        for (const ev of buildHeadAuditEvents({
          scope: 'direction',
          entityId: c.directionId,
          currentUser: c.currentUser,
          requestId: c.requestId,
          idempotencyKey: c.idempotencyKey,
          added,
          removed,
        })) {
          await auditService.record(tx, ev);
        }
      }
      const detail = await loadDirectionDetail(tx, c.directionId);
      await completeIdempotency(tx, c.idempotencyKey, detail);
      return detail;
    });
  }

  async replaceWorkshopHeads(c: ReplaceWorkshopHeadsCommand): Promise<HeadDto[]> {
    return this.database.transaction(async (tx) => {
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: c.idempotencyKey,
        commandName: 'org.workshops.replace_heads',
        actorUserId: c.currentUser.id,
        entityType: 'workshop',
        entityId: String(c.workshopId),
        requestHash: hashIdSet(c.currentUser.id, c.workshopId, c.ids),
      });
      if (idempotency.completed) return idempotency.response as HeadDto[];
      await ensureWorkshopExistsForUpdate(tx, c.workshopId);
      await validateActiveUsers(tx, c.ids);
      const current = (
        await tx.query<{ user_id: number }>(
          `SELECT user_id FROM public.workshop_heads WHERE workshop_id=$1::smallint AND is_active=true`,
          [c.workshopId],
        )
      ).rows.map((r) => Number(r.user_id));
      const { added, removed } = computeIdDelta(current, c.ids);
      if (added.length || removed.length) {
        if (removed.length) {
          await tx.query(
            `UPDATE public.workshop_heads SET is_active=false WHERE workshop_id=$1::smallint AND user_id=ANY($2::bigint[])`,
            [c.workshopId, removed],
          );
        }
        for (const userId of added) {
          await tx.query(
            `INSERT INTO public.workshop_heads (workshop_id, user_id, is_active, created_by)
             VALUES ($1::smallint, $2::bigint, true, $3)
             ON CONFLICT (workshop_id, user_id) DO UPDATE SET is_active=true`,
            [c.workshopId, userId, toNullableUserId(c.currentUser.id)],
          );
        }
        for (const ev of buildHeadAuditEvents({
          scope: 'workshop',
          entityId: c.workshopId,
          currentUser: c.currentUser,
          requestId: c.requestId,
          idempotencyKey: c.idempotencyKey,
          added,
          removed,
        })) {
          await auditService.record(tx, ev);
        }
      }
      const heads = await loadWorkshopHeads(tx, c.workshopId);
      await completeIdempotency(tx, c.idempotencyKey, heads);
      return heads;
    });
  }
}

// ── Audit builders / write helpers ──────────────────────────────────────────

export function buildDirectionAuditEvent(
  event: 'ORG_DIRECTION_CREATED' | 'ORG_DIRECTION_UPDATED' | 'ORG_DIRECTION_DEACTIVATED' | 'ORG_DIRECTION_DELETED',
  input: {
    directionId: number;
    currentUser: CurrentUser;
    requestId?: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  },
): AuditEvent {
  return {
    event,
    entityType: 'direction',
    entityId: input.directionId,
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId ?? SOURCE,
    source: SOURCE,
    before: input.before,
    after: input.after,
    metadata: input.metadata ?? null,
  };
}

export function computeIdDelta(current: number[], next: number[]): { added: number[]; removed: number[] } {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    added: next.filter((id) => !currentSet.has(id)).sort((a, b) => a - b),
    removed: current.filter((id) => !nextSet.has(id)).sort((a, b) => a - b),
  };
}

export function buildHeadAuditEvents(input: {
  scope: 'workshop' | 'direction';
  entityId: number;
  currentUser: CurrentUser;
  requestId?: string;
  idempotencyKey: string;
  added: number[];
  removed: number[];
}): AuditEvent[] {
  const entityType = input.scope;
  const addedName = input.scope === 'workshop' ? 'ORG_WORKSHOP_HEAD_ADDED' : 'ORG_DIRECTION_HEAD_ADDED';
  const removedName = input.scope === 'workshop' ? 'ORG_WORKSHOP_HEAD_REMOVED' : 'ORG_DIRECTION_HEAD_REMOVED';
  const base = (event: string, userId: number, before: unknown, after: unknown): AuditEvent => ({
    event,
    entityType,
    entityId: input.entityId,
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username,
    actorRole: input.currentUser.role,
    requestId: input.requestId ?? SOURCE,
    source: SOURCE,
    relatedUserId: userId,
    before: before as Record<string, unknown> | null,
    after: after as Record<string, unknown> | null,
    metadata: { idempotencyKey: input.idempotencyKey },
  });
  return [
    ...input.added.map((u) => base(addedName, u, null, { userId: u })),
    ...input.removed.map((u) => base(removedName, u, { userId: u }, null)),
  ];
}

function toNullableUserId(value: string | number): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function rethrowUniqueName(err: unknown): never {
  if ((err as { code?: string }).code === '23505') {
    throw new ApiError(409, 'ORG_DIRECTION_NAME_TAKEN', 'A direction with this name already exists');
  }
  throw err;
}

// ── Shared loaders / guards ────────────────────────────────────────────────

async function ensureWorkshopExists(db: DatabaseClient, workshopId: number): Promise<void> {
  const r = await db.query('SELECT workshop_id FROM public.workshops WHERE workshop_id = $1::smallint', [workshopId]);
  if (!r.rows[0]) throw new ApiError(404, 'ORG_WORKSHOP_NOT_FOUND', 'Workshop not found', { workshopId });
}

async function loadDirectionDetail(db: DatabaseClient, directionId: number): Promise<DirectionDetailDto> {
  const head = await db.query<DirectionSummaryRow>(
    `SELECT direction_id, direction_name, description, is_active FROM public.directions WHERE direction_id = $1::smallint`,
    [directionId],
  );
  if (!head.rows[0]) throw new ApiError(404, 'ORG_DIRECTION_NOT_FOUND', 'Direction not found', { directionId });
  const workshops = await db.query<{ workshop_id: number; name: string }>(
    `SELECT w.workshop_id, w.workshop_name AS name
       FROM public.direction_workshops dw JOIN public.workshops w ON w.workshop_id = dw.workshop_id
      WHERE dw.direction_id = $1::smallint ORDER BY w.workshop_name ASC`,
    [directionId],
  );
  const workCenters = await db.query<{ workcenter_id: number; workshop_id: number; name: string }>(
    `SELECT wc.workcenter_id, wc.workshop_id, wc.workcenter_name AS name
       FROM public.direction_work_centers dwc JOIN public.work_centers wc ON wc.workcenter_id = dwc.workcenter_id
      WHERE dwc.direction_id = $1::smallint ORDER BY wc.workcenter_name ASC`,
    [directionId],
  );
  return {
    directionId: Number(head.rows[0].direction_id),
    directionName: head.rows[0].direction_name,
    description: head.rows[0].description,
    isActive: head.rows[0].is_active,
    workshops: workshops.rows.map((r) => ({ workshopId: Number(r.workshop_id), name: r.name })),
    workCenters: workCenters.rows.map((r) => ({
      workcenterId: Number(r.workcenter_id),
      workshopId: Number(r.workshop_id),
      name: r.name,
    })),
    heads: await loadDirectionHeads(db, directionId),
  };
}

async function loadDirectionHeads(db: DatabaseClient, directionId: number): Promise<HeadDto[]> {
  const r = await db.query<{ user_id: number; display_name: string | null; is_active: boolean }>(
    `SELECT dh.user_id, COALESCE(e.full_name, u.full_name, u.username) AS display_name, u.is_active
       FROM public.direction_heads dh
       JOIN public.users u ON u.user_id = dh.user_id
       LEFT JOIN public.employees e ON e.employee_id = u.employee_id
      WHERE dh.direction_id = $1::smallint AND dh.is_active = true
      ORDER BY display_name ASC, dh.user_id ASC`,
    [directionId],
  );
  return r.rows.map((row) => ({ userId: Number(row.user_id), displayName: row.display_name, isActive: row.is_active }));
}

async function loadWorkshopHeads(db: DatabaseClient, workshopId: number): Promise<HeadDto[]> {
  const r = await db.query<{ user_id: number; display_name: string | null; is_active: boolean }>(
    `SELECT wh.user_id, COALESCE(e.full_name, u.full_name, u.username) AS display_name, u.is_active
       FROM public.workshop_heads wh
       JOIN public.users u ON u.user_id = wh.user_id
       LEFT JOIN public.employees e ON e.employee_id = u.employee_id
      WHERE wh.workshop_id = $1::smallint AND wh.is_active = true
      ORDER BY display_name ASC, wh.user_id ASC`,
    [workshopId],
  );
  return r.rows.map((row) => ({ userId: Number(row.user_id), displayName: row.display_name, isActive: row.is_active }));
}

// ── Membership / idempotency helpers ────────────────────────────────────────

interface MembershipConfig {
  table: string;
  idColumn: string;
  refTable: string;
  refId: string;
  commandName: string;
  addedKey: string;
  removedKey: string;
  notFound: [string, string];
}

function hashIdSet(actorUserId: string | number, parentId: number, ids: number[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ actorUserId: String(actorUserId), parentId, ids: [...ids].sort((a, b) => a - b) }))
    .digest('hex');
}

async function validateActiveUsers(tx: DatabaseClient, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const r = await tx.query<{ user_id: number }>(
    `SELECT user_id FROM public.users WHERE user_id = ANY($1::bigint[]) AND is_active = true FOR KEY SHARE`,
    [ids],
  );
  const found = new Set(r.rows.map((row) => Number(row.user_id)));
  const missing = ids.find((id) => !found.has(id));
  if (missing !== undefined) {
    throw new ApiError(422, 'ORG_HEAD_NOT_ACTIVE_USER', 'Head must be an existing active user', { userId: missing });
  }
}

async function validateIdSet(
  tx: DatabaseClient,
  refTable: string,
  refId: string,
  ids: number[],
  notFound: [string, string],
): Promise<void> {
  if (ids.length === 0) return;
  const r = await tx.query<{ id: number }>(
    `SELECT ${refId} AS id FROM public.${refTable} WHERE ${refId} = ANY($1::smallint[]) FOR KEY SHARE`,
    [ids],
  );
  const found = new Set(r.rows.map((row) => Number(row.id)));
  const missing = ids.find((id) => !found.has(id));
  if (missing !== undefined) throw new ApiError(422, notFound[0], notFound[1], { id: missing });
}

async function ensureDirectionExistsForUpdate(tx: DatabaseClient, directionId: number): Promise<void> {
  const r = await tx.query('SELECT direction_id FROM public.directions WHERE direction_id=$1::smallint FOR UPDATE', [
    directionId,
  ]);
  if (!r.rows[0]) throw new ApiError(404, 'ORG_DIRECTION_NOT_FOUND', 'Direction not found', { directionId });
}

async function ensureWorkshopExistsForUpdate(tx: DatabaseClient, workshopId: number): Promise<void> {
  const r = await tx.query('SELECT workshop_id FROM public.workshops WHERE workshop_id=$1::smallint FOR UPDATE', [
    workshopId,
  ]);
  if (!r.rows[0]) throw new ApiError(404, 'ORG_WORKSHOP_NOT_FOUND', 'Workshop not found', { workshopId });
}

interface IdempotencyInput {
  idempotencyKey: string;
  commandName: string;
  actorUserId: string | number;
  entityType: string;
  entityId: string;
  requestHash: string;
}

async function reconcileIdempotency(
  tx: DatabaseClient,
  input: IdempotencyInput,
): Promise<{ completed: boolean; response?: unknown }> {
  const inserted = await tx.query<{ request_hash: string; status: string }>(
    `INSERT INTO command_idempotency_keys (idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'processing')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING request_hash, status`,
    [input.idempotencyKey, input.commandName, toNullableUserId(input.actorUserId), input.entityType, input.entityId, input.requestHash],
  );
  if (inserted.rows[0]) return { completed: false };
  const existing = await tx.query<{ request_hash: string; status: string; response_json: unknown }>(
    `SELECT request_hash, status, response_json FROM command_idempotency_keys WHERE idempotency_key=$1 FOR UPDATE`,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
      idempotencyKey: input.idempotencyKey,
    });
  }
  if (row.request_hash !== input.requestHash) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request', {
      idempotencyKey: input.idempotencyKey,
    });
  }
  // Replay returns the ORIGINAL committed response (matching projects pattern),
  // not the current DB state — the latter can drift if another write landed
  // between the first call and the retry.
  if (row.status === 'completed') return { completed: true, response: parseStoredJson(row.response_json) };
  if (row.status === 'failed') {
    throw new ApiError(409, 'IDEMPOTENCY_FAILED', 'Idempotent command previously failed', {
      idempotencyKey: input.idempotencyKey,
    });
  }
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing', {
    idempotencyKey: input.idempotencyKey,
  });
}

async function completeIdempotency(tx: DatabaseClient, idempotencyKey: string, response: unknown): Promise<void> {
  await tx.query(
    `UPDATE command_idempotency_keys SET status='completed', response_json=$2::jsonb, completed_at=now() WHERE idempotency_key=$1`,
    [idempotencyKey, JSON.stringify(response)],
  );
}

function parseStoredJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

interface DirectionSummaryRow extends QueryResultRow {
  direction_id: number;
  direction_name: string;
  description: string | null;
  is_active: boolean;
  workshop_count?: string;
  work_center_count?: string;
  head_count?: string;
}

function mapDirectionSummary(row: DirectionSummaryRow): DirectionSummaryDto {
  return {
    directionId: Number(row.direction_id),
    directionName: row.direction_name,
    description: row.description,
    isActive: row.is_active,
    workshopCount: Number(row.workshop_count ?? 0),
    workCenterCount: Number(row.work_center_count ?? 0),
    headCount: Number(row.head_count ?? 0),
  };
}

// ── Fail-closed adapter (503 when DB is not configured) ─────────────────────

function orgUnavailable(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Org management adapter is not configured', { feature: 'org' });
}

export class UnavailableOrgRepository implements OrgRepositoryPort {
  listDirections(): never {
    throw orgUnavailable();
  }
  getDirection(): never {
    throw orgUnavailable();
  }
  createDirection(): never {
    throw orgUnavailable();
  }
  updateDirection(): never {
    throw orgUnavailable();
  }
  deleteDirection(): never {
    throw orgUnavailable();
  }
  replaceDirectionWorkshops(): never {
    throw orgUnavailable();
  }
  replaceDirectionWorkCenters(): never {
    throw orgUnavailable();
  }
  replaceDirectionHeads(): never {
    throw orgUnavailable();
  }
  listWorkshopHeads(): never {
    throw orgUnavailable();
  }
  replaceWorkshopHeads(): never {
    throw orgUnavailable();
  }
  assignableUsers(): never {
    throw orgUnavailable();
  }
  lookupWorkshops(): never {
    throw orgUnavailable();
  }
  lookupWorkCenters(): never {
    throw orgUnavailable();
  }
}
