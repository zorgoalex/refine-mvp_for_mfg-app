import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { OnecAuditWriter, type OnecRequestContext } from './onec-audit';

/**
 * ERP → 1C business commands, phase 1 (plan 2026-11-04 §8.2): the mapping store. Each ERP item of a kind maps to a 1C
 * ref picked from the ETL mirror and/or to a fixed 1C value. Nothing is sent to 1C here; the commands read these
 * mappings as a precondition. Edited only through this service (onec.write.mappings), every change audited.
 */
export const ONEC_WRITE_MAPPING_KINDS = [
  'order_status', 'shift_state', 'production_stage', 'workshop',
  'user_author', 'user_responsible', 'payment_type_account',
  'milling_nomenclature', 'mdf_nomenclature', 'delivery_nomenclature', 'remainder_nomenclature',
  'film_group',
] as const;
export type OnecWriteMappingKind = (typeof ONEC_WRITE_MAPPING_KINDS)[number];

/** «Заказы» extension enum `ПроизводственныйСтатус` (to-erp/0197 §4); empty is allowed. */
export const ONEC_PRODUCTION_STATUS_VALUES = ['Запланирован', 'ВРаботе', 'ГотовКВыдаче', 'Выдан'] as const;
/** `ВариантыЗавершенияЗаказа` for the final order state. */
export const ONEC_COMPLETION_VALUES = ['Успешно', 'Отменен'] as const;

type CandidateFilter = 'all' | 'items' | 'item_folders' | 'own_bank_accounts' | 'active_users' | 'active_employees';

interface KindSpec {
  label: string;
  /** ERP items of the kind: rows (erp_key, label), in display order. */
  erpItemsSql: string;
  /** Mirror entities the ref comes from; empty — no ref (value only). */
  entities: readonly string[];
  filter: CandidateFilter;
  refRequired: boolean;
  /** Fixed 1C value of the kind, validated by `valueSchema`. */
  valueSchema: z.ZodType<Record<string, unknown> | null> | null;
  /** Shown when the mirror has no candidates yet (the 1C side has not published the catalog). */
  pendingNote?: string;
}

const nullableObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict().nullable() as unknown as z.ZodType<Record<string, unknown> | null>;

