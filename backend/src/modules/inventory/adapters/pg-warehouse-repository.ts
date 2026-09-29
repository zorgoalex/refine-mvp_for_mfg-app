import { randomUUID } from 'node:crypto';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type {
  CommandContext,
  CreateWarehouseInput,
  UpdateWarehouseInput,
  WarehouseDto,
} from '../application/inventory.types';
import { beginIdempotent, completeIdempotent, requestHash, SOURCE } from './pg-inventory-repository';

// Справочник складов. Порядок блокировок: advisory-замок имён складов (только при
// создании/переименовании) → строка склада FOR UPDATE. Документы склада берут
// строку склада FOR KEY SHARE (assertWarehouse) — отключение ждёт их фиксации.

interface WarehouseRow {
  warehouse_id: number | string;
  warehouse_name: string;
  is_active: boolean;
  workshop_id: number | string | null;
  workshop_name: string | null;
  responsible_employee_id: number | string | null;
  responsible_employee_name: string | null;
  ref_key_1c: string | null;
  films_with_stock: number | string;
  total_quantity: number | string;
  draft_documents: number | string;
  version: string;
}

const WAREHOUSE_SELECT = `
  SELECT w.warehouse_id, w.warehouse_name, w.is_active, w.workshop_id, ws.workshop_name,
         w.responsible_employee_id, e.full_name AS responsible_employee_name, w.ref_key_1c::text AS ref_key_1c,
         (SELECT count(*) FROM stock_balances b WHERE b.warehouse_id = w.warehouse_id AND b.quantity <> 0) AS films_with_stock,
         (SELECT COALESCE(sum(b.quantity), 0) FROM stock_balances b WHERE b.warehouse_id = w.warehouse_id) AS total_quantity,
         (SELECT count(*) FROM stock_documents d WHERE d.warehouse_id = w.warehouse_id AND d.status = 'draft') AS draft_documents,
         w.updated_at::text AS version
    FROM warehouses w
    LEFT JOIN workshops ws ON ws.workshop_id = w.workshop_id
    LEFT JOIN employees e ON e.employee_id = w.responsible_employee_id`;

const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function toDto(row: WarehouseRow): WarehouseDto {
  return {
    warehouseId: Number(row.warehouse_id),
    name: row.warehouse_name,
    isActive: row.is_active === true,
    workshopId: numOrNull(row.workshop_id),
    workshopName: row.workshop_name,
    responsibleEmployeeId: numOrNull(row.responsible_employee_id),
    responsibleEmployeeName: row.responsible_employee_name,
    refKey1c: row.ref_key_1c,
    filmsWithStock: Number(row.films_with_stock),
    totalQuantity: Number(row.total_quantity),
    draftDocuments: Number(row.draft_documents),
    version: row.version,
  };
}

/** Бизнес-поля склада для аудита (без служебных счётчиков и версии). */
function auditShape(dto: WarehouseDto): Record<string, unknown> {
  return {
    name: dto.name,
    isActive: dto.isActive,
    workshopId: dto.workshopId,
    responsibleEmployeeId: dto.responsibleEmployeeId,
  };
}

async function readWarehouse(client: DatabaseClient, warehouseId: number): Promise<WarehouseDto | null> {
  const rows = await client.query<WarehouseRow>(`${WAREHOUSE_SELECT} WHERE w.warehouse_id = $1`, [warehouseId]);
  return rows.rows[0] ? toDto(rows.rows[0]) : null;
}

function notFound(): ApiError {
  return new ApiError(404, 'WAREHOUSE_NOT_FOUND', 'Склад не найден');
}

/** Сериализация проверки уникальности названий (без учёта регистра и краевых пробелов). */
async function lockWarehouseNames(tx: TransactionClient): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('inventory.warehouse_names'))");
}

async function assertNameFree(tx: TransactionClient, name: string, exceptId: number | null): Promise<void> {
  const rows = await tx.query<{ warehouse_id: number }>(
    `SELECT warehouse_id FROM warehouses
      WHERE lower(btrim(warehouse_name)) = lower(btrim($1)) AND ($2::smallint IS NULL OR warehouse_id <> $2::smallint)`,
    [name, exceptId],
  );
  if (rows.rows.length > 0) {
    throw new ApiError(409, 'WAREHOUSE_NAME_DUPLICATE', 'Склад с таким названием уже есть', { warehouseId: Number(rows.rows[0].warehouse_id) });
  }
}

