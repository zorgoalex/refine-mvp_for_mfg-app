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

// NOTE: write methods are added in Tasks 7-8; once the class satisfies every
// OrgRepositoryPort member it will declare `implements OrgRepositoryPort`.
export class PgOrgRepository {
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