const SPECS: Record<OnecWriteMappingKind, KindSpec> = {
  order_status: {
    label: 'Статусы заказа → состояния заказа покупателя 1С',
    erpItemsSql: `SELECT 'order_status:' || order_status_id AS erp_key, order_status_name AS label FROM order_statuses
                   WHERE is_active IS NOT FALSE ORDER BY sort_order, order_status_id`,
    entities: ['order_states'], filter: 'all', refRequired: true,
    valueSchema: nullableObject({ completion: z.enum(ONEC_COMPLETION_VALUES).optional() }),
  },
  shift_state: {
    label: 'Смены цехов → состояния «N смена В производстве»',
    erpItemsSql: `SELECT 'shift:' || n AS erp_key, n || ' смена' AS label FROM generate_series(1, 3) n ORDER BY n`,
    entities: ['order_states'], filter: 'all', refRequired: true, valueSchema: null,
  },
  production_stage: {
    label: 'Производственные статусы → производственный статус заказа 1С',
    erpItemsSql: `SELECT 'production_status:' || production_status_id AS erp_key, production_status_name AS label
                    FROM production_statuses WHERE is_active IS NOT FALSE ORDER BY sort_order, production_status_id`,
    entities: [], filter: 'all', refRequired: false,
    valueSchema: z.object({ productionStatus: z.enum(ONEC_PRODUCTION_STATUS_VALUES).nullable() }).strict(),
  },
  workshop: {
    label: 'Цеха → справочник «Цеха» 1С',
    erpItemsSql: `SELECT 'workshop:' || workshop_id AS erp_key, workshop_name AS label FROM workshops
                   WHERE is_active IS NOT FALSE ORDER BY sort_order, workshop_id`,
    entities: ['workshops'], filter: 'all', refRequired: true, valueSchema: null,
    pendingNote: 'Справочник «Цеха» 1С ещё не выгружается: сторона 1С публикует его в OData.',
  },
  user_author: {
    label: 'Пользователи ERP → автор документа (пользователь 1С)',
    erpItemsSql: `SELECT 'user:' || user_id AS erp_key, COALESCE(NULLIF(btrim(full_name), ''), username) AS label FROM users
                   WHERE is_active AND NOT COALESCE(is_service_account, false) ORDER BY 2, user_id`,
    entities: ['users'], filter: 'active_users', refRequired: true, valueSchema: null,
  },
  user_responsible: {
    label: 'Пользователи ERP → ответственный (сотрудник 1С)',
    erpItemsSql: `SELECT 'user:' || user_id AS erp_key, COALESCE(NULLIF(btrim(full_name), ''), username) AS label FROM users
                   WHERE is_active AND NOT COALESCE(is_service_account, false) ORDER BY 2, user_id`,
    entities: ['employees'], filter: 'active_employees', refRequired: true, valueSchema: null,
  },
  payment_type_account: {
    label: 'Виды оплат → касса или банковский счёт 1С',
    erpItemsSql: `SELECT 'payment_type:' || type_paid_id AS erp_key, type_paid_name AS label FROM payment_types
                   WHERE is_active IS NOT FALSE ORDER BY sort_order, type_paid_id`,
    entities: ['cash_desks', 'bank_accounts'], filter: 'own_bank_accounts', refRequired: true, valueSchema: null,
  },
  milling_nomenclature: {
    label: 'Типы фрезеровки → номенклатура услуги «Фрезировка …»',
    erpItemsSql: `SELECT 'milling_type:' || milling_type_id AS erp_key, milling_type_name AS label FROM milling_types
                   WHERE is_active IS NOT FALSE ORDER BY sort_order, milling_type_id`,
    entities: ['items'], filter: 'items', refRequired: true, valueSchema: null,
  },
  mdf_nomenclature: {
    label: 'Листовые материалы (МДФ) → номенклатура «Сырьё цеха фрезировки»',
    erpItemsSql: `SELECT 'sheet_material:' || sheet_material_type_id AS erp_key, name AS label FROM sheet_material_types
                   WHERE is_active IS NOT FALSE ORDER BY name, sheet_material_type_id`,
    entities: ['items'], filter: 'items', refRequired: true, valueSchema: null,
  },
  delivery_nomenclature: {
    label: 'Доставка → номенклатура «Автодоставка»',
    erpItemsSql: `SELECT 'delivery:courier' AS erp_key, 'Курьерская доставка' AS label`,
    entities: ['items'], filter: 'items', refRequired: true, valueSchema: null,
  },
  remainder_nomenclature: {
    label: 'Строка-остаток заказа → номенклатура «Услуга МДФ цеха-фрезеровка»',
    erpItemsSql: `SELECT 'remainder:milling' AS erp_key, 'Остаток до итога заказа (фрезеровка)' AS label`,
    entities: ['items'], filter: 'items', refRequired: true, valueSchema: null,
  },
  film_group: {
    label: 'Плёнки → группа номенклатуры для новых плёнок',
    erpItemsSql: `SELECT 'films:group' AS erp_key, 'Группа новых плёнок' AS label`,
    entities: ['items'], filter: 'item_folders', refRequired: true, valueSchema: null,
  },
};

const FILTER_SQL: Record<CandidateFilter, string> = {
  all: 'true',
  items: `COALESCE((m.data->>'IsFolder')::boolean, false) = false`,
  item_folders: `COALESCE((m.data->>'IsFolder')::boolean, false) = true`,
  own_bank_accounts: `(m.entity_code <> 'bank_accounts' OR m.data->>'Owner_Type' = 'StandardODATA.Catalog_Организации')`,
  active_users: `COALESCE((m.data->>'Служебный')::boolean, false) = false AND COALESCE((m.data->>'Недействителен')::boolean, false) = false`,
  active_employees: `COALESCE((m.data->>'IsFolder')::boolean, false) = false AND COALESCE((m.data->>'Недействителен')::boolean, false) = false`,
};

