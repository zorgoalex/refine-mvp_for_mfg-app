import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderResourceKind } from '../application/order-resource-demand.types';
import {
  PROCUREMENT_WORKLIST_LINE_LIMIT,
  PROCUREMENT_WORKLIST_ORDER_LIMIT,
  PROCUREMENT_WORKLIST_PLANNED_AHEAD_DAYS,
  type ProcurementSavedViewDto,
  type ProcurementSettingsDto,
  type ProcurementWorklistLineDto,
  type ProcurementWorklistQuery,
  type ProcurementWorklistResponseDto,
  type UpdateProcurementSettingsCommand,
} from '../application/procurement-workspace.types';
import {
  addDays,
  computeCoverage,
  demandUnitOf,
  groupLines,
  isUrgent,
  matchesPreset,
  matchesQuery,
  resolveSupplier,
  sheetAreaM2,
  sortLines,
  subtractWorkingDays,
  sumDeficit,
  toDemandUnit,
  todayInAlmaty,
  urgencyOf,
  type ProcurementDocUnit,
  type SupplierCandidate,
} from '../domain/procurement-worklist';
import {
  buildScopedOrderWhere,
  loadProcurementRows,
  loadProjectedOrders,
  procurementRowKey,
  resourceKey,
  type ResourceDemandOrderRow,
} from './pg-order-resource-demand-repository';
import { lockActor } from './pg-order-resource-procurement-repository';

interface SettingsRow extends QueryResultRow {
  lead_days: number;
  critical_days: number;
  soon_days: number;
  waste_percent: string | number;
  digest_time: string;
  unallocated_alert_days: number;
  overdue_window_days: number;
  version: string | number;
  updated_at: Date | string;
  updated_by_user_id: string | number | null;
  updated_by_name: string | null;
}

interface WorklistOrderRow extends ResourceDemandOrderRow {
  planned_completion_date: string | null;
  order_status_name: string | null;
}

interface ReceiptRow extends QueryResultRow {
  order_resource_procurement_id: string | number;
  onec_document_id: string | number;
  quantity: string | number;
  unit_code: ProcurementDocUnit | null;
  posted: boolean;
  deleted_in_onec: boolean;
}

interface GeometryRow extends QueryResultRow {
  sheet_material_type_id: string | number;
  width_mm: string | number | null;
  height_mm: string | number | null;
  supplier_id: string | number | null;
  supplier_name: string | null;
}

interface RecordedSupplierRow extends QueryResultRow {
  resource_supplier_id: string | number;
  resource_kind: OrderResourceKind;
  ref_id: string | number;
  supplier_key: string;
  name: string | null;
  first_seen_at: Date | string;
}

const SETTINGS_SELECT = `
  SELECT s.lead_days, s.critical_days, s.soon_days, s.waste_percent, to_char(s.digest_time, 'HH24:MI') AS digest_time,
         s.unallocated_alert_days, s.overdue_window_days, s.version, s.updated_at, s.updated_by_user_id,
         (SELECT COALESCE(NULLIF(btrim(u.full_name), ''), u.username::text) FROM users u WHERE u.user_id = s.updated_by_user_id) AS updated_by_name
    FROM procurement_settings s
   WHERE s.config_id = 1`;

export interface ProcurementWorklistReadOptions {
  procurementEnabled: boolean;
  supplyWorkspaceEnabled: boolean;
}

export class PgProcurementWorkspaceRepository {
  constructor(private readonly database: DatabaseService) {}

  async getSettings(): Promise<ProcurementSettingsDto> {
    const row = (await this.database.query<SettingsRow>(SETTINGS_SELECT)).rows[0];
    if (!row) throw settingsMissing();
    return settingsDto(row);
  }