async function assertReferences(tx: TransactionClient, input: { workshopId?: number | null; responsibleEmployeeId?: number | null }): Promise<void> {
  if (input.workshopId !== undefined && input.workshopId !== null) {
    const rows = await tx.query('SELECT 1 FROM workshops WHERE workshop_id = $1 AND is_active = true', [input.workshopId]);
    if (rows.rows.length === 0) throw new ApiError(422, 'WAREHOUSE_WORKSHOP_NOT_FOUND', 'Цех не найден или неактивен');
  }
  if (input.responsibleEmployeeId !== undefined && input.responsibleEmployeeId !== null) {
    const rows = await tx.query('SELECT 1 FROM employees WHERE employee_id = $1 AND is_active = true', [input.responsibleEmployeeId]);
    if (rows.rows.length === 0) throw new ApiError(422, 'WAREHOUSE_EMPLOYEE_NOT_FOUND', 'Сотрудник не найден или неактивен');
  }
}

/** Связи аудита: склад и цех/ответственный до и после (поиск по прежней связи находит событие). */
function relatedWarehouseEntities(before: WarehouseDto | null, after: WarehouseDto): Array<{ entityType: string; entityId: number }> {
  const workshops = new Set([before?.workshopId, after.workshopId].filter((id): id is number => id !== null && id !== undefined));
  const employees = new Set([before?.responsibleEmployeeId, after.responsibleEmployeeId].filter((id): id is number => id !== null && id !== undefined));
  return [
    { entityType: 'warehouse', entityId: after.warehouseId },
    ...[...workshops].map((entityId) => ({ entityType: 'workshop', entityId })),
    ...[...employees].map((entityId) => ({ entityType: 'employee', entityId })),
  ];
}

async function recordWarehouseChange(
  tx: TransactionClient,
  ctx: CommandContext,
  input: { event: string; action: 'created' | 'updated' | 'deactivated' | 'activated'; before: WarehouseDto | null; after: WarehouseDto },
): Promise<void> {
  const before = input.before ? auditShape(input.before) : null;
  const after = auditShape(input.after);
  const changes = computeDiff(before, after);
  await auditService.record(tx, {
    event: input.event,
    entityType: 'warehouse',
    entityId: input.after.warehouseId,
    actorUserId: ctx.currentUser.id,
    actorUsername: ctx.currentUser.username ?? null,
    actorRole: ctx.currentUser.role ?? null,
    requestId: ctx.requestId,
    source: SOURCE,
    statusField: 'is_active',
    statusCode: input.after.isActive ? 'active' : 'inactive',
    stageCode: input.action,
    before,
    after,
    diff: changes,
    metadata: {
      warehouseId: input.after.warehouseId,
      action: input.action,
      changedFields: Object.keys(changes),
      correlationId: ctx.requestId,
      commandSource: SOURCE,
    },
    relatedEntities: relatedWarehouseEntities(input.before, input.after),
  });
  // Ключ outbox несёт id склада и Idempotency-Key команды: повтор команды не дублирует событие.
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ('inventory.warehouse_changed', 'warehouse', $1, $2::jsonb, $3)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      String(input.after.warehouseId),
      JSON.stringify({
        eventId: randomUUID(), eventType: 'inventory.warehouse_changed', action: input.action,
        actorUserId: ctx.currentUser.id, requestId: ctx.requestId, correlationId: ctx.requestId, source: SOURCE,
        occurredAt: new Date().toISOString(), entity: { type: 'warehouse', id: input.after.warehouseId },
        changes,
      }),
      `inventory:warehouse:${input.after.warehouseId}:${ctx.idempotencyKey}`,
    ],
  );
}

