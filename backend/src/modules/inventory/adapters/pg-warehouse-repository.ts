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
  WarehouseSyncResultDto,
} from '../application/inventory.types';
import { beginIdempotent, completeIdempotent, requestHash, SOURCE } from './pg-inventory-repository';

// Справочник складов. Каждый склад ERP привязан к складу 1С (ref_key_1c обязателен,
// миграция 205): документы 1С ссылаются на склады 1С. Порядок блокировок:
// advisory-замок «идентичности» складов (названия и ключи 1С; при создании,
// переименовании, смене ключа и синхронизации) → строки складов FOR UPDATE.
// Документы склада берут строку склада FOR KEY SHARE (assertWarehouse) —
// отключение ждёт их фиксации.

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

/** Дополнения синхронизации для автозапуска (кнопка их не передаёт). */
export interface WarehouseSyncOptions {
  /** В той же транзакции, только при новом выполнении (не при повторе по Idempotency-Key). */
  onFreshResult?: (tx: TransactionClient, result: WarehouseSyncResultDto) => Promise<void>;
  /** Сбросить app.user_id перед commit (служебный исполнитель). */
  resetSessionUser?: boolean;
}

/** Склад 1С, по которому создаётся или привязывается склад ERP. */
export interface OnecWarehouseRef {
  refKey: string;
  name: string;
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
const WAREHOUSE_NAME_MAX = 128;

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
    // Сведения 1С дополняет сервис по зеркалу.
    onecStatus: row.ref_key_1c ? 'unknown' : 'unlinked',
    onecName: null,
    onecCode: null,
  };
}