  async updateSettings(command: UpdateProcurementSettingsCommand): Promise<{ changed: boolean; settings: ProcurementSettingsDto }> {
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, command.currentUser);
      const row = (await tx.query<SettingsRow>(`${SETTINGS_SELECT} FOR UPDATE OF s`)).rows[0];
      if (!row) throw settingsMissing();
      const current = settingsDto(row);
      const before = comparable(current);
      const after = command.settings;
      if (sameSettings(before, after)) return { changed: false, settings: current };
      if (command.expectedVersion !== current.version) {
        throw new ApiError(409, 'PROCUREMENT_SETTINGS_VERSION_CONFLICT', 'Настройки уже изменил другой пользователь. Показаны актуальные', {
          settings: current,
        });
      }
      await tx.query(
        `UPDATE procurement_settings
            SET lead_days = $1, critical_days = $2, soon_days = $3, waste_percent = $4, digest_time = $5::time,
                unallocated_alert_days = $6, overdue_window_days = $8, version = version + 1, updated_by_user_id = $7, updated_at = now()
          WHERE config_id = 1`,
        [after.leadDays, after.criticalDays, after.soonDays, after.wastePercent, after.digestTime,
          after.unallocatedAlertDays, actor.userId, after.overdueWindowDays],
      );
      const updated = settingsDto((await tx.query<SettingsRow>(SETTINGS_SELECT)).rows[0]);
      await auditService.record(tx, {
        event: 'procurement.settings_updated',
        entityType: 'procurement_settings',
        entityId: '1',
        actorUserId: actor.userId,
        actorUsername: actor.username,
        actorRole: command.currentUser.role,
        requestId: command.requestId,
        source: 'backend-procurement-workspace',
        before: { ...before, version: current.version },
        after: { ...comparable(updated), version: updated.version },
        diff: computeDiff(before, comparable(updated)),
        metadata: { correlationId: command.requestId },
      });
      return { changed: true, settings: updated };
    });
  }

  async listWorklist(
    currentUser: CurrentUser,
    query: ProcurementWorklistQuery,
    options: ProcurementWorklistReadOptions,
  ): Promise<ProcurementWorklistResponseDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const settingsRow = (await client.query<SettingsRow>(SETTINGS_SELECT)).rows[0];
      if (!settingsRow) throw settingsMissing();
      const settings = settingsDto(settingsRow);
      const today = todayInAlmaty();
      const window = worklistWindow(query, today, settings.overdueWindowDays);
      const orders = await loadWorklistOrders(client, currentUser, window, query, settings.leadDays);
      const projected = await loadProjectedOrders(client, orders, undefined);
      const orderIds = projected.map((order) => order.orderId);
      const procurement = options.procurementEnabled ? await loadProcurementRows(client, orderIds) : [];
      const receipts = options.procurementEnabled ? await loadReceipts(client, orderIds) : [];
      const sheetIds = [...new Set(projected.flatMap((order) => order.lines)
        .filter((line) => line.kind === 'sheet_material').map((line) => line.refId))];
      const filmIds = [...new Set(projected.flatMap((order) => order.lines)
        .filter((line) => line.kind === 'film').map((line) => line.refId))];
      const geometry = await loadGeometry(client, sheetIds);
      const recorded = await loadRecordedSuppliers(client, sheetIds, filmIds);

      const orderById = new Map(orders.map((row) => [Number(row.order_id), row]));
      const procurementByKey = new Map(procurement.map((row) => [`${Number(row.order_id)}|${procurementRowKey(row)}`, row]));
      const receiptsByProcurement = groupBy(receipts, (row) => Number(row.order_resource_procurement_id));

      const allLines: ProcurementWorklistLineDto[] = [];
      for (const order of projected) {
        const orderRow = orderById.get(order.orderId)!;
        const planned = toDateOnly(orderRow.planned_completion_date);
        const dueDate = planned === null ? null : subtractWorkingDays(planned, settings.leadDays);
        const { urgency, daysLeft } = urgencyOf(dueDate, today, settings);
        for (const projectedLine of order.lines) {
          const key = `${order.orderId}|${projectedLine.resourceKey}`;
          const row = procurementByKey.get(key);
          const unit = demandUnitOf(projectedLine.kind);
          const geo = projectedLine.kind === 'sheet_material' ? geometry.get(projectedLine.refId) : undefined;
          const lineReceipts = row ? (receiptsByProcurement.get(Number(row.order_resource_procurement_id)) ?? []) : [];
          const countable = lineReceipts.filter((receipt) => receipt.posted && !receipt.deleted_in_onec);
          let receivedThousandths = 0;
          let incompatible = 0;
          for (const receipt of countable) {
            const converted = toDemandUnit(Number(receipt.quantity), receipt.unit_code, unit, { sheetAreaM2: geo?.areaM2 ?? null });
            if (converted === null) incompatible += 1;
            else receivedThousandths += Math.round(converted * 1000);
          }
          const received = receivedThousandths / 1000;
          const purchased = row?.purchased === true;
          const demandChangedSinceMark = purchased && row?.demand_fingerprint_at_mark !== projectedLine.demandFingerprint;
          const coverage = computeCoverage({
            need: projectedLine.quantity,
            received,
            purchased,
            origin: row?.origin ?? null,
            hasActiveReceipts: countable.length > 0,
            demandChangedSinceMark,
            quantityAtMark: row?.quantity_at_mark === null || row?.quantity_at_mark === undefined ? null : Number(row.quantity_at_mark),
            orderedOpen: 0,
          });
          allLines.push({
            lineKey: key,
            orderId: order.orderId,
            orderName: order.base.orderName,
            fullNumber: order.base.fullNumber,
            clientName: order.base.clientName,
            orderStatus: orderRow.order_status_name ?? null,
            resourceKey: projectedLine.resourceKey,
            kind: projectedLine.kind,
            refId: projectedLine.refId,
            name: projectedLine.name,
            unit,
            need: projectedLine.quantity,
            received,
            receivedIncompatibleCount: incompatible,
            covered: coverage.covered,
            orderedOpen: 0,
            deficit: coverage.deficit,
            coverage: coverage.coverage,
            needsAction: coverage.needsAction,
            purchased,
            purchaseOrigin: purchased ? (row?.origin ?? null) : null,
            demandChangedSinceMark,
            plannedCompletionDate: planned,
            dueDate,
            daysLeft,
            urgency,
            supplier: resolveSupplier(
              geo?.supplier ?? null,
              recorded.get(resourceKey(projectedLine.kind, projectedLine.refId)) ?? [],
            ),
            procurementVersion: row ? Number(row.version) : 0,
            demandFingerprint: projectedLine.demandFingerprint,
            onecReceiptCount: lineReceipts.length,
            lockedByOnec: countable.length > 0,
          });
        }
      }

      const onecLineKeys = query.onecDocumentId === undefined || !options.procurementEnabled
        ? (query.onecDocumentId === undefined ? undefined : new Set<string>())
        : await loadOnecDocumentLineKeys(client, orderIds, query.onecDocumentId);
      const filtered = allLines.filter((line) => matchesQuery(line, query, onecLineKeys));
      const selected = sortLines(filtered.filter((line) => matchesPreset(line, query.preset)), query.sort);
      if (selected.length > PROCUREMENT_WORKLIST_LINE_LIMIT) {
        throw new ApiError(422, 'PROCUREMENT_WORKLIST_TOO_MANY', 'Слишком много позиций. Сузьте фильтры', {
          limit: PROCUREMENT_WORKLIST_LINE_LIMIT,
        });
      }
      const uncovered = filtered.filter((line) => line.needsAction);
      return {
        lines: selected,
        groups: groupLines(selected, query.groupBy),
        counts: {
          action: uncovered.length,
          urgent: filtered.filter(isUrgent).length,
          all: filtered.length,
        },
        totals: {
          uncovered: uncovered.length,
          urgent: filtered.filter(isUrgent).length,
          deficitM2: sumDeficit(selected, 'm2'),
          deficitLm: sumDeficit(selected, 'lm'),
        },
        settings: {
          leadDays: settings.leadDays,
          criticalDays: settings.criticalDays,
          soonDays: settings.soonDays,
          wastePercent: settings.wastePercent,
        },
        window: { ...window, ordersCount: orders.length },
        today,
        capabilities: { supplyWorkspace: options.supplyWorkspaceEnabled, procurement: options.procurementEnabled },
        refreshedAt: new Date().toISOString(),
      };
    });
  }

  async getSavedViews(currentUser: CurrentUser): Promise<ProcurementSavedViewDto[]> {
    const userId = actorId(currentUser);
    const row = (await this.database.query<{ views: unknown }>(
      'SELECT procurement_saved_views AS views FROM user_preferences WHERE user_id = $1',
      [userId],
    )).rows[0];
    return readSavedViews(row?.views);
  }

  async replaceSavedViews(currentUser: CurrentUser, views: ProcurementSavedViewDto[]): Promise<ProcurementSavedViewDto[]> {
    const userId = actorId(currentUser);
    const row = (await this.database.query<{ views: unknown }>(
      `INSERT INTO user_preferences (user_id, procurement_saved_views)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET procurement_saved_views = EXCLUDED.procurement_saved_views, updated_at = now()
       RETURNING procurement_saved_views AS views`,
      [userId, JSON.stringify(views)],
    )).rows[0];
    return readSavedViews(row?.views);
  }
}