export class PgWarehouseRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(includeInactive: boolean): Promise<WarehouseDto[]> {
    const rows = await this.database.query<WarehouseRow>(
      `${WAREHOUSE_SELECT} WHERE ($1::boolean OR w.is_active = true) ORDER BY w.is_active DESC, w.warehouse_name`,
      [includeInactive],
    );
    return rows.rows.map(toDto);
  }

  async create(ctx: CommandContext, input: CreateWarehouseInput): Promise<WarehouseDto> {
    return this.database.transaction(async (tx) => {
      const replay = await beginIdempotent(tx, {
        key: ctx.idempotencyKey, command: 'inventory.warehouse.create', actorId: ctx.currentUser.id,
        entityType: 'warehouse', entityId: 'new', hash: requestHash(input),
      });
      if (replay !== undefined) return replay as WarehouseDto;
      await tx.query('SELECT set_session_user($1)', [ctx.currentUser.id]);
      await lockWarehouseNames(tx);
      await assertNameFree(tx, input.name, null);
      await assertReferences(tx, input);
      const inserted = await tx.query<{ warehouse_id: number }>(
        `INSERT INTO warehouses (warehouse_name, workshop_id, responsible_employee_id, is_active, created_by, edited_by)
         VALUES ($1, $2, $3, true, $4, $4) RETURNING warehouse_id`,
        [input.name, input.workshopId, input.responsibleEmployeeId, ctx.currentUser.id],
      );
      const warehouseId = Number(inserted.rows[0].warehouse_id);
      const after = await readWarehouse(tx, warehouseId);
      if (!after) throw notFound();
      await recordWarehouseChange(tx, ctx, { event: 'inventory.warehouse_created', action: 'created', before: null, after });
      await completeIdempotent(tx, ctx.idempotencyKey, String(warehouseId), after);
      return after;
    });
  }

  async update(ctx: CommandContext, input: UpdateWarehouseInput): Promise<WarehouseDto> {
    return this.database.transaction(async (tx) => {
      const { warehouseId, version: _version, ...changes } = input;
      const replay = await beginIdempotent(tx, {
        key: ctx.idempotencyKey, command: 'inventory.warehouse.update', actorId: ctx.currentUser.id,
        entityType: 'warehouse', entityId: String(warehouseId), hash: requestHash(input),
      });
      if (replay !== undefined) return replay as WarehouseDto;
      await tx.query('SELECT set_session_user($1)', [ctx.currentUser.id]);
      if (changes.name !== undefined) await lockWarehouseNames(tx);
      const locked = await tx.query<{ version: string }>(
        'SELECT updated_at::text AS version FROM warehouses WHERE warehouse_id = $1 FOR UPDATE',
        [warehouseId],
      );
      if (locked.rows.length === 0) throw notFound();
      if (locked.rows[0].version !== input.version) {
        throw new ApiError(409, 'WAREHOUSE_VERSION_CONFLICT', 'Склад изменён другим пользователем — обновите данные', {
          currentVersion: locked.rows[0].version,
        });
      }
      const before = await readWarehouse(tx, warehouseId);
      if (!before) throw notFound();

      const next = {
        name: changes.name ?? before.name,
        workshopId: changes.workshopId !== undefined ? changes.workshopId : before.workshopId,
        responsibleEmployeeId: changes.responsibleEmployeeId !== undefined ? changes.responsibleEmployeeId : before.responsibleEmployeeId,
        isActive: changes.isActive ?? before.isActive,
      };
      const changed = next.name !== before.name || next.workshopId !== before.workshopId
        || next.responsibleEmployeeId !== before.responsibleEmployeeId || next.isActive !== before.isActive;
      if (!changed) {
        await completeIdempotent(tx, ctx.idempotencyKey, String(warehouseId), before);
        return before;
      }
      if (next.name !== before.name) await assertNameFree(tx, next.name, warehouseId);
      await assertReferences(tx, {
        workshopId: next.workshopId !== before.workshopId ? next.workshopId : undefined,
        responsibleEmployeeId: next.responsibleEmployeeId !== before.responsibleEmployeeId ? next.responsibleEmployeeId : undefined,
      });
      if (before.isActive && !next.isActive) {
        // Под FOR UPDATE склада: документы, начатые раньше, уже зафиксированы (их FOR KEY SHARE отпущен),
        // новые — ждут и затем отклоняются как отключённый склад.
        if (before.filmsWithStock > 0) {
          throw new ApiError(409, 'WAREHOUSE_HAS_STOCK', 'На складе есть остатки — отключить нельзя', { filmsWithStock: before.filmsWithStock });
        }
        if (before.draftDocuments > 0) {
          throw new ApiError(409, 'WAREHOUSE_HAS_DRAFTS', 'На складе есть черновики документов — проведите или отмените их', { draftDocuments: before.draftDocuments });
        }
      }
      await tx.query(
        `UPDATE warehouses
            SET warehouse_name = $2, workshop_id = $3, responsible_employee_id = $4, is_active = $5, edited_by = $6
          WHERE warehouse_id = $1`,
        [warehouseId, next.name, next.workshopId, next.responsibleEmployeeId, next.isActive, ctx.currentUser.id],
      );
      const after = await readWarehouse(tx, warehouseId);
      if (!after) throw notFound();
      const action = before.isActive && !after.isActive ? 'deactivated' : !before.isActive && after.isActive ? 'activated' : 'updated';
      await recordWarehouseChange(tx, ctx, {
        event: action === 'updated' ? 'inventory.warehouse_updated' : `inventory.warehouse_${action}`,
        action, before, after,
      });
      await completeIdempotent(tx, ctx.idempotencyKey, String(warehouseId), after);
      return after;
    });
  }
}