/** A live mirror row: not deleted in 1C, not marked for deletion, still present in the source. */
const LIVE_MIRROR = `m.source_id = $1 AND m.entity_code = ANY($2::text[]) AND NOT m.deleted AND m.missing_in_source_at IS NULL
  AND COALESCE((m.data->>'DeletionMark')::boolean, false) = false`;

const putSchema = z.object({
  onecRef: z.string().uuid().nullable(),
  onecValue: z.record(z.string(), z.unknown()).nullable(),
  /** Version the client edited; null — the client saw no mapping. */
  expectedVersion: z.number().int().positive().nullable(),
}).strict();

export interface OnecWriteMappingView {
  onecRef: string | null;
  onecName: string | null;
  /** The ref is no longer a live mirror row (deleted or marked in 1C). */
  onecRefStale: boolean;
  onecValue: Record<string, unknown> | null;
  /** Never reused (one sequence), also after clear + re-create. */
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

interface MappingRow {
  kind: string; erp_key: string; onec_ref: string | null; onec_value: Record<string, unknown> | null; version: string;
  updated_at: Date; updated_by_name: string | null; onec_name: string | null; live: boolean | null;
}

@Injectable()
export class OnecWriteMappingsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
  ) {}

  private async sourceOf(agentId: string | undefined): Promise<number> {
    this.runtime.requireEnabled();
    if (!agentId || !/^[A-Za-z0-9._-]{1,64}$/.test(agentId)) throw new ApiError(400, 'VALIDATION_FAILED', 'Нужен агент');
    const agent = await this.repository.getAgent(this.repository.db, agentId);
    if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'Агент не найден');
    return agent.sourceId;
  }

  /** Every kind with its ERP items and current mappings; `missing` counts unmapped items. */
  async list(agentId: string | undefined) {
    const sourceId = await this.sourceOf(agentId);
    const db = this.database;
    const mappings = await db.query<MappingRow>(
      `SELECT w.kind, w.erp_key, w.onec_ref::text AS onec_ref, w.onec_value, w.version, w.updated_at,
              COALESCE(NULLIF(btrim(u.full_name), ''), u.username) AS updated_by_name,
              m.data->>'Description' AS onec_name,
              (m.source_key IS NOT NULL AND NOT m.deleted AND m.missing_in_source_at IS NULL
                AND COALESCE((m.data->>'DeletionMark')::boolean, false) = false) AS live
         FROM onec_write_mappings w
         LEFT JOIN users u ON u.user_id = w.updated_by
         LEFT JOIN LATERAL (SELECT * FROM onec_etl_mirror_rows mr WHERE mr.source_id = w.source_id AND mr.source_key = w.onec_ref::text
                             ORDER BY mr.deleted, mr.missing_in_source_at NULLS FIRST LIMIT 1) m ON true
        WHERE w.source_id = $1`, [sourceId]);
    const byKey = new Map(mappings.rows.map((row) => [`${row.kind}|${row.erp_key}`, row]));
    const kinds = [];
    for (const kind of ONEC_WRITE_MAPPING_KINDS) {
      const spec = SPECS[kind];
      const items = (await db.query<{ erp_key: string; label: string }>(spec.erpItemsSql)).rows;
      const candidates = spec.entities.length
        ? Number((await db.query<{ n: string }>(
            `SELECT count(*) AS n FROM onec_etl_mirror_rows m WHERE ${LIVE_MIRROR} AND ${FILTER_SQL[spec.filter]}`,
            [sourceId, spec.entities])).rows[0].n)
        : null;
      // Eligibility with the kind's own rules (live, right entity, not a folder, not «Недействителен» …), not just «exists».
      const refs = items.map((item) => byKey.get(`${kind}|${item.erp_key}`)?.onec_ref).filter((ref): ref is string => !!ref);
      const eligible = new Set(refs.length && spec.entities.length
        ? (await db.query<{ ref: string }>(
            `SELECT m.source_key AS ref FROM onec_etl_mirror_rows m
              WHERE ${LIVE_MIRROR} AND ${FILTER_SQL[spec.filter]} AND m.source_key = ANY($3::text[])`,
            [sourceId, spec.entities, refs])).rows.map((row) => row.ref)
        : []);
      const views = items.map((item) => {
        const row = byKey.get(`${kind}|${item.erp_key}`);
        return { erpKey: item.erp_key, label: item.label, mapping: row ? view(row, row.onec_ref === null || eligible.has(row.onec_ref)) : null };
      });
      const missing = views.filter((item) => !item.mapping || (spec.refRequired && !item.mapping.onecRef)).length;
      const invalid = views.filter((item) => item.mapping?.onecRefStale).length;
      kinds.push({
        kind,
        label: spec.label,
        refRequired: spec.refRequired,
        hasRef: spec.entities.length > 0,
        valueOptions: valueOptions(kind),
        candidatesCount: candidates,
        pendingNote: candidates === 0 ? spec.pendingNote ?? null : null,
        missing,
        invalid,
        ready: missing === 0 && invalid === 0,
        items: views,
      });
    }
    return { sourceId, kinds };
  }

  /** Live mirror candidates of a kind (name or code contains `search`), at most 50. */
  async candidates(agentId: string | undefined, kindRaw: string | undefined, searchRaw: string | undefined) {
    const sourceId = await this.sourceOf(agentId);
    const kind = parseKind(kindRaw);
    const spec = SPECS[kind];
    if (!spec.entities.length) return { kind, data: [] };
    const search = searchRaw?.trim() ? `%${searchRaw.trim().slice(0, 100).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
    const rows = await this.database.query<{ ref: string; name: string | null; code: string | null; entity: string }>(
      `SELECT m.source_key AS ref, m.data->>'Description' AS name, m.data->>'Code' AS code, m.entity_code AS entity
         FROM onec_etl_mirror_rows m
        WHERE ${LIVE_MIRROR} AND ${FILTER_SQL[spec.filter]}
          AND ($3::text IS NULL OR m.data->>'Description' ILIKE $3 OR m.data->>'Code' ILIKE $3)
        ORDER BY m.data->>'Description', m.source_key LIMIT 50`,
      [sourceId, spec.entities, search]);
    return { kind, data: rows.rows };
  }

  /** Set (or clear, when both are null) the mapping of one ERP item. Optimistic on `expectedVersion`. */
  async put(user: CurrentUser, agentId: string | undefined, kindRaw: string, erpKeyRaw: string, body: unknown, context: OnecRequestContext) {
    const sourceId = await this.sourceOf(agentId);
    const kind = parseKind(kindRaw);
    const spec = SPECS[kind];
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', 'Неверные данные связи', { issues: parsed.error.issues.slice(0, 5) });
    const { onecRef, expectedVersion } = parsed.data;
    let onecValue = parsed.data.onecValue;
    const clearing = onecRef === null && onecValue === null;
    if (!clearing) {
      if (spec.entities.length === 0 && onecRef !== null) throw new ApiError(400, 'VALIDATION_FAILED', 'Для этого вида ссылка 1С не задаётся');
      if (spec.refRequired && onecRef === null) throw new ApiError(400, 'VALIDATION_FAILED', 'Нужен объект 1С');
      if (spec.valueSchema) {
        const value = spec.valueSchema.safeParse(onecValue);
        if (!value.success) throw new ApiError(400, 'VALIDATION_FAILED', 'Неверное значение 1С', { issues: value.error.issues.slice(0, 5) });
        onecValue = value.data && Object.keys(value.data).length ? value.data : null;
      } else if (onecValue !== null) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'Для этого вида значение 1С не задаётся');
      }
      if (onecRef === null && onecValue === null) throw new ApiError(400, 'VALIDATION_FAILED', 'Нужен объект или значение 1С');
    }

    return this.database.transaction(async (tx) => {
      const items = (await tx.query<{ erp_key: string; label: string }>(spec.erpItemsSql)).rows;
      const item = items.find((row) => row.erp_key === erpKeyRaw);
      if (!item) throw new ApiError(404, 'ONEC_MAPPING_ITEM_NOT_FOUND', 'Такого элемента ERP нет');
      if (onecRef !== null) await requireLiveCandidate(tx, sourceId, spec, onecRef);

      // Serialize every writer of this key before reading, so two first saves cannot both see «no row».
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`onec_write_mappings:${sourceId}:${kind}:${item.erp_key}`]);
      const current = (await tx.query<{ onec_ref: string | null; onec_value: Record<string, unknown> | null; version: string }>(
        `SELECT onec_ref::text AS onec_ref, onec_value, version FROM onec_write_mappings
          WHERE source_id = $1 AND kind = $2 AND erp_key = $3 FOR UPDATE`, [sourceId, kind, item.erp_key])).rows[0] ?? null;
      const currentVersion = current ? Number(current.version) : null;
      if (currentVersion !== expectedVersion) {
        throw new ApiError(409, 'ONEC_MAPPING_CHANGED', 'Связь уже изменили; обновите страницу', { currentVersion });
      }
      const before = current ? { onecRef: current.onec_ref, onecValue: current.onec_value } : null;
      let after: { onecRef: string | null; onecValue: Record<string, unknown> | null } | null = null;
      let version: number | null = null;
      if (clearing) {
        if (!current) return { changed: false, mapping: null };
        await tx.query('DELETE FROM onec_write_mappings WHERE source_id = $1 AND kind = $2 AND erp_key = $3', [sourceId, kind, item.erp_key]);
      } else {
        if (current && current.onec_ref === onecRef && JSON.stringify(current.onec_value) === JSON.stringify(onecValue)) {
          return { changed: false, mapping: await this.one(tx, sourceId, kind, item.erp_key) };
        }
        // The key is locked and the version checked: insert when there was no row, update otherwise (no upsert race).
        const saved = current
          ? await tx.query<{ version: string }>(
              `UPDATE onec_write_mappings SET onec_ref = $4::uuid, onec_value = $5::jsonb,
                      version = nextval('onec_write_mappings_version_seq'), updated_by = $6, updated_at = now()
                WHERE source_id = $1 AND kind = $2 AND erp_key = $3 RETURNING version`,
              [sourceId, kind, item.erp_key, onecRef, onecValue === null ? null : JSON.stringify(onecValue), user.id])
          : await tx.query<{ version: string }>(
              `INSERT INTO onec_write_mappings (source_id, kind, erp_key, onec_ref, onec_value, updated_by, updated_at)
               VALUES ($1, $2, $3, $4::uuid, $5::jsonb, $6, now()) RETURNING version`,
              [sourceId, kind, item.erp_key, onecRef, onecValue === null ? null : JSON.stringify(onecValue), user.id]);
        version = Number(saved.rows[0].version);
        after = { onecRef, onecValue };
      }
      await this.audit.byUser(tx, user, context, {
        event: 'onec.mapping.changed',
        entityType: 'onec_write_mapping',
        entityId: `${sourceId}:${kind}:${item.erp_key}`,
        before,
        after,
        diff: { onecRef: { from: before?.onecRef ?? null, to: after?.onecRef ?? null }, onecValue: { from: before?.onecValue ?? null, to: after?.onecValue ?? null } },
        metadata: { kind, erpKey: item.erp_key, sourceId, version, previousVersion: currentVersion, operation: clearing ? 'clear' : current ? 'update' : 'create' },
        ...auditDimensions(item.erp_key),
      }, { sourceId });
      return { changed: true, mapping: clearing ? null : await this.one(tx, sourceId, kind, item.erp_key) };
    });
  }

  private async one(tx: DatabaseClient, sourceId: number, kind: string, erpKey: string): Promise<OnecWriteMappingView | null> {
    const row = (await tx.query<MappingRow>(
      `SELECT w.kind, w.erp_key, w.onec_ref::text AS onec_ref, w.onec_value, w.version, w.updated_at,
              COALESCE(NULLIF(btrim(u.full_name), ''), u.username) AS updated_by_name,
              m.data->>'Description' AS onec_name,
              (m.source_key IS NOT NULL AND NOT m.deleted AND m.missing_in_source_at IS NULL
                AND COALESCE((m.data->>'DeletionMark')::boolean, false) = false) AS live
         FROM onec_write_mappings w
         LEFT JOIN users u ON u.user_id = w.updated_by
         LEFT JOIN LATERAL (SELECT * FROM onec_etl_mirror_rows mr WHERE mr.source_id = w.source_id AND mr.source_key = w.onec_ref::text
                             ORDER BY mr.deleted, mr.missing_in_source_at NULLS FIRST LIMIT 1) m ON true
        WHERE w.source_id = $1 AND w.kind = $2 AND w.erp_key = $3`, [sourceId, kind, erpKey])).rows[0];
    if (!row) return null;
    const spec = SPECS[kind as OnecWriteMappingKind];
    const eligible = row.onec_ref === null || !spec.entities.length
      ? true
      : !!(await tx.query(`SELECT 1 FROM onec_etl_mirror_rows m WHERE ${LIVE_MIRROR} AND ${FILTER_SQL[spec.filter]} AND m.source_key = $3 LIMIT 1`,
          [sourceId, spec.entities, row.onec_ref])).rowCount;
    return view(row, eligible);
  }
}

async function requireLiveCandidate(tx: DatabaseClient, sourceId: number, spec: KindSpec, ref: string): Promise<void> {
  const found = await tx.query(
    `SELECT 1 FROM onec_etl_mirror_rows m WHERE ${LIVE_MIRROR} AND ${FILTER_SQL[spec.filter]} AND m.source_key = $3 LIMIT 1`,
    [sourceId, spec.entities, ref.toLowerCase()]);
  if (!found.rowCount) throw new ApiError(422, 'ONEC_MAPPING_REF_INVALID', 'Объект 1С не найден среди допустимых (удалён или другого вида)');
}

function parseKind(value: string | undefined): OnecWriteMappingKind {
  const kind = ONEC_WRITE_MAPPING_KINDS.find((item) => item === value);
  if (!kind) throw new ApiError(400, 'VALIDATION_FAILED', 'Неизвестный вид связи');
  return kind;
}

function valueOptions(kind: OnecWriteMappingKind) {
  if (kind === 'production_stage') return { field: 'productionStatus', values: [...ONEC_PRODUCTION_STATUS_VALUES], nullable: true };
  if (kind === 'order_status') return { field: 'completion', values: [...ONEC_COMPLETION_VALUES], nullable: true };
  return null;
}

/** Normalized audit dimensions of the ERP item a mapping belongs to (the user, status, stage, workshop, type …). */
function auditDimensions(erpKey: string): { relatedUserId?: number; relatedEntities: Array<{ entityType: string; entityId: number }> } {
  const [prefix, rawId] = erpKey.split(':');
  const id = Number(rawId);
  if (!Number.isSafeInteger(id)) return { relatedEntities: [] };
  const entityType: Record<string, string> = {
    user: 'user', order_status: 'order_status', production_status: 'production_status', workshop: 'workshop',
    payment_type: 'payment_type', milling_type: 'milling_type', sheet_material: 'sheet_material_type',
  };
  const type = entityType[prefix];
  if (!type) return { relatedEntities: [] };
  return { ...(prefix === 'user' ? { relatedUserId: id } : {}), relatedEntities: [{ entityType: type, entityId: id }] };
}

function view(row: MappingRow, eligible: boolean): OnecWriteMappingView {
  return {
    onecRef: row.onec_ref,
    onecName: row.onec_name,
    onecRefStale: row.onec_ref !== null && (row.live !== true || !eligible),
    onecValue: row.onec_value,
    version: Number(row.version),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by_name,
  };
}