async function loadWorklistOrders(
  client: DatabaseClient,
  currentUser: CurrentUser,
  window: { plannedFrom: string | null; plannedTo: string | null },
  query: ProcurementWorklistQuery,
  leadDays: number,
): Promise<WorklistOrderRow[]> {
  const params: unknown[] = [];
  const { whereSql } = buildScopedOrderWhere(currentUser, undefined, params);
  const plannedBounds = [
    ...(window.plannedFrom ? [`o.planned_completion_date >= $${params.push(window.plannedFrom)}::date`] : []),
    ...(window.plannedTo ? [`o.planned_completion_date <= $${params.push(window.plannedTo)}::date`] : []),
  ];
  const narrowing = buildNarrowingPredicates(query, leadDays, params);
  const limitIndex = params.push(PROCUREMENT_WORKLIST_ORDER_LIMIT + 1);
  const result = await client.query<WorklistOrderRow>(
    `SELECT o.order_id, o.order_name, (p.code || '-' || o.order_name) AS full_number, o.order_date,
            p.code AS project_code, c.client_name, o.client_id, o.updated_at,
            o.planned_completion_date::text AS planned_completion_date, os.order_status_name
       FROM orders o
       JOIN projects p ON p.project_id = o.project_id
       LEFT JOIN clients c ON c.client_id = o.client_id
       LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
      WHERE ${whereSql}
        AND o.issue_date IS NULL
        AND o.completion_date IS NULL
        AND (o.planned_completion_date IS NULL${plannedBounds.length > 0
          ? ` OR (${plannedBounds.join(' AND ')})`
          : ' OR TRUE'})
        ${narrowing.map((clause) => `AND ${clause}`).join('\n        ')}
      ORDER BY o.planned_completion_date NULLS LAST, o.order_id
      LIMIT $${limitIndex}`,
    params,
  );
  if (result.rows.length > PROCUREMENT_WORKLIST_ORDER_LIMIT) {
    throw new ApiError(422, 'PROCUREMENT_WORKLIST_TOO_MANY', 'Слишком много заказов для рабочего списка. Сузьте фильтры', {
      limit: PROCUREMENT_WORKLIST_ORDER_LIMIT,
    });
  }
  return result.rows;
}

