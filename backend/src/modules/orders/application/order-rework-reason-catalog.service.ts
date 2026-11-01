import { randomBytes } from 'crypto';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';

/**
 * Catalogue of «Переделка» reasons (/configuration, plan §9). Codes are immutable
 * (snapshot import resolves reasons by code); the system reason «Уточнить»
 * (`unclarified`) is read-only. Rows are never deleted — deactivation hides a
 * reason from new rounds while existing rounds keep it.
 */

const SOURCE = 'backend-order-rework-reasons';
/** Serializes catalogue writes: the case-insensitive name check and the insert/rename are atomic. */
const CATALOG_LOCK = 'order-rework-reasons-catalog';
const PERMISSION = 'references.manage';

export interface OrderReworkReasonCatalogItemDto {
  reasonId: number;
  code: string;
  name: string;
  requiresComment: boolean;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  usedRounds: number;
  updatedAt: string;
}

const nameSchema = z.string().trim().min(1).max(100);
const sortOrderSchema = z.number().int().min(0).max(100000);

export const createReworkReasonSchema = z.object({
  name: nameSchema,
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
  requiresComment: z.boolean().optional(),
  sortOrder: sortOrderSchema.optional(),
}).strict();

export const updateReworkReasonSchema = z.object({
  expectedUpdatedAt: z.string().min(1).max(64),
  name: nameSchema.optional(),
  requiresComment: z.boolean().optional(),
  sortOrder: sortOrderSchema.optional(),
  isActive: z.boolean().optional(),
}).strict();

export type CreateReworkReasonDto = z.infer<typeof createReworkReasonSchema>;
export type UpdateReworkReasonDto = z.infer<typeof updateReworkReasonSchema>;

export function parseReworkReasonRequest<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректные данные причины переделки', {
      errors: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

interface CatalogRow extends QueryResultRow {
  order_rework_reason_id: string | number;
  code: string;
  name: string;
  requires_comment: boolean;
  is_system: boolean;
  is_active: boolean;
  sort_order: string | number;
  used_rounds: string | number;
  updated_at: string;
}

const SELECT_ITEM = `
  SELECT r.order_rework_reason_id, r.code, r.name, r.requires_comment, r.is_system, r.is_active, r.sort_order,
         to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
         (SELECT count(*) FROM order_production_rounds p WHERE p.reason_id = r.order_rework_reason_id) AS used_rounds
  FROM order_rework_reasons r`;

export class OrderReworkReasonCatalogService {
  constructor(private readonly database: DatabaseService) {}

  async list(currentUser: CurrentUser): Promise<{ data: OrderReworkReasonCatalogItemDto[] }> {
    requireManage(currentUser);
    const rows = await this.database.query<CatalogRow>(`${SELECT_ITEM} ORDER BY r.is_system, r.sort_order, r.name`);
    return { data: rows.rows.map(mapItem) };
  }

  async create(currentUser: CurrentUser, dto: CreateReworkReasonDto, requestId?: string): Promise<OrderReworkReasonCatalogItemDto> {
    requireManage(currentUser);
    return withDuplicateMapping(() => this.database.transaction(async (tx) => {
      await lockCatalog(tx);
      const code = dto.code ?? `custom_${randomBytes(4).toString('hex')}`;
      await assertUnique(tx, dto.name, code, null);
      const id = Number((await tx.query<{ id: string | number }>(
        `INSERT INTO order_rework_reasons (code, name, requires_comment, is_system, sort_order, created_by_user_id, updated_by_user_id)
         VALUES ($1, $2, $3, false, $4, $5, $5)
         RETURNING order_rework_reason_id AS id`,
        [code, dto.name, dto.requiresComment ?? false, dto.sortOrder ?? 100, actorId(currentUser)],
      )).rows[0].id);
      const item = await readItem(tx, id);
      await audit(tx, 'order_rework_reason.created', currentUser, requestId, id, null, item);
      return item;
    }));
  }