/** Бизнес-поля склада для аудита (без служебных счётчиков и версии). */
function auditShape(dto: WarehouseDto): Record<string, unknown> {
  return {
    name: dto.name,
    isActive: dto.isActive,
    refKey1c: dto.refKey1c,
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

/** Сериализация проверок уникальности названий (без учёта регистра) и ключей 1С. */
async function lockWarehouseIdentity(tx: TransactionClient): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('inventory.warehouse_identity'))");
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

async function assertKeyFree(tx: TransactionClient, refKey: string, exceptId: number | null): Promise<void> {
  const rows = await tx.query<{ warehouse_id: number; warehouse_name: string }>(
    `SELECT warehouse_id, warehouse_name FROM warehouses
      WHERE ref_key_1c = $1::uuid AND ($2::smallint IS NULL OR warehouse_id <> $2::smallint)`,
    [refKey, exceptId],
  );
  if (rows.rows.length > 0) {
    throw new ApiError(409, 'WAREHOUSE_1C_KEY_TAKEN', `Склад 1С уже привязан к складу «${rows.rows[0].warehouse_name}»`, {
      warehouseId: Number(rows.rows[0].warehouse_id),
    });
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

type WarehouseAction = 'created' | 'updated' | 'deactivated' | 'activated' | 'linked';

async function recordWarehouseChange(
  tx: TransactionClient,
  ctx: CommandContext,
  input: { event: string; action: WarehouseAction; before: WarehouseDto | null; after: WarehouseDto; commandSource?: string },
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
    actorRole: ctx.actorRole ?? ctx.currentUser.role ?? null,
    requestId: ctx.requestId,
    source: ctx.source ?? SOURCE,
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
      refKey1c: input.after.refKey1c,
      correlationId: ctx.correlationId ?? ctx.requestId,
      commandSource: input.commandSource ?? SOURCE,
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
        actorUserId: ctx.currentUser.id, requestId: ctx.requestId, correlationId: ctx.correlationId ?? ctx.requestId, source: ctx.source ?? SOURCE,
        occurredAt: new Date().toISOString(), entity: { type: 'warehouse', id: input.after.warehouseId },
        refKey1c: input.after.refKey1c, changes,
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

  /**
   * `validateKey` (проверка ключа по зеркалу 1С) вызывается только при новом выполнении и
   * получает текущую транзакцию (зеркало читается через неё, без второго соединения пула) —
   * повтор по Idempotency-Key возвращает сохранённый результат, даже если зеркало изменилось.
   */
  async create(ctx: CommandContext, input: CreateWarehouseInput, validateKey?: (tx: TransactionClient, refKey: string) => Promise<void>): Promise<WarehouseDto> {
    return this.database.transaction(async (tx) => {
      const replay = await beginIdempotent(tx, {
        key: ctx.idempotencyKey, command: 'inventory.warehouse.create', actorId: ctx.currentUser.id,
        entityType: 'warehouse', entityId: 'new', hash: requestHash(input),
      });
      if (replay !== undefined) return replay as WarehouseDto;
      if (validateKey) await validateKey(tx, input.refKey1c);
      await tx.query('SELECT set_session_user($1)', [ctx.currentUser.id]);
      await lockWarehouseIdentity(tx);
      await assertNameFree(tx, input.name, null);
      await assertKeyFree(tx, input.refKey1c, null);
      await assertReferences(tx, input);
      const inserted = await tx.query<{ warehouse_id: number }>(
        `INSERT INTO warehouses (warehouse_name, ref_key_1c, workshop_id, responsible_employee_id, is_active, created_by, edited_by)
         VALUES ($1, $2::uuid, $3, $4, true, $5, $5) RETURNING warehouse_id`,
        [input.name, input.refKey1c, input.workshopId, input.responsibleEmployeeId, ctx.currentUser.id],
      );
      const warehouseId = Number(inserted.rows[0].warehouse_id);
      const after = await readWarehouse(tx, warehouseId);
      if (!after) throw notFound();
      await recordWarehouseChange(tx, ctx, { event: 'inventory.warehouse_created', action: 'created', before: null, after });
      await completeIdempotent(tx, ctx.idempotencyKey, String(warehouseId), after);
      return after;
    });
  }

  async update(ctx: CommandContext, input: UpdateWarehouseInput, validateKey?: (tx: TransactionClient, refKey: string) => Promise<void>): Promise<WarehouseDto> {
    return this.database.transaction(async (tx) => {
      const { warehouseId, version: _version, ...changes } = input;
      const replay = await beginIdempotent(tx, {
        key: ctx.idempotencyKey, command: 'inventory.warehouse.update', actorId: ctx.currentUser.id,
        entityType: 'warehouse', entityId: String(warehouseId), hash: requestHash(input),
      });
      if (replay !== undefined) return replay as WarehouseDto;
      await tx.query('SELECT set_session_user($1)', [ctx.currentUser.id]);
      if (changes.name !== undefined || changes.refKey1c !== undefined) await lockWarehouseIdentity(tx);
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
        refKey1c: changes.refKey1c ?? before.refKey1c,
        workshopId: changes.workshopId !== undefined ? changes.workshopId : before.workshopId,
        responsibleEmployeeId: changes.responsibleEmployeeId !== undefined ? changes.responsibleEmployeeId : before.responsibleEmployeeId,
        isActive: changes.isActive ?? before.isActive,
      };
      const changed = next.name !== before.name || next.refKey1c !== before.refKey1c || next.workshopId !== before.workshopId
        || next.responsibleEmployeeId !== before.responsibleEmployeeId || next.isActive !== before.isActive;
      if (!changed) {
        await completeIdempotent(tx, ctx.idempotencyKey, String(warehouseId), before);
        return before;
      }
      // Любое сохранение склада без ключа 1С отклоняется (миграция 205 проверяет то же).
      if (next.refKey1c === null) {
        throw new ApiError(422, 'WAREHOUSE_1C_KEY_REQUIRED', 'Укажите склад 1С — без него склад сохранить нельзя');
      }
      if (next.name !== before.name) await assertNameFree(tx, next.name, warehouseId);
      if (next.refKey1c !== before.refKey1c) {
        if (validateKey) await validateKey(tx, next.refKey1c);
        await assertKeyFree(tx, next.refKey1c, warehouseId);
      }
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
            SET warehouse_name = $2, ref_key_1c = $3::uuid, workshop_id = $4, responsible_employee_id = $5, is_active = $6, edited_by = $7
          WHERE warehouse_id = $1`,
        [warehouseId, next.name, next.refKey1c, next.workshopId, next.responsibleEmployeeId, next.isActive, ctx.currentUser.id],
      );
      const after = await readWarehouse(tx, warehouseId);
      if (!after) throw notFound();
      const action: WarehouseAction = before.isActive && !after.isActive ? 'deactivated'
        : !before.isActive && after.isActive ? 'activated'
          : before.refKey1c === null ? 'linked' : 'updated';
      await recordWarehouseChange(tx, ctx, {
        event: action === 'deactivated' || action === 'activated' ? `inventory.warehouse_${action}` : 'inventory.warehouse_updated',
        action, before, after,
      });
      await completeIdempotent(tx, ctx.idempotencyKey, String(warehouseId), after);
      return after;
    });
  }

  /**
   * Синхронизация со складами 1С: для каждого склада 1С без склада ERP — привязать
   * непривязанный склад ERP с тем же названием или создать новый (название из 1С).
   * Склад ERP с тем же названием, но другим ключом 1С — пропуск (name_taken).
   */
  async syncFromOnec(
    ctx: CommandContext,
    loadOnec: (tx: TransactionClient) => Promise<OnecWarehouseRef[]>,
    options: WarehouseSyncOptions = {},
  ): Promise<WarehouseSyncResultDto> {
    return this.database.transaction(async (tx) => {
      // Хеш — только от содержимого запроса (тела нет): повтор не зависит от текущего зеркала 1С.
      const replay = await beginIdempotent(tx, {
        key: ctx.idempotencyKey, command: 'inventory.warehouse.sync_onec', actorId: ctx.currentUser.id,
        entityType: 'warehouse', entityId: 'onec', hash: requestHash({ command: 'inventory.warehouse.sync_onec' }),
      });
      if (replay !== undefined) return replay as WarehouseSyncResultDto;
      const ordered = [...await loadOnec(tx)].sort((a, b) => a.refKey.localeCompare(b.refKey));
      await tx.query('SELECT set_session_user($1)', [ctx.currentUser.id]);
      await lockWarehouseIdentity(tx);
      const existing = await tx.query<{ warehouse_id: number; warehouse_name: string; ref_key_1c: string | null }>(
        'SELECT warehouse_id, warehouse_name, ref_key_1c::text AS ref_key_1c FROM warehouses ORDER BY warehouse_id FOR UPDATE',
      );
      const byKey = new Set(existing.rows.flatMap((row) => (row.ref_key_1c ? [row.ref_key_1c.toLowerCase()] : [])));
      const byName = new Map(existing.rows.map((row) => [row.warehouse_name.trim().toLowerCase(), row]));
      const result: WarehouseSyncResultDto = { created: [], linked: [], skipped: [] };
      for (const warehouse of ordered) {
        const refKey = warehouse.refKey.toLowerCase();
        if (byKey.has(refKey)) continue;
        const name = warehouse.name.trim().slice(0, WAREHOUSE_NAME_MAX);
        const sameName = byName.get(name.toLowerCase());
        if (sameName && sameName.ref_key_1c !== null) {
          result.skipped.push({ refKey, name, reason: 'name_taken' });
          continue;
        }
        if (sameName) {
          const before = await readWarehouse(tx, Number(sameName.warehouse_id));
          if (!before) throw notFound();
          await tx.query('UPDATE warehouses SET ref_key_1c = $2::uuid, edited_by = $3 WHERE warehouse_id = $1', [before.warehouseId, refKey, ctx.currentUser.id]);
          const after = await readWarehouse(tx, before.warehouseId);
          if (!after) throw notFound();
          await recordWarehouseChange(tx, ctx, { event: 'inventory.warehouse_updated', action: 'linked', before, after, commandSource: 'onec_sync' });
          result.linked.push(after);
          sameName.ref_key_1c = refKey;
        } else {
          const inserted = await tx.query<{ warehouse_id: number }>(
            `INSERT INTO warehouses (warehouse_name, ref_key_1c, is_active, created_by, edited_by)
             VALUES ($1, $2::uuid, true, $3, $3) RETURNING warehouse_id`,
            [name, refKey, ctx.currentUser.id],
          );
          const after = await readWarehouse(tx, Number(inserted.rows[0].warehouse_id));
          if (!after) throw notFound();
          await recordWarehouseChange(tx, ctx, { event: 'inventory.warehouse_created', action: 'created', before: null, after, commandSource: 'onec_sync' });
          result.created.push(after);
          byName.set(name.toLowerCase(), { warehouse_id: after.warehouseId, warehouse_name: name, ref_key_1c: refKey });
        }
        byKey.add(refKey);
      }
      await completeIdempotent(tx, ctx.idempotencyKey, 'onec', result);
      if (options.onFreshResult) await options.onFreshResult(tx, result);
      // set_session_user — сеансовая настройка: без сброса соединение пула после commit
      // несло бы этого исполнителя в следующие команды. При rollback откатывается сама.
      if (options.resetSessionUser) await tx.query("SELECT set_config('app.user_id', '', false)");
      return result;
    });
  }
}