/**
 * Окно заказов (CR2-1): заказы без плановой даты — всегда; с датой — не дальше +60 дней и просроченные
 * не старше `overdueWindowDays` (настройка). Старые незакрытые заказы (по статусу их тысячи) доступны
 * поиском или явным «Нужно к: с» — тогда нижней границы окна нет, её задаёт фильтр.
 */
export function worklistWindow(
  query: ProcurementWorklistQuery,
  today: string,
  overdueWindowDays: number,
): { plannedFrom: string | null; plannedTo: string | null } {
  const explicit = Boolean(query.search) || query.dueFrom !== undefined || query.onecDocumentId !== undefined;
  return {
    plannedFrom: explicit ? null : addDays(today, -overdueWindowDays),
    plannedTo: query.dueTo !== undefined || query.search ? null : addDays(today, PROCUREMENT_WORKLIST_PLANNED_AHEAD_DAYS),
  };
}

/**
 * Сужение выборки заказов фильтрами запроса ДО лимита в 500 заказов (CR1-2). Предикаты —
 * надмножество точных фильтров `matchesQuery` (они применяются к строкам после проекции),
 * поэтому ничего подходящего не теряется.
 */
export function buildNarrowingPredicates(query: ProcurementWorklistQuery, leadDays: number, params: unknown[]): string[] {
  const clauses: string[] = [];
  if (query.search) {
    const s = params.push(`%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    clauses.push(`(
          o.order_name ILIKE $${s} OR (p.code || '-' || o.order_name) ILIKE $${s} OR c.client_name ILIKE $${s}
          OR EXISTS (
            SELECT 1 FROM order_details sd
              LEFT JOIN sheet_material_types ssmt ON ssmt.sheet_material_type_id = sd.sheet_material_type_id
              LEFT JOIN suppliers ssup ON ssup.supplier_id = ssmt.supplier_id
              LEFT JOIN films sf ON sf.film_id = sd.film_id
             WHERE sd.order_id = o.order_id AND sd.delete_flag = false
               AND (ssmt.name ILIKE $${s} OR sf.film_name ILIKE $${s} OR ssup.supplier_name ILIKE $${s}
                 OR EXISTS (
                   SELECT 1 FROM resource_suppliers srs LEFT JOIN suppliers srsup ON srsup.supplier_id = srs.supplier_id
                    WHERE ((srs.resource_kind = 'sheet_material' AND srs.sheet_material_type_id = sd.sheet_material_type_id)
                        OR (srs.resource_kind = 'film' AND srs.film_id = sd.film_id))
                      AND (srs.counterparty_name ILIKE $${s} OR srsup.supplier_name ILIKE $${s}))))
          OR EXISTS (
            SELECT 1 FROM order_hdf_details shdf
              LEFT JOIN sheet_material_types shsmt ON shsmt.sheet_material_type_id = shdf.hdf_sheet_material_type_id
              LEFT JOIN suppliers shsup ON shsup.supplier_id = shsmt.supplier_id
             WHERE shdf.order_id = o.order_id AND shdf.delete_flag = false
               AND (shdf.hdf_sheet_material_name ILIKE $${s} OR shsmt.name ILIKE $${s} OR shsup.supplier_name ILIKE $${s}
                 OR EXISTS (
                   SELECT 1 FROM resource_suppliers shrs LEFT JOIN suppliers shrsup ON shrsup.supplier_id = shrs.supplier_id
                    WHERE shrs.resource_kind = 'sheet_material' AND shrs.sheet_material_type_id = shdf.hdf_sheet_material_type_id
                      AND (shrs.counterparty_name ILIKE $${s} OR shrsup.supplier_name ILIKE $${s}))))
        )`);
  }
  // «Нужно к» = плановая − leadDays рабочих дней ≤ плановой; сверху — с запасом на выходные.
  if (query.dueFrom) clauses.push(`o.planned_completion_date >= $${params.push(query.dueFrom)}::date`);
  if (query.dueTo) {
    clauses.push(`o.planned_completion_date <= $${params.push(query.dueTo)}::date + $${params.push(leadDays * 2 + 4)}::int`);
  }
  if (query.kind === 'film') {
    clauses.push('EXISTS (SELECT 1 FROM order_details kd WHERE kd.order_id = o.order_id AND kd.delete_flag = false AND kd.film_id IS NOT NULL)');
  } else if (query.kind === 'sheet_material') {
    clauses.push(`(EXISTS (SELECT 1 FROM order_details kd WHERE kd.order_id = o.order_id AND kd.delete_flag = false AND kd.sheet_material_type_id IS NOT NULL)
          OR EXISTS (SELECT 1 FROM order_hdf_details khdf WHERE khdf.order_id = o.order_id AND khdf.delete_flag = false AND khdf.hdf_sheet_material_type_id IS NOT NULL))`);
  }
  if (query.supplierKey) {
    // Основной поставщик позиции (§4.3): ручной из справочника, иначе самый ранний записанный.
    const k = params.push(query.supplierKey);
    const firstRecorded = (kind: 'sheet_material' | 'film', column: string, ref: string) => `(
          SELECT rs.supplier_key FROM resource_suppliers rs
           WHERE rs.resource_kind = '${kind}' AND rs.${column} = ${ref}
           ORDER BY rs.first_seen_at, rs.resource_supplier_id LIMIT 1)`;
    clauses.push(`(
          EXISTS (
            SELECT 1 FROM order_details pd
              LEFT JOIN sheet_material_types psmt ON psmt.sheet_material_type_id = pd.sheet_material_type_id
             WHERE pd.order_id = o.order_id AND pd.delete_flag = false
               AND ((pd.sheet_material_type_id IS NOT NULL
                     AND COALESCE('s:' || psmt.supplier_id, ${firstRecorded('sheet_material', 'sheet_material_type_id', 'pd.sheet_material_type_id')}, 'none') = $${k})
                 OR (pd.film_id IS NOT NULL
                     AND COALESCE(${firstRecorded('film', 'film_id', 'pd.film_id')}, 'none') = $${k})))
          OR EXISTS (
            SELECT 1 FROM order_hdf_details phdf
              LEFT JOIN sheet_material_types phsmt ON phsmt.sheet_material_type_id = phdf.hdf_sheet_material_type_id
             WHERE phdf.order_id = o.order_id AND phdf.delete_flag = false AND phdf.hdf_sheet_material_type_id IS NOT NULL
               AND COALESCE('s:' || phsmt.supplier_id, ${firstRecorded('sheet_material', 'sheet_material_type_id', 'phdf.hdf_sheet_material_type_id')}, 'none') = $${k})
        )`);
  }
  if (query.onecDocumentId !== undefined) {
    clauses.push(`EXISTS (
          SELECT 1 FROM order_resource_procurement dorp
            JOIN order_resource_onec_allocations da ON da.order_resource_procurement_id = dorp.order_resource_procurement_id AND da.removed_at IS NULL
            JOIN onec_document_lines dl ON dl.onec_document_line_id = da.onec_document_line_id
           WHERE dorp.order_id = o.order_id AND dl.onec_document_id = $${params.push(query.onecDocumentId)})`);
  }
  return clauses;
}

async function loadReceipts(client: DatabaseClient, orderIds: number[]): Promise<ReceiptRow[]> {
  if (orderIds.length === 0) return [];
  return (await client.query<ReceiptRow>(
    `SELECT a.order_resource_procurement_id, l.onec_document_id, a.quantity, a.unit_code, d.posted, d.deleted_in_onec
       FROM order_resource_onec_allocations a
       JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = a.order_resource_procurement_id
       JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
       JOIN onec_documents d ON d.onec_document_id = l.onec_document_id
      WHERE orp.order_id = ANY($1::bigint[])
        AND a.role = 'receipt'
        AND a.removed_at IS NULL`,
    [orderIds],
  )).rows;
}

async function loadOnecDocumentLineKeys(client: DatabaseClient, orderIds: number[], documentId: number): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = (await client.query<{ order_id: string; resource_kind: OrderResourceKind; ref_id: string }>(
    `SELECT DISTINCT orp.order_id::text, orp.resource_kind, COALESCE(orp.sheet_material_type_id, orp.film_id)::text AS ref_id
       FROM order_resource_onec_allocations a
       JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = a.order_resource_procurement_id
       JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
      WHERE orp.order_id = ANY($1::bigint[]) AND a.removed_at IS NULL AND l.onec_document_id = $2`,
    [orderIds, documentId],
  )).rows;
  return new Set(rows.map((row) => `${Number(row.order_id)}|${resourceKey(row.resource_kind, Number(row.ref_id))}`));
}

async function loadGeometry(
  client: DatabaseClient,
  sheetIds: number[],
): Promise<Map<number, { areaM2: number | null; supplier: { id: number; name: string } | null }>> {
  if (sheetIds.length === 0) return new Map();
  const rows = (await client.query<GeometryRow>(
    `SELECT smt.sheet_material_type_id, smt.width_mm, smt.height_mm, smt.supplier_id, s.supplier_name
       FROM sheet_material_types smt
       LEFT JOIN suppliers s ON s.supplier_id = smt.supplier_id
      WHERE smt.sheet_material_type_id = ANY($1::bigint[])`,
    [sheetIds],
  )).rows;
  return new Map(rows.map((row) => [Number(row.sheet_material_type_id), {
    areaM2: sheetAreaM2(row.width_mm, row.height_mm),
    supplier: row.supplier_id === null
      ? null
      : { id: Number(row.supplier_id), name: row.supplier_name?.trim() || `Поставщик #${Number(row.supplier_id)}` },
  }]));
}