  async update(
    currentUser: CurrentUser,
    reasonId: number,
    dto: UpdateReworkReasonDto,
    requestId?: string,
  ): Promise<OrderReworkReasonCatalogItemDto> {
    requireManage(currentUser);
    return withDuplicateMapping(() => this.database.transaction(async (tx) => {
      await lockCatalog(tx);
      const locked = (await tx.query<CatalogRow>(
        `${SELECT_ITEM} WHERE r.order_rework_reason_id = $1 FOR UPDATE OF r`,
        [reasonId],
      )).rows[0];
      if (!locked) throw new ApiError(404, 'ORDER_REWORK_REASON_NOT_FOUND', 'Причина переделки не найдена');
      const before = mapItem(locked);
      if (before.isSystem) {
        throw new ApiError(409, 'ORDER_REWORK_REASON_SYSTEM', 'Системную причину «Уточнить» изменить нельзя');
      }
      if (dto.expectedUpdatedAt !== before.updatedAt) {
        throw new ApiError(409, 'ORDER_REWORK_REASON_STALE', 'Причину уже изменили, обновите список', { current: before });
      }
      const next = {
        name: dto.name ?? before.name,
        requiresComment: dto.requiresComment ?? before.requiresComment,
        sortOrder: dto.sortOrder ?? before.sortOrder,
        isActive: dto.isActive ?? before.isActive,
      };
      if (next.name !== before.name) await assertUnique(tx, next.name, null, reasonId);
      await tx.query(
        `UPDATE order_rework_reasons
         SET name = $2, requires_comment = $3, sort_order = $4, is_active = $5,
             updated_by_user_id = $6, updated_at = clock_timestamp()
         WHERE order_rework_reason_id = $1`,
        [reasonId, next.name, next.requiresComment, next.sortOrder, next.isActive, actorId(currentUser)],
      );
      const after = await readItem(tx, reasonId);
      await audit(tx, 'order_rework_reason.updated', currentUser, requestId, reasonId, before, after);
      return after;
    }));
  }
}

async function lockCatalog(tx: TransactionClient): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CATALOG_LOCK]);
}

/** A unique-constraint race (name/code) is a 409, never a 500. */
async function withDuplicateMapping<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if ((error as { code?: string } | null)?.code === '23505') {
      throw new ApiError(409, 'ORDER_REWORK_REASON_DUPLICATE', 'Причина с таким названием или кодом уже есть');
    }
    throw error;
  }
}

function requireManage(currentUser: CurrentUser): void {
  if (!currentUser.permissions.includes(PERMISSION)) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
      requiredPermissions: [PERMISSION],
    });
  }
}

async function assertUnique(tx: TransactionClient, name: string, code: string | null, exceptId: number | null): Promise<void> {
  const clash = (await tx.query<{ field: string }>(
    `SELECT CASE WHEN lower(name) = lower($1) THEN 'name' ELSE 'code' END AS field
     FROM order_rework_reasons
     WHERE (lower(name) = lower($1) OR code = $2) AND ($3::int IS NULL OR order_rework_reason_id <> $3)
     LIMIT 1`,
    [name, code, exceptId],
  )).rows[0];
  if (clash) {
    throw new ApiError(409, 'ORDER_REWORK_REASON_DUPLICATE',
      clash.field === 'name' ? 'Причина с таким названием уже есть' : 'Причина с таким кодом уже есть', { field: clash.field });
  }
}

async function readItem(tx: TransactionClient, id: number): Promise<OrderReworkReasonCatalogItemDto> {
  return mapItem((await tx.query<CatalogRow>(`${SELECT_ITEM} WHERE r.order_rework_reason_id = $1`, [id])).rows[0]);
}

async function audit(
  tx: TransactionClient,
  event: string,
  currentUser: CurrentUser,
  requestId: string | undefined,
  reasonId: number,
  before: OrderReworkReasonCatalogItemDto | null,
  after: OrderReworkReasonCatalogItemDto,
): Promise<void> {
  const strip = (item: OrderReworkReasonCatalogItemDto | null) => item && {
    code: item.code, name: item.name, requiresComment: item.requiresComment, sortOrder: item.sortOrder, isActive: item.isActive,
  };
  await auditService.record(tx, {
    event,
    entityType: 'order_rework_reason',
    entityId: reasonId,
    actorUserId: currentUser.id,
    actorUsername: currentUser.username ?? null,
    actorRole: currentUser.role,
    requestId: requestId ?? 'order-rework-reasons',
    source: SOURCE,
    before: strip(before),
    after: strip(after),
    metadata: { reasonId, code: after.code },
  });
}

function mapItem(row: CatalogRow): OrderReworkReasonCatalogItemDto {
  return {
    reasonId: Number(row.order_rework_reason_id),
    code: row.code,
    name: row.name,
    requiresComment: row.requires_comment === true,
    isSystem: row.is_system === true,
    isActive: row.is_active === true,
    sortOrder: Number(row.sort_order),
    usedRounds: Number(row.used_rounds),
    // Microsecond text: the optimistic-concurrency token of PATCH (expectedUpdatedAt).
    updatedAt: row.updated_at,
  };
}

function actorId(currentUser: CurrentUser): number | null {
  const id = Number(currentUser.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