async function loadRecordedSuppliers(
  client: DatabaseClient,
  sheetIds: number[],
  filmIds: number[],
): Promise<Map<string, SupplierCandidate[]>> {
  if (sheetIds.length === 0 && filmIds.length === 0) return new Map();
  const rows = (await client.query<RecordedSupplierRow>(
    `SELECT rs.resource_supplier_id, rs.resource_kind, COALESCE(rs.sheet_material_type_id, rs.film_id) AS ref_id,
            rs.supplier_key, COALESCE(NULLIF(btrim(s.supplier_name), ''), rs.counterparty_name) AS name, rs.first_seen_at
       FROM resource_suppliers rs
       LEFT JOIN suppliers s ON s.supplier_id = rs.supplier_id
      WHERE (rs.resource_kind = 'sheet_material' AND rs.sheet_material_type_id = ANY($1::bigint[]))
         OR (rs.resource_kind = 'film' AND rs.film_id = ANY($2::bigint[]))`,
    [sheetIds, filmIds],
  )).rows;
  const result = new Map<string, SupplierCandidate[]>();
  for (const row of rows) {
    const key = resourceKey(row.resource_kind, Number(row.ref_id));
    const list = result.get(key) ?? [];
    list.push({
      key: row.supplier_key,
      name: row.name?.trim() || row.supplier_key.slice(2),
      firstSeenAt: row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : new Date(row.first_seen_at).toISOString(),
      id: Number(row.resource_supplier_id),
    });
    result.set(key, list);
  }
  return result;
}

function settingsDto(row: SettingsRow): ProcurementSettingsDto {
  const updatedBy = row.updated_by_user_id === null ? null : Number(row.updated_by_user_id);
  return {
    leadDays: Number(row.lead_days),
    criticalDays: Number(row.critical_days),
    soonDays: Number(row.soon_days),
    wastePercent: Number(row.waste_percent),
    digestTime: row.digest_time,
    unallocatedAlertDays: Number(row.unallocated_alert_days),
    overdueWindowDays: Number(row.overdue_window_days),
    version: Number(row.version),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    updatedBy: updatedBy === null ? null : { userId: updatedBy, name: row.updated_by_name ?? `#${updatedBy}` },
  };
}

function comparable(settings: ProcurementSettingsDto): UpdateProcurementSettingsCommand['settings'] {
  return {
    leadDays: settings.leadDays,
    criticalDays: settings.criticalDays,
    soonDays: settings.soonDays,
    wastePercent: settings.wastePercent,
    digestTime: settings.digestTime,
    unallocatedAlertDays: settings.unallocatedAlertDays,
    overdueWindowDays: settings.overdueWindowDays,
  };
}

function sameSettings(left: UpdateProcurementSettingsCommand['settings'], right: UpdateProcurementSettingsCommand['settings']): boolean {
  return (Object.keys(left) as Array<keyof typeof left>).every((key) => left[key] === right[key]);
}

function settingsMissing(): ApiError {
  return new ApiError(503, 'PROCUREMENT_SETTINGS_MISSING', 'Настройки снабжения не найдены — примените миграции');
}

function readSavedViews(value: unknown): ProcurementSavedViewDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const view = item as Record<string, unknown>;
    return typeof view.id === 'string' && typeof view.name === 'string' && typeof view.query === 'string'
      ? [{ id: view.id, name: view.name, query: view.query }]
      : [];
  });
}

function actorId(currentUser: CurrentUser): number {
  const userId = Number(currentUser.id);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new ApiError(403, 'PROCUREMENT_ACTOR_INVALID', 'Представления доступны только пользователю ERP');
  }
  return userId;
}

function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = result.get(key) ?? [];
    list.push(item);
    result.set(key, list);
  }
  return result;
}

function toDateOnly(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
