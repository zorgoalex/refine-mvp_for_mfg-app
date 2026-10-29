import { createHash } from 'node:crypto';
import {
  loadCatalogMainSuppliers,
  loadMainSuppliers,
  type MainSupplierRef,
} from '../../material-suppliers/adapters/pg-material-suppliers';
import { STANDARD_PAYMENT_STATUS_IDS } from '../dto/save-order.dto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import { policyScopeSetsForUser } from '../../../permissions/policies/scope';
import type { ScopeGrant } from '../../../permissions/policies/scope-sets';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  BATH_METER_GUIDE_SHEET_HEIGHT_MM,
  calculateBathSheetFilmUsage,
  shouldShowBathMeterGuides,
} from '../../../shared/cut-geometry';
import {
  parseFreecutItemId,
  type SheetPlacementsJson,
} from '../../cut/application/cut-freecut-mapping';
import {
  RESOURCE_BY_MATERIAL_ORDER_LIMIT,
  RESOURCE_FILTER_ORDER_OPTIONS_LIMIT,
  RESOURCE_ONEC_DOCUMENT_OPTIONS_LIMIT,
  RESOURCE_SUPPLIER_NONE_KEY,
  type OrderResourceFilterOptionsResponseDto,
  type OrderResourceOnecDocumentOptionsResponseDto,
  type OrderResourceOnecDocRefDto,
  type GetOrderResourceCardCommand,
  type ListOrderResourceDemandsCommand,
  type OrderFilmDemandDto,
  type OrderProcurementSummaryDto,
  type OrderResourceByMaterialResponseDto,
  type OrderResourceCapabilitiesDto,
  type OrderResourceCardLineDto,
  type OrderResourceCardResponseDto,
  type OrderResourceDemandDto,
  type OrderResourceDemandLineDto,
  type OrderResourceDemandQuery,
  type OrderResourceDemandRepositoryPort,
  type OrderResourceDemandResponseDto,
  type OrderResourceDetailRefDto,
  type OrderResourceKind,
  type OrderResourceMaterialAggregateDto,
  type OrderResourceProcurementDto,
  type OrderResourceReadOptions,
  type OrderResourceSource,
  type OrderResourceUnit,
  type OrderSheetMaterialDemandDto,
} from '../application/order-resource-demand.types';
import { isCountableState, onecStateSql, type OnecDocumentState } from '../domain/onec-document-state';

interface CountRow extends QueryResultRow {
  total: string | number;
}

export interface ResourceDemandOrderRow extends QueryResultRow {
  order_id: string | number;
  order_name: string;
  full_number: string;
  order_date: string | Date | null;
  project_code: string;
  client_name: string | null;
  client_id?: string | number | null;
  updated_at: string | Date;
}

export interface ResourceDemandDetailRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  height: string | number | null;
  width: string | number | null;
  quantity: string | number | null;
  sheet_material_type_id: string | number | null;
  sheet_material_name: string | null;
  supplier_id: string | number | null;
  supplier_name: string | null;
  film_id: string | number | null;
  film_name: string | null;
  vendor_id: string | number | null;
  vendor_name: string | null;
  detail_number?: string | number | null;
  detail_name?: string | null;
  updated_at?: string | Date | null;
}

interface DetailCutJobRow extends QueryResultRow {
  order_detail_id: string | number;
  cut_job_id: string | number;
}

export interface ResourceDemandHdfRow extends QueryResultRow {
  order_hdf_detail_id: string | number;
  order_id: string | number;
  hdf_height_mm: string | number | null;
  hdf_width_mm: string | number | null;
  quantity: string | number | null;
  hdf_sheet_material_type_id: string | number | null;
  hdf_sheet_material_name: string | null;
  supplier_id: string | number | null;
  supplier_name: string | null;
  source_detail_number?: string | number | null;
  source_detail_name?: string | null;
  updated_at?: string | Date | null;
}

export interface ResourceDemandCutGroupRow extends QueryResultRow {
  cut_job_id: string | number;
  cut_group_id: string | number;
  summary: Record<string, unknown> | null;
  sheet_material_name: string | null;
  sheet_material_width_mm: string | number | null;
  sheet_material_height_mm: string | number | null;
  manual_sheets: unknown;
  manual_is_active: boolean | null;
  manual_is_stale: boolean | null;
}

export interface ResourceDemandCutSheetRow extends QueryResultRow {
  cut_group_id: string | number;
  sheet_index: string | number;
  placements: unknown;
}

export interface ResourceProcurementRow extends QueryResultRow {
  order_resource_procurement_id: string | number;
  order_id: string | number;
  resource_kind: OrderResourceKind;
  sheet_material_type_id: string | number | null;
  film_id: string | number | null;
  resource_name: string | null;
  purchased: boolean;
  origin: 'manual' | 'onec' | null;
  quantity_at_mark: string | number | null;
  unit_at_mark: OrderResourceUnit | null;
  demand_fingerprint_at_mark: string | null;
  marked_at: string | Date | null;
  marked_by: string | number | null;
  marked_by_name: string | null;
  version: string | number;
}

/** Деталь или HDF-позиция, из которой сложилась строка потребности. */
interface LineSourceRef {
  ref: OrderResourceDetailRefDto;
  /** Стабильный вклад в отпечаток: id + время изменения. */
  fingerprintKey: string;
}

interface SheetAccumulator {
  sheetMaterialTypeId: number;
  name: string;
  areaMm2: number;
  detailsCount: number;
  supplierId: number | null;
  supplierName: string | null;
  /** Ключ основного поставщика (`none` — не указан). */
  supplierKey: string;
  sources: LineSourceRef[];
}

interface FilmAccumulator {
  filmId: number;
  name: string;
  areaMm2: number;
  detailsCount: number;
  linearMeters: number;
  sheets: number;
  vendorId: number | null;
  vendorName: string | null;
  /** Основной поставщик (не производитель): первый выбранный, иначе по приходам 1С. */
  supplierName: string | null;
  supplierKey: string;
  sources: LineSourceRef[];
  cutJobIds: Set<number>;
}

interface ProjectionInput {
  orders: ResourceDemandOrderRow[];
  details: ResourceDemandDetailRow[];
  hdfDetails?: ResourceDemandHdfRow[];
  detailCutJobs: DetailCutJobRow[];
  cutGroups: ResourceDemandCutGroupRow[];
  cutSheets: ResourceDemandCutSheetRow[];
  /** Основные поставщики позиций (`loadMainSuppliers`); без них — основной листового из справочника, у плёнки — нет. */
  mainSuppliers?: Map<string, MainSupplierRef>;
  /**
   * Фильтр «Поставщик»: в `sheetMaterials`/`films` остаются только материалы этих поставщиков. Строки (`lines`) —
   * всегда полные: по ним закуп находит «сирот»; их сужает чтение после наложения закупа (`keepSupplierLines`).
   */
  supplierKeys?: SupplierKeyFilter;
}

/** Фильтр «Поставщик» по ключу основного поставщика (Set выбранных или «все, кроме»). */
export interface SupplierKeyFilter {
  has(key: string): boolean;
}

export type OrderResourceDemandBaseDto = Omit<OrderResourceDemandDto, 'lines' | 'procurementSummary'>;

/** Строка потребности до наложения закупа: количество, источники и отпечаток. */
export interface ProjectedResourceLine {
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
  supplierName: string | null;
  /** «supplierName — поставщик» (с migr 280; прежний backend у плёнок клал сюда производителя). */
  supplierRole: 'supplier';
  supplierKey: string;
  quantity: number | null;
  unit: OrderResourceUnit;
  areaM2: number;
  detailsCount: number;
  source: OrderResourceSource;
  demandFingerprint: string;
  details: OrderResourceDetailRefDto[];
}

export interface ProjectedOrder {
  orderId: number;
  base: OrderResourceDemandBaseDto;
  lines: ProjectedResourceLine[];
}

interface ProjectionResult {
  base: OrderResourceDemandBaseDto[];
  lines: Map<number, ProjectedResourceLine[]>;
}

export class PgOrderResourceDemandRepository implements OrderResourceDemandRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  async list(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceDemandResponseDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return this.listInSnapshot(client, command, options);
    });
  }

  async getCard(
    command: GetOrderResourceCardCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceCardResponseDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { whereSql, params } = buildScopedOrderWhere(command.currentUser, command.orderId);
      const orders = await client.query<ResourceDemandOrderRow>(
        `${ORDER_SELECT_SQL} WHERE ${whereSql}`,
        params,
      );
      if (orders.rows.length === 0) {
        throw orderNotFound();
      }
      const [order] = await loadProjectedOrders(client, orders.rows, undefined);
      const procurement = options.procurementEnabled
        ? await loadProcurementRows(client, [order.orderId])
        : [];
      const onecLinks = options.procurementEnabled ? await loadOnecLinks(client, [order.orderId]) : [];
      const lines = applyProcurement(
        order.lines,
        procurement.filter((row) => toNumber(row.order_id) === order.orderId),
        { onecLinks, canSeeAmounts: options.canSeeAmounts === true },
      );
      const cardLines: OrderResourceCardLineDto[] = lines.map(({ line, details }) => ({ ...line, details }));
      return {
        data: {
          ...order.base,
          lines: cardLines,
          procurementSummary: summarizeProcurement(cardLines),
        },
        refreshedAt: new Date().toISOString(),
        capabilities: capabilities(options),
      };
    });
  }

  async listByMaterial(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceByMaterialResponseDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { whereSql, params } = buildOrderWhere(command, options, await resolveSupplierResources(client, command.query));
      const limitIndex = params.push(RESOURCE_BY_MATERIAL_ORDER_LIMIT + 1);
      const orders = await client.query<ResourceDemandOrderRow>(
        `${ORDER_SELECT_SQL}
        WHERE ${whereSql}
        ORDER BY o.order_date DESC NULLS LAST, o.order_id DESC
        LIMIT $${limitIndex}`,
        params,
      );
      if (orders.rows.length > RESOURCE_BY_MATERIAL_ORDER_LIMIT) {
        throw new ApiError(422, 'ORDER_RESOURCE_BY_MATERIAL_TOO_MANY', 'Слишком много заказов для сводки по материалам. Сузьте период или фильтры', {
          limit: RESOURCE_BY_MATERIAL_ORDER_LIMIT,
        });
      }
      const projected = await loadProjectedOrders(client, orders.rows, undefined);
      const procurement = options.procurementEnabled
        ? await loadProcurementRows(client, projected.map((order) => order.orderId))
        : [];
      return {
        data: aggregateByMaterial(projected, procurement, supplierKeySet(command.query)),
        ordersCount: projected.length,
        refreshedAt: new Date().toISOString(),
        capabilities: capabilities(options),
      };
    });
  }

  /**
   * Варианты фильтра «Документ 1С»: документы, активно распределённые на заказы
   * текущей выборки (все страницы, те же фильтры и scope; сам onecDocumentId игнорируется).
   */
  async listOnecDocumentOptions(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceOnecDocumentOptionsResponseDto> {
    if (!options.procurementEnabled) return { data: [], truncated: false };
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { onecDocumentId: _ignored, ...query } = command.query;
      const { whereSql, params } = buildOrderWhere({ ...command, query }, options, await resolveSupplierResources(client, query));
      const limitIndex = params.push(RESOURCE_ONEC_DOCUMENT_OPTIONS_LIMIT + 1);
      const result = await client.query<{
        onec_document_id: string; doc_kind: OrderResourceOnecDocRefDto['kind']; number: string; doc_date: string; orders_count: number;
      }>(
        `SELECT d.onec_document_id::text, d.doc_kind, d.number, d.doc_date::text AS doc_date,
                count(DISTINCT o.order_id)::int AS orders_count
           FROM orders o
           JOIN projects p ON p.project_id = o.project_id
           LEFT JOIN clients c ON c.client_id = o.client_id
           JOIN order_resource_procurement orp ON orp.order_id = o.order_id
           JOIN order_resource_onec_allocations a
             ON a.order_resource_procurement_id = orp.order_resource_procurement_id AND a.removed_at IS NULL
           JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
           JOIN onec_documents d ON d.onec_document_id = l.onec_document_id
          WHERE ${whereSql}
          GROUP BY d.onec_document_id, d.doc_kind, d.number, d.doc_date
          ORDER BY d.doc_date DESC, d.onec_document_id DESC
          LIMIT $${limitIndex}`,
        params,
      );
      const rows = result.rows.slice(0, RESOURCE_ONEC_DOCUMENT_OPTIONS_LIMIT);
      return {
        data: rows.map((row) => ({
          documentId: Number(row.onec_document_id),
          kind: row.doc_kind,
          number: row.number,
          date: row.doc_date,
          ordersCount: Number(row.orders_count),
        })),
        truncated: result.rows.length > RESOURCE_ONEC_DOCUMENT_OPTIONS_LIMIT,
      };
    });
  }

  private async listInSnapshot(
    client: DatabaseClient,
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceDemandResponseDto> {
    const supplierResources = await resolveSupplierResources(client, command.query);
    const { whereSql, params } = buildOrderWhere(command, options, supplierResources);
    const countResult = await client.query<CountRow>(
      `
      SELECT COUNT(*)::int AS total
      FROM orders o
      JOIN projects p ON p.project_id = o.project_id
      LEFT JOIN clients c ON c.client_id = o.client_id
      WHERE ${whereSql}
      `,
      params,
    );
    const total = toNumber(countResult.rows[0]?.total);
    const orderResult = await loadOrderPage(client, command.query, whereSql, params, supplierResources);

    const projected = await loadProjectedOrders(client, orderResult.rows, command.query);
    const procurement = options.procurementEnabled && projected.length > 0
      ? await loadProcurementRows(client, projected.map((order) => order.orderId))
      : [];
    const onecLinks = options.procurementEnabled && projected.length > 0
      ? await loadOnecLinks(client, projected.map((order) => order.orderId))
      : [];
    const orphanSuppliers = await loadOrphanSuppliers(client, projected, procurement);
    const supplierKeys = supplierKeySet(command.query);
    const data = projected.map<OrderResourceDemandDto>((order) => {
      const lines = keepSupplierLines(applyProcurement(
        order.lines,
        procurement.filter((row) => toNumber(row.order_id) === order.orderId),
        { onecLinks, canSeeAmounts: options.canSeeAmounts === true, orphanSuppliers },
      ), supplierKeys).map(({ line }) => line);
      return { ...order.base, lines, procurementSummary: summarizeProcurement(lines) };
    });
    return response(command.query, total, data, options);
  }

  /**
   * Варианты фильтров заголовков по всей выборке (все страницы): те же scope и фильтры панели, что у списка,
   * без фильтров заголовков. Имя позиции — из справочника (у строки HDF может быть снимок имени).
   */
  async listFilterOptions(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceFilterOptionsResponseDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { orderIds: _o, orderDates: _d, sheetMaterialTypeIds: _s, filmIds: _f, supplierKeys: _k, supplierKeysExclude: _x, ...query } = command.query;
      const { whereSql, params } = buildOrderWhere({ ...command, query }, options, undefined);
      const selection = `
        SELECT o.order_id, o.order_name, o.order_date, p.code AS project_code, c.client_name
          FROM orders o
          JOIN projects p ON p.project_id = o.project_id
          LEFT JOIN clients c ON c.client_id = o.client_id
         WHERE ${whereSql}`;
      const limitIndex = params.push(RESOURCE_FILTER_ORDER_OPTIONS_LIMIT + 1);
      const orders = await client.query<{ order_id: string; order_name: string; project_code: string; client_name: string | null }>(
        `SELECT fo.order_id::text, fo.order_name, fo.project_code, fo.client_name
           FROM (${selection}) fo
          ORDER BY fo.order_date DESC NULLS LAST, fo.order_id DESC
          LIMIT $${limitIndex}`,
        params,
      );
      const facets = await client.query<{ kind: 'date' | 'no_date' | 'sheet' | 'film' | 'no_sheet' | 'no_film'; id: string | null; name: string | null }>(
        `WITH fo AS (${selection}),
        res AS (
          SELECT od.order_id, 'sheet'::text AS kind, od.sheet_material_type_id AS id
            FROM order_details od JOIN fo ON fo.order_id = od.order_id
           WHERE od.delete_flag = false AND od.sheet_material_type_id IS NOT NULL
          UNION
          SELECT hdf.order_id, 'sheet', hdf.hdf_sheet_material_type_id
            FROM order_hdf_details hdf
            JOIN fo ON fo.order_id = hdf.order_id
            JOIN hdf_calculation_config_state hdf_state ON hdf_state.id = 1
           WHERE hdf.delete_flag = false AND hdf.status = 'ok' AND hdf.config_revision = hdf_state.revision
             AND hdf.hdf_sheet_material_type_id IS NOT NULL
          UNION
          SELECT od.order_id, 'film', od.film_id
            FROM order_details od JOIN fo ON fo.order_id = od.order_id
           WHERE od.delete_flag = false AND od.film_id IS NOT NULL
        )
        SELECT DISTINCT 'date' AS kind, fo.order_date::text AS id, NULL::text AS name FROM fo WHERE fo.order_date IS NOT NULL
        UNION ALL
        SELECT 'no_date', NULL, NULL WHERE EXISTS (SELECT 1 FROM fo WHERE fo.order_date IS NULL)
        UNION ALL
        SELECT 'sheet', r.id::text, smt.name
          FROM (SELECT DISTINCT id FROM res WHERE kind = 'sheet') r
          LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = r.id
        UNION ALL
        SELECT 'film', r.id::text, f.film_name
          FROM (SELECT DISTINCT id FROM res WHERE kind = 'film') r
          LEFT JOIN films f ON f.film_id = r.id
        UNION ALL
        SELECT 'no_sheet', NULL, NULL
         WHERE EXISTS (SELECT 1 FROM fo WHERE NOT EXISTS (SELECT 1 FROM res WHERE res.order_id = fo.order_id AND res.kind = 'sheet'))
        UNION ALL
        SELECT 'no_film', NULL, NULL
         WHERE EXISTS (SELECT 1 FROM fo WHERE NOT EXISTS (SELECT 1 FROM res WHERE res.order_id = fo.order_id AND res.kind = 'film'))`,
        params.slice(0, limitIndex - 1),
      );
      const named = (kind: 'sheet' | 'film') => facets.rows
        .filter((row) => row.kind === kind)
        .map((row) => ({ id: Number(row.id), name: cleanName(row.name) ?? `ID: ${row.id}` }))
        .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.id - right.id);
      const sheetMaterials = named('sheet');
      const films = named('film');
      const mains = await loadMainSuppliers(client, sheetMaterials.map((row) => row.id), films.map((row) => row.id));
      const suppliers = new Map<string, string>();
      let withoutSupplier = false;
      for (const key of [
        ...sheetMaterials.map((row) => resourceKey('sheet_material', row.id)),
        ...films.map((row) => resourceKey('film', row.id)),
      ]) {
        const main = mains.get(key);
        if (main) suppliers.set(main.key, main.name);
        else withoutSupplier = true;
      }
      return {
        orders: orders.rows.slice(0, RESOURCE_FILTER_ORDER_OPTIONS_LIMIT).map((row) => ({
          orderId: Number(row.order_id),
          orderName: row.order_name,
          projectCode: row.project_code,
          clientName: cleanName(row.client_name),
        })),
        ordersTruncated: orders.rows.length > RESOURCE_FILTER_ORDER_OPTIONS_LIMIT,
        dates: facets.rows.filter((row) => row.kind === 'date').map((row) => String(row.id)).sort().reverse(),
        hasEmptyDate: facets.rows.some((row) => row.kind === 'no_date'),
        sheetMaterials,
        hasNoSheetMaterials: facets.rows.some((row) => row.kind === 'no_sheet'),
        films,
        hasNoFilms: facets.rows.some((row) => row.kind === 'no_film'),
        suppliers: [
          ...[...suppliers].map(([key, name]) => ({ key, name }))
            .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.key.localeCompare(right.key)),
          ...(withoutSupplier ? [{ key: RESOURCE_SUPPLIER_NONE_KEY, name: 'Без поставщика' }] : []),
        ],
      };
    });
  }
}

/** Фильтр «Поставщик» запроса (undefined — фильтра нет); `supplierKeysExclude` — «все, кроме». */
export function supplierKeySet(
  query: Pick<OrderResourceDemandQuery, 'supplierKeys' | 'supplierKeysExclude'>,
): SupplierKeyFilter | undefined {
  if (!query.supplierKeys) return undefined;
  const keys = new Set(query.supplierKeys);
  return query.supplierKeysExclude ? { has: (key) => !keys.has(key) } : keys;
}

/** Материалы основных поставщиков из фильтра — по всему справочнику, по тому же правилу, что у строк. */
export interface SupplierResourceSets {
  sheetIds: number[];
  filmIds: number[];
}

export async function resolveSupplierResources(
  client: DatabaseClient,
  query: Pick<OrderResourceDemandQuery, 'supplierKeys' | 'supplierKeysExclude'>,
): Promise<SupplierResourceSets | undefined> {
  const wanted = supplierKeySet(query);
  if (!wanted) return undefined;
  const catalog = await loadCatalogMainSuppliers(client);
  const matches = (kind: OrderResourceKind, id: number) => wanted.has(catalog.mains.get(resourceKey(kind, id))?.key ?? RESOURCE_SUPPLIER_NONE_KEY);
  return {
    sheetIds: catalog.sheetIds.filter((id) => matches('sheet_material', id)),
    filmIds: catalog.filmIds.filter((id) => matches('film', id)),
  };
}

/** Основные поставщики материалов, которых нет в потребности заказов, но есть отметка закупа («сироты»). */
async function loadOrphanSuppliers(
  client: DatabaseClient,
  projected: ProjectedOrder[],
  procurement: ResourceProcurementRow[],
): Promise<Map<string, MainSupplierRef> | undefined> {
  const present = new Set(projected.flatMap((order) => order.lines.map((line) => `${order.orderId}|${line.resourceKey}`)));
  const orphans = procurement.filter((row) => !present.has(`${toNumber(row.order_id)}|${procurementRowKey(row)}`));
  if (orphans.length === 0) return undefined;
  return loadMainSuppliers(
    client,
    uniqueNumbers(orphans.filter((row) => row.resource_kind === 'sheet_material').map((row) => row.sheet_material_type_id)),
    uniqueNumbers(orphans.filter((row) => row.resource_kind === 'film').map((row) => row.film_id)),
  );
}

export const ORDER_SELECT_SQL = `
      SELECT
        o.order_id,
        o.order_name,
        (p.code || '-' || o.order_name) AS full_number,
        o.order_date,
        p.code AS project_code,
        c.client_name,
        o.client_id,
        o.updated_at
      FROM orders o
      JOIN projects p ON p.project_id = o.project_id
      LEFT JOIN clients c ON c.client_id = o.client_id`;

/**
 * Живая потребность заказов: детали, HDF и готовые раскрои в одном снимке.
 * Строки (`lines`) всегда считаются по полному составу заказа — их отпечаток
 * сравнивается командами закупа. Фильтры ресурса из запроса влияют только на
 * совместимые поля `sheetMaterials`/`films`, как раньше; фильтр «Поставщик»
 * убирает строки и позиции других поставщиков, не меняя оставшиеся.
 */
export async function loadProjectedOrders(
  client: DatabaseClient,
  orderRows: ResourceDemandOrderRow[],
  query: OrderResourceDemandQuery | undefined,
): Promise<ProjectedOrder[]> {
  const orderIds = orderRows.map((row) => toNumber(row.order_id));
  if (orderIds.length === 0) return [];

  const detailResult = await client.query<ResourceDemandDetailRow>(
    `
    SELECT
      od.detail_id,
      od.order_id,
      od.height,
      od.width,
      od.quantity,
      od.detail_number,
      od.detail_name,
      od.updated_at,
      od.sheet_material_type_id,
      smt.name AS sheet_material_name,
      smt.supplier_id,
      supplier.supplier_name,
      od.film_id,
      f.film_name,
      f.vendor_id,
      vendor.vendor_name
    FROM order_details od
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
    LEFT JOIN suppliers supplier ON supplier.supplier_id = smt.supplier_id
    LEFT JOIN films f ON f.film_id = od.film_id
    LEFT JOIN vendors vendor ON vendor.vendor_id = f.vendor_id
    WHERE od.order_id = ANY($1::bigint[])
      AND od.delete_flag = false
    ORDER BY od.order_id, od.detail_number, od.detail_id
    `,
    [orderIds],
  );

  const hdfResult = await client.query<ResourceDemandHdfRow>(
    `
    SELECT
      hdf.order_hdf_detail_id,
      hdf.order_id,
      hdf.hdf_height_mm,
      hdf.hdf_width_mm,
      hdf.quantity,
      hdf.hdf_sheet_material_type_id,
      hdf.hdf_sheet_material_name,
      hdf.source_detail_number,
      hdf.source_detail_name,
      hdf.updated_at,
      hdf_smt.supplier_id,
      supplier.supplier_name
    FROM order_hdf_details hdf
    JOIN hdf_calculation_config_state hdf_state ON hdf_state.id = 1
    LEFT JOIN sheet_material_types hdf_smt
      ON hdf_smt.sheet_material_type_id = hdf.hdf_sheet_material_type_id
    LEFT JOIN suppliers supplier ON supplier.supplier_id = hdf_smt.supplier_id
    WHERE hdf.order_id = ANY($1::bigint[])
      AND hdf.delete_flag = false
      AND hdf.status = 'ok'
      AND hdf.config_revision = hdf_state.revision
    ORDER BY hdf.order_id, hdf.source_detail_number, hdf.order_hdf_detail_id
    `,
    [orderIds],
  );

  const detailIds = detailResult.rows.map((row) => toNumber(row.detail_id));
  const detailCutJobs = detailIds.length === 0
    ? { rows: [] as DetailCutJobRow[] }
    : await client.query<DetailCutJobRow>(
        `
        SELECT DISTINCT ON (cji.order_detail_id)
          cji.order_detail_id,
          cj.cut_job_id
        FROM cut_job_item cji
        JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
        WHERE cji.order_detail_id = ANY($1::bigint[])
          AND cji.is_active = true
          AND cj.status = 'ready'
        ORDER BY cji.order_detail_id, cj.cut_job_id DESC
        `,
        [detailIds],
      );
  const cutJobIds = uniqueNumbers(detailCutJobs.rows.map((row) => row.cut_job_id));
  const cutGroups = cutJobIds.length === 0
    ? { rows: [] as ResourceDemandCutGroupRow[] }
    : await client.query<ResourceDemandCutGroupRow>(
        `
        SELECT
          cg.cut_job_id,
          cg.cut_group_id,
          cg.summary,
          smt.name AS sheet_material_name,
          smt.width_mm AS sheet_material_width_mm,
          smt.height_mm AS sheet_material_height_mm,
          manual.sheets AS manual_sheets,
          manual.is_active AS manual_is_active,
          manual.is_stale AS manual_is_stale
        FROM cut_group cg
        LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = cg.sheet_material_type_id
        LEFT JOIN cut_group_manual_layout manual
          ON manual.cut_job_id = cg.cut_job_id
         AND manual.group_key = cg.group_key
        WHERE cg.cut_job_id = ANY($1::bigint[])
        ORDER BY cg.cut_job_id, cg.cut_group_id
        `,
        [cutJobIds],
      );
  const cutGroupIds = cutGroups.rows.map((row) => toNumber(row.cut_group_id));
  const cutSheets = cutGroupIds.length === 0
    ? { rows: [] as ResourceDemandCutSheetRow[] }
    : await client.query<ResourceDemandCutSheetRow>(
        `
        SELECT cut_group_id, sheet_index, placements
        FROM cut_group_sheet
        WHERE cut_group_id = ANY($1::bigint[])
        ORDER BY cut_group_id, sheet_index
        `,
        [cutGroupIds],
      );

  const mainSuppliers = await loadMainSuppliers(
    client,
    uniqueNumbers([
      ...detailResult.rows.map((row) => row.sheet_material_type_id),
      ...hdfResult.rows.map((row) => row.hdf_sheet_material_type_id),
    ].filter((id) => id !== null && id !== undefined)),
    uniqueNumbers(detailResult.rows.map((row) => row.film_id).filter((id) => id !== null && id !== undefined)),
  );
  const supplierKeys = query ? supplierKeySet(query) : undefined;
  const full = projectOrders({
    orders: orderRows,
    details: detailResult.rows,
    hdfDetails: hdfResult.rows,
    detailCutJobs: detailCutJobs.rows,
    cutGroups: cutGroups.rows,
    cutSheets: cutSheets.rows,
    mainSuppliers,
    supplierKeys,
  });
  const legacyBase = query && hasResourceFilters(query)
    ? projectOrders({
        orders: orderRows,
        details: detailResult.rows.filter((row) => detailMatchesResourceFilters(row, query)),
        hdfDetails: hdfResult.rows.filter((row) => hdfMatchesResourceFilters(row, query)),
        detailCutJobs: detailCutJobs.rows,
        cutGroups: cutGroups.rows,
        cutSheets: cutSheets.rows,
        mainSuppliers,
        supplierKeys,
      }).base
    : full.base;

  return legacyBase.map((base) => ({
    orderId: base.orderId,
    base,
    lines: full.lines.get(base.orderId) ?? [],
  }));
}

export async function loadProcurementRows(
  client: DatabaseClient,
  orderIds: number[],
  lockForUpdate = false,
): Promise<ResourceProcurementRow[]> {
  if (orderIds.length === 0) return [];
  const result = await client.query<ResourceProcurementRow>(
    `
    SELECT
      orp.order_resource_procurement_id,
      orp.order_id,
      orp.resource_kind,
      orp.sheet_material_type_id,
      orp.film_id,
      COALESCE(smt.name, f.film_name) AS resource_name,
      orp.purchased,
      orp.origin,
      orp.quantity_at_mark,
      orp.unit_at_mark,
      orp.demand_fingerprint_at_mark,
      orp.marked_at,
      orp.marked_by,
      (SELECT COALESCE(NULLIF(btrim(u.full_name), ''), u.username::text) FROM users u WHERE u.user_id = orp.marked_by) AS marked_by_name,
      orp.version
    FROM order_resource_procurement orp
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = orp.sheet_material_type_id
    LEFT JOIN films f ON f.film_id = orp.film_id
    WHERE orp.order_id = ANY($1::bigint[])
    ORDER BY orp.order_id, orp.order_resource_procurement_id
    ${lockForUpdate ? 'FOR UPDATE OF orp' : ''}
    `,
    [orderIds],
  );
  return result.rows;
}

export function procurementRowKey(row: ResourceProcurementRow): string {
  return row.resource_kind === 'sheet_material'
    ? resourceKey('sheet_material', toNumber(row.sheet_material_type_id))
    : resourceKey('film', toNumber(row.film_id));
}

export function resourceKey(kind: OrderResourceKind, refId: number): string {
  return `${kind}:${refId}`;
}

export function parseResourceKey(value: string): { kind: OrderResourceKind; refId: number } | null {
  const match = /^(sheet_material|film):([1-9][0-9]{0,17})$/.exec(value);
  if (!match) return null;
  const refId = Number(match[2]);
  return Number.isSafeInteger(refId) ? { kind: match[1] as OrderResourceKind, refId } : null;
}

const EMPTY_PROCUREMENT: OrderResourceProcurementDto = {
  purchased: false,
  version: 0,
  origin: null,
  markedAt: null,
  markedBy: null,
  quantityAtMark: null,
  unitAtMark: null,
  changedSinceMark: false,
};

export function procurementDto(
  row: ResourceProcurementRow | undefined,
  currentFingerprint: string,
): OrderResourceProcurementDto {
  if (!row) return EMPTY_PROCUREMENT;
  const markedBy = toNullableNumber(row.marked_by);
  return {
    purchased: row.purchased,
    version: toNumber(row.version),
    origin: row.origin,
    markedAt: row.marked_at ? toIsoString(row.marked_at) : null,
    markedBy: markedBy === null ? null : { userId: markedBy, name: row.marked_by_name ?? `#${markedBy}` },
    quantityAtMark: toNullableNumber(row.quantity_at_mark),
    unitAtMark: row.unit_at_mark,
    changedSinceMark: row.purchased && row.demand_fingerprint_at_mark !== currentFingerprint,
  };
}

/**
 * Накладывает закуп на строки потребности. Отмеченный материал, которого заказу
 * больше не нужно, возвращается строкой-сиротой с нулевым количеством.
 */
export interface OnecLinkRow extends QueryResultRow {
  allocation_id: string | number;
  order_resource_procurement_id: string | number;
  role: 'receipt' | 'payment';
  quantity: string | number | null;
  amount: string | number | null;
  origin: 'auto' | 'manual' | 'suggested';
  onec_document_id: string | number;
  doc_kind: 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';
  number: string;
  doc_date: string | Date;
  posted: boolean;
  deleted_in_onec: boolean;
  /** Состояние документа/строки 1С (onecStateSql). */
  doc_state: OnecDocumentState;
}

export interface ApplyProcurementExtras {
  /** Активные распределения документов 1С на закупы этих заказов. */
  onecLinks?: OnecLinkRow[];
  /** Право finance.view: без него суммы — null. */
  canSeeAmounts?: boolean;
  /** Основные поставщики материалов «сирот» (их нет в потребности); без карты — поставщик не указан. */
  orphanSuppliers?: Map<string, MainSupplierRef>;
}

/**
 * Активные распределения документов 1С на закупы заказов. Таблица фазы 3 читается
 * только при включённом флаге закупа (вызывающая сторона проверяет флаг).
 */
export async function loadOnecLinks(client: DatabaseClient, orderIds: number[]): Promise<OnecLinkRow[]> {
  if (orderIds.length === 0) return [];
  const result = await client.query<OnecLinkRow>(
    `
    SELECT a.allocation_id, a.order_resource_procurement_id, a.role, a.quantity, a.amount, a.origin,
           d.onec_document_id, d.doc_kind, d.number, d.doc_date::text AS doc_date, d.posted, d.deleted_in_onec,
           ${onecStateSql()} AS doc_state
      FROM order_resource_onec_allocations a
      JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = a.order_resource_procurement_id
      JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
      JOIN onec_documents d ON d.onec_document_id = l.onec_document_id
     WHERE orp.order_id = ANY($1::bigint[])
       AND a.removed_at IS NULL
     ORDER BY d.doc_date, d.onec_document_id, a.allocation_id
    `,
    [orderIds],
  );
  return result.rows;
}

/**
 * Приход из ДЕЙСТВУЮЩЕГО документа 1С (проведён, не удалён, есть в выгрузке, строка не удалена; конфликт — действует)
 * запрещает снимать «Закуплено».
 */
export function isReceiptLock(link: OnecLinkRow): boolean {
  return link.role === 'receipt' && isCountableState(link.doc_state);
}

function onecForRow(
  row: ResourceProcurementRow | undefined,
  extras: ApplyProcurementExtras,
): Pick<OrderResourceDemandLineDto, 'onec' | 'lockedByOnec'> {
  if (!row) return { onec: { receipts: [], payments: [] }, lockedByOnec: false };
  const id = toNumber(row.order_resource_procurement_id);
  const links = (extras.onecLinks ?? []).filter((link) => toNumber(link.order_resource_procurement_id) === id);
  const refs = links.map((link) => ({
    documentId: toNumber(link.onec_document_id),
    allocationId: toNumber(link.allocation_id),
    kind: link.doc_kind,
    number: link.number,
    date: toDateOnly(link.doc_date) ?? '',
    quantity: toNullableNumber(link.quantity),
    amount: extras.canSeeAmounts ? toNullableNumber(link.amount) : null,
    linkOrigin: link.origin,
    posted: link.posted,
    deletedInOnec: link.deleted_in_onec,
    documentState: link.doc_state,
  }));
  return {
    onec: {
      receipts: refs.filter((_, index) => links[index].role === 'receipt'),
      payments: refs.filter((_, index) => links[index].role === 'payment'),
    },
    lockedByOnec: links.some(isReceiptLock),
  };
}

export function applyProcurement(
  lines: ProjectedResourceLine[],
  procurement: ResourceProcurementRow[],
  extras: ApplyProcurementExtras = {},
): Array<{ line: OrderResourceDemandLineDto; details: OrderResourceDetailRefDto[] }> {
  const byKey = new Map(procurement.map((row) => [procurementRowKey(row), row]));
  const result = lines.map((projected) => {
    const { details, ...rest } = projected;
    const row = byKey.get(projected.resourceKey);
    return {
      line: {
        ...rest,
        orphan: false,
        procurement: procurementDto(row, projected.demandFingerprint),
        ...onecForRow(row, extras),
      },
      details,
    };
  });
  const present = new Set(lines.map((line) => line.resourceKey));
  const linked = new Set((extras.onecLinks ?? []).map((link) => toNumber(link.order_resource_procurement_id)));
  for (const row of procurement) {
    if (present.has(procurementRowKey(row))) continue;
    // Сирота показывается, пока отмечена «Закуплено» или на неё распределён документ 1С —
    // иначе такое распределение нельзя было бы снять (нет версии закупа).
    if (!row.purchased && !linked.has(toNumber(row.order_resource_procurement_id))) continue;
    result.push({ line: orphanLine(row, extras), details: [] });
  }
  return result;
}

/**
 * Строка для записи закупа, материала которой больше нет в потребности заказа.
 * В списки попадает только отмеченная; команды используют её и после снятия
 * отметки, чтобы вернуть итоговое состояние (и для no-op повтора снятия).
 */
export function orphanLine(row: ResourceProcurementRow, extras: ApplyProcurementExtras = {}): OrderResourceDemandLineDto {
  const kind = row.resource_kind;
  const refId = kind === 'sheet_material' ? toNumber(row.sheet_material_type_id) : toNumber(row.film_id);
  const fingerprint = emptyDemandFingerprint(kind, refId);
  return {
    resourceKey: procurementRowKey(row),
    kind,
    refId,
    name: cleanName(row.resource_name) ?? `ID: ${refId}`,
    supplierName: extras.orphanSuppliers?.get(procurementRowKey(row))?.name ?? null,
    supplierRole: 'supplier',
    supplierKey: extras.orphanSuppliers?.get(procurementRowKey(row))?.key ?? RESOURCE_SUPPLIER_NONE_KEY,
    quantity: 0,
    unit: kind === 'film' ? 'lm' : 'm2',
    areaM2: 0,
    detailsCount: 0,
    source: 'none',
    demandFingerprint: fingerprint,
    orphan: true,
    procurement: procurementDto(row, fingerprint),
    ...onecForRow(row, extras),
  };
}

/** Фильтр «Поставщик» после наложения закупа: остаются строки (и «сироты») выбранных поставщиков. */
export function keepSupplierLines<T extends { line: OrderResourceDemandLineDto }>(
  lines: T[],
  supplierKeys: SupplierKeyFilter | undefined,
): T[] {
  return supplierKeys ? lines.filter(({ line }) => supplierKeys.has(line.supplierKey)) : lines;
}

export function summarizeProcurement(lines: OrderResourceDemandLineDto[]): OrderProcurementSummaryDto {
  const active = lines.filter((line) => !line.orphan);
  return {
    total: active.length,
    purchased: active.filter((line) => line.procurement.purchased).length,
    orphanPurchased: lines.filter((line) => line.orphan && line.procurement.purchased).length,
  };
}

export function aggregateByMaterial(
  orders: ProjectedOrder[],
  procurement: ResourceProcurementRow[],
  supplierKeys?: SupplierKeyFilter,
): OrderResourceMaterialAggregateDto[] {
  const byMaterial = new Map<string, OrderResourceMaterialAggregateDto>();
  for (const order of orders) {
    const orderProcurement = procurement.filter((row) => toNumber(row.order_id) === order.orderId);
    for (const { line } of keepSupplierLines(applyProcurement(order.lines, orderProcurement), supplierKeys)) {
      if (line.orphan) continue;
      const current = byMaterial.get(line.resourceKey) ?? {
        resourceKey: line.resourceKey,
        kind: line.kind,
        refId: line.refId,
        name: line.name,
        supplierName: line.supplierName,
        supplierRole: 'supplier',
        unit: line.unit,
        totalQuantity: 0,
        ordersCount: 0,
        detailsCount: 0,
        noDataOrders: 0,
        purchasedOrders: 0,
        participants: [],
      };
      current.ordersCount += 1;
      current.detailsCount += line.detailsCount;
      if (line.quantity === null) current.noDataOrders += 1;
      else current.totalQuantity += line.quantity;
      if (line.procurement.purchased) current.purchasedOrders += 1;
      current.participants.push({
        orderId: order.orderId,
        orderName: order.base.orderName,
        purchased: line.procurement.purchased,
        version: line.procurement.version,
        demandFingerprint: line.demandFingerprint,
      });
      byMaterial.set(line.resourceKey, current);
    }
  }
  return [...byMaterial.values()]
    .map((row) => ({
      ...row,
      totalQuantity: row.unit === 'lm' ? roundTo1(row.totalQuantity) : Math.round(row.totalQuantity * 100) / 100,
    }))
    .sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'sheet_material' ? -1 : 1)
      || left.name.localeCompare(right.name, 'ru')
      || left.refId - right.refId);
}

export function buildOrderResourceDemandProjection(input: ProjectionInput): OrderResourceDemandBaseDto[] {
  return projectOrders(input).base;
}

export function projectOrders(input: ProjectionInput): ProjectionResult {
  const sheetByOrder = new Map<number, Map<number, SheetAccumulator>>();
  const filmByOrder = new Map<number, Map<number, FilmAccumulator>>();
  const detailById = new Map<number, ResourceDemandDetailRow>();
  const cutJobByDetailId = new Map(
    input.detailCutJobs.map((row) => [toNumber(row.order_detail_id), toNumber(row.cut_job_id)]),
  );

  for (const detail of input.details) {
    const detailId = toNumber(detail.detail_id);
    const orderId = toNumber(detail.order_id);
    detailById.set(detailId, detail);
    const areaMm2 = detailAreaMm2(detail);
    const source = detailSourceRef(detail);
    const sheetMaterialTypeId = toNullableNumber(detail.sheet_material_type_id);
    if (sheetMaterialTypeId !== null) {
      const rows = getOrCreate(sheetByOrder, orderId, () => new Map());
      const current = rows.get(sheetMaterialTypeId) ?? {
        sheetMaterialTypeId,
        name: cleanName(detail.sheet_material_name) ?? `ID: ${sheetMaterialTypeId}`,
        areaMm2: 0,
        detailsCount: 0,
        supplierId: toNullableNumber(detail.supplier_id),
        supplierName: cleanName(detail.supplier_name),
        supplierKey: catalogSupplierKey(detail.supplier_id),
        sources: [],
      };
      current.areaMm2 += areaMm2;
      current.detailsCount += 1;
      current.sources.push(source);
      rows.set(sheetMaterialTypeId, current);
    }

    const filmId = toNullableNumber(detail.film_id);
    if (filmId !== null) {
      const rows = getOrCreate(filmByOrder, orderId, () => new Map());
      const current = rows.get(filmId) ?? {
        filmId,
        name: cleanName(detail.film_name) ?? `ID: ${filmId}`,
        areaMm2: 0,
        detailsCount: 0,
        linearMeters: 0,
        sheets: 0,
        vendorId: toNullableNumber(detail.vendor_id),
        vendorName: cleanName(detail.vendor_name),
        supplierName: null,
        supplierKey: RESOURCE_SUPPLIER_NONE_KEY,
        sources: [],
        cutJobIds: new Set<number>(),
      };
      current.areaMm2 += areaMm2;
      current.detailsCount += 1;
      current.sources.push(source);
      rows.set(filmId, current);
    }
  }

  for (const hdf of input.hdfDetails ?? []) {
    const orderId = toNumber(hdf.order_id);
    const sheetMaterialTypeId = toNullableNumber(hdf.hdf_sheet_material_type_id);
    if (sheetMaterialTypeId === null) continue;
    const areaMm2 = hdfAreaMm2(hdf);
    const rows = getOrCreate(sheetByOrder, orderId, () => new Map());
    const current = rows.get(sheetMaterialTypeId) ?? {
      sheetMaterialTypeId,
      name: cleanName(hdf.hdf_sheet_material_name) ?? `ID: ${sheetMaterialTypeId}`,
      areaMm2: 0,
      detailsCount: 0,
      supplierId: toNullableNumber(hdf.supplier_id),
      supplierName: cleanName(hdf.supplier_name),
      supplierKey: catalogSupplierKey(hdf.supplier_id),
      sources: [],
    };
    current.areaMm2 += areaMm2;
    current.detailsCount += Math.max(0, Math.trunc(positiveNumber(hdf.quantity) ?? 0));
    current.sources.push(hdfSourceRef(hdf));
    rows.set(sheetMaterialTypeId, current);
  }

  const autoSheetsByGroup = new Map<number, ResourceDemandCutSheetRow[]>();
  for (const sheet of input.cutSheets) {
    getOrCreate(autoSheetsByGroup, toNumber(sheet.cut_group_id), () => []).push(sheet);
  }

  for (const group of input.cutGroups) {
    const cutJobId = toNumber(group.cut_job_id);
    const cutGroupId = toNumber(group.cut_group_id);
    const manual = group.manual_is_active === true && group.manual_is_stale !== true;
    const sourceSheets = manual
      ? readManualSheets(group.manual_sheets)
      : (autoSheetsByGroup.get(cutGroupId) ?? []).flatMap((row) => {
          const placements = readPlacements(row.placements);
          return placements ? [{ sheetIndex: toNumber(row.sheet_index), placements }] : [];
        });

    for (const sheet of sourceSheets) {
      if (!shouldShowBathMeterGuides({
        engineUsed: readString(group.summary?.engine_used),
        materialName: group.sheet_material_name,
        materialWidthMm: toNullableNumber(group.sheet_material_width_mm) ?? sheet.placements.sheet_width_mm,
        materialHeightMm: toNullableNumber(group.sheet_material_height_mm) ?? sheet.placements.sheet_height_mm,
      })) {
        continue;
      }
      const usage = calculateBathSheetFilmUsage(sheet.placements);
      if (!usage) continue;
      const orderFilmKeys = new Set<string>();
      for (const piece of sheet.placements.pieces) {
        const detailId = parseFreecutItemId(piece.item_id);
        if (detailId === null || cutJobByDetailId.get(detailId) !== cutJobId) continue;
        const detail = detailById.get(detailId);
        const filmId = toNullableNumber(detail?.film_id);
        if (!detail || filmId === null) continue;
        orderFilmKeys.add(`${toNumber(detail.order_id)}:${filmId}`);
      }

      for (const key of orderFilmKeys) {
        const [orderId, filmId] = key.split(':').map(Number);
        const film = filmByOrder.get(orderId)?.get(filmId);
        if (!film) continue;
        film.linearMeters += usage.linearMeters;
        film.sheets += 1;
        film.cutJobIds.add(cutJobId);
      }
    }
  }

  // Поставщик строки — основной поставщик позиции (правило снабжения), а не производитель.
  if (input.mainSuppliers) {
    for (const rows of sheetByOrder.values()) {
      for (const row of rows.values()) {
        const main = input.mainSuppliers.get(resourceKey('sheet_material', row.sheetMaterialTypeId));
        if (main) Object.assign(row, { supplierName: main.name, supplierKey: main.key });
      }
    }
    for (const rows of filmByOrder.values()) {
      for (const row of rows.values()) {
        const main = input.mainSuppliers.get(resourceKey('film', row.filmId));
        Object.assign(row, { supplierName: main?.name ?? null, supplierKey: main?.key ?? RESOURCE_SUPPLIER_NONE_KEY });
      }
    }
  }
  // Фильтр «Поставщик» оставляет в совместимых полях только материалы выбранных поставщиков.
  const keep = <T extends { supplierKey: string }>(rows: Map<number, T> | undefined): Map<number, T> | undefined => (
    rows && input.supplierKeys
      ? new Map([...rows].filter(([, row]) => input.supplierKeys!.has(row.supplierKey)))
      : rows
  );

  const lines = new Map<number, ProjectedResourceLine[]>();
  const base = input.orders.map<OrderResourceDemandBaseDto>((order) => {
    const orderId = toNumber(order.order_id);
    lines.set(orderId, [
      ...projectSheetLines(sheetByOrder.get(orderId)),
      ...projectFilmLines(filmByOrder.get(orderId)),
    ]);
    return {
      orderId,
      orderName: order.order_name,
      fullNumber: order.full_number,
      orderDate: toDateOnly(order.order_date),
      projectCode: order.project_code,
      clientName: cleanName(order.client_name),
      updatedAt: toIsoString(order.updated_at),
      sheetMaterials: mapSheetRows(keep(sheetByOrder.get(orderId))),
      films: mapFilmRows(keep(filmByOrder.get(orderId))),
    };
  });
  return { base, lines };
}

function projectSheetLines(rows: Map<number, SheetAccumulator> | undefined): ProjectedResourceLine[] {
  return [...(rows?.values() ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.sheetMaterialTypeId - right.sheetMaterialTypeId)
    .map((row) => {
      const quantity = roundAreaMm2(row.areaMm2);
      return {
        resourceKey: resourceKey('sheet_material', row.sheetMaterialTypeId),
        kind: 'sheet_material',
        refId: row.sheetMaterialTypeId,
        name: row.name,
        supplierName: row.supplierName,
        supplierRole: 'supplier',
        supplierKey: row.supplierKey,
        quantity,
        unit: 'm2',
        areaM2: quantity,
        detailsCount: row.detailsCount,
        source: 'area',
        demandFingerprint: demandFingerprint({
          kind: 'sheet_material',
          refId: row.sheetMaterialTypeId,
          quantity,
          source: 'area',
          detailsCount: row.detailsCount,
          sources: row.sources.map((source) => source.fingerprintKey),
          cutJobIds: [],
        }),
        details: row.sources.map((source) => source.ref),
      };
    });
}

function projectFilmLines(rows: Map<number, FilmAccumulator> | undefined): ProjectedResourceLine[] {
  return [...(rows?.values() ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.filmId - right.filmId)
    .map((row) => {
      const hasCut = row.linearMeters > 0;
      const quantity = hasCut ? roundTo1(row.linearMeters) : null;
      const source: OrderResourceSource = hasCut ? 'cut' : 'none';
      return {
        resourceKey: resourceKey('film', row.filmId),
        kind: 'film',
        refId: row.filmId,
        name: row.name,
        supplierName: row.supplierName,
        supplierRole: 'supplier',
        supplierKey: row.supplierKey,
        quantity,
        unit: 'lm',
        areaM2: roundAreaMm2(row.areaMm2),
        detailsCount: row.detailsCount,
        source,
        demandFingerprint: demandFingerprint({
          kind: 'film',
          refId: row.filmId,
          quantity,
          source,
          detailsCount: row.detailsCount,
          sources: row.sources.map((ref) => ref.fingerprintKey),
          cutJobIds: [...row.cutJobIds],
        }),
        details: row.sources.map((ref) => ref.ref),
      };
    });
}

interface FingerprintInput {
  kind: OrderResourceKind;
  refId: number;
  quantity: number | null;
  source: OrderResourceSource;
  detailsCount: number;
  sources: string[];
  cutJobIds: number[];
}

/** SHA-256 отпечаток вычисленной потребности: количество, состав деталей и раскрой (R1-4). */
export function demandFingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify([
    'order-resource-demand/v1',
    input.kind,
    input.refId,
    input.quantity,
    input.source,
    input.detailsCount,
    [...input.sources].sort(),
    [...input.cutJobIds].sort((left, right) => left - right),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export function emptyDemandFingerprint(kind: OrderResourceKind, refId: number): string {
  return demandFingerprint({ kind, refId, quantity: 0, source: 'none', detailsCount: 0, sources: [], cutJobIds: [] });
}

function detailSourceRef(detail: ResourceDemandDetailRow): LineSourceRef {
  const id = toNumber(detail.detail_id);
  return {
    ref: {
      source: 'detail',
      id,
      detailNumber: toNullableNumber(detail.detail_number),
      name: cleanName(detail.detail_name),
      heightMm: toNullableNumber(detail.height),
      widthMm: toNullableNumber(detail.width),
      quantity: toNullableNumber(detail.quantity),
    },
    fingerprintKey: `d:${id}:${timestampKey(detail.updated_at)}`,
  };
}

function hdfSourceRef(hdf: ResourceDemandHdfRow): LineSourceRef {
  const id = toNumber(hdf.order_hdf_detail_id);
  return {
    ref: {
      source: 'hdf',
      id,
      detailNumber: toNullableNumber(hdf.source_detail_number),
      name: cleanName(hdf.source_detail_name),
      heightMm: toNullableNumber(hdf.hdf_height_mm),
      widthMm: toNullableNumber(hdf.hdf_width_mm),
      quantity: toNullableNumber(hdf.quantity),
    },
    fingerprintKey: `h:${id}:${timestampKey(hdf.updated_at)}`,
  };
}

function timestampKey(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function hasResourceFilters(query: OrderResourceDemandQuery): boolean {
  return query.sheetMaterialTypeId !== undefined
    || query.filmId !== undefined
    || query.supplierId !== undefined
    || query.vendorId !== undefined;
}

function detailMatchesResourceFilters(
  row: Pick<ResourceDemandDetailRow, 'sheet_material_type_id' | 'film_id' | 'supplier_id' | 'vendor_id'>,
  query: OrderResourceDemandQuery): boolean {
  return (query.sheetMaterialTypeId === undefined || toNullableNumber(row.sheet_material_type_id) === query.sheetMaterialTypeId)
    && (query.filmId === undefined || toNullableNumber(row.film_id) === query.filmId)
    && (query.supplierId === undefined || toNullableNumber(row.supplier_id) === query.supplierId)
    && (query.vendorId === undefined || toNullableNumber(row.vendor_id) === query.vendorId);
}

function hdfMatchesResourceFilters(
  row: Pick<ResourceDemandHdfRow, 'hdf_sheet_material_type_id' | 'supplier_id'>,
  query: OrderResourceDemandQuery): boolean {
  if (query.filmId !== undefined || query.vendorId !== undefined) return false;
  return (query.sheetMaterialTypeId === undefined || toNullableNumber(row.hdf_sheet_material_type_id) === query.sheetMaterialTypeId)
    && (query.supplierId === undefined || toNullableNumber(row.supplier_id) === query.supplierId);
}

/**
 * Все функции фазы 2 включаются одним флагом: при откате флагом интерфейс
 * возвращается ровно к фазе 1 (план §9).
 */
export function capabilities(options: OrderResourceReadOptions): OrderResourceCapabilitiesDto {
  return {
    procurement: options.procurementEnabled,
    byMaterial: options.procurementEnabled,
    cardDetails: options.procurementEnabled,
    onecDocuments: options.procurementEnabled,
    supplyWorkspace: options.procurementEnabled && options.supplyWorkspaceEnabled === true,
    serverFilters: true,
    serverSort: true,
  };
}

export function orderNotFound(): ApiError {
  return new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
}

function mapSheetRows(rows: Map<number, SheetAccumulator> | undefined): OrderSheetMaterialDemandDto[] {
  return [...(rows?.values() ?? [])]
    .map((row) => ({
      sheetMaterialTypeId: row.sheetMaterialTypeId,
      name: row.name,
      totalArea: roundAreaMm2(row.areaMm2),
      detailsCount: row.detailsCount,
      supplierId: row.supplierId,
      supplierName: row.supplierName,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.sheetMaterialTypeId - right.sheetMaterialTypeId);
}

function mapFilmRows(rows: Map<number, FilmAccumulator> | undefined): OrderFilmDemandDto[] {
  return [...(rows?.values() ?? [])]
    .map((row) => ({
      filmId: row.filmId,
      name: row.name,
      totalArea: roundAreaMm2(row.areaMm2),
      detailsCount: row.detailsCount,
      linearMeters: roundTo1(row.linearMeters),
      sheets: row.sheets,
      hasCutData: row.linearMeters > 0,
      vendorId: row.vendorId,
      vendorName: row.vendorName,
      supplierName: row.supplierName,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.filmId - right.filmId);
}

/**
 * Заказ, доступный пользователю: не в корзине, производственный, в scope
 * `orders.view` его роли. Используется чтениями и командами закупа (R1-1).
 */
export function buildScopedOrderWhere(
  currentUser: CurrentUser,
  orderId?: number,
  params: unknown[] = [],
): { whereSql: string; params: unknown[] } {
  // Runtime-настроенный scope пользователя важнее статической политики роли.
  const scope = policyScopeSetsForUser(currentUser).orders.view;
  const actorIndex = scopeNeedsActor(scope)
    ? params.push(normalizeActorUserId(currentUser.id))
    : null;
  const clauses = [
    'o.delete_flag = false',
    "o.order_kind = 'production_order'",
    buildScopePredicate(scope, actorIndex),
  ];
  if (orderId !== undefined) clauses.push(`o.order_id = $${params.push(orderId)}`);
  return { whereSql: clauses.join('\n        AND '), params };
}

/**
 * Scope пользователя без фильтра активности: заказ в корзине по-прежнему «свой» или «чужой». Для проверки
 * полномочий над связями, которые переживают удаление заказа (заявки поставщикам, CR3-1), — не для чтения данных.
 */
export function buildOwnershipOrderWhere(currentUser: CurrentUser, params: unknown[] = []): { whereSql: string; params: unknown[] } {
  const scope = policyScopeSetsForUser(currentUser).orders.view;
  const actorIndex = scopeNeedsActor(scope) ? params.push(normalizeActorUserId(currentUser.id)) : null;
  return { whereSql: [`o.order_kind = 'production_order'`, buildScopePredicate(scope, actorIndex)].join('\n        AND '), params };
}

function buildOrderWhere(
  command: ListOrderResourceDemandsCommand,
  options: OrderResourceReadOptions,
  supplierResources: SupplierResourceSets | undefined,
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses = [buildScopedOrderWhere(command.currentUser, undefined, params).whereSql];

  if (command.query.search) {
    const searchIndex = params.push(`%${command.query.search}%`);
    clauses.push(`(
      o.order_name ILIKE $${searchIndex}
      OR (p.code || '-' || o.order_name) ILIKE $${searchIndex}
      OR p.code ILIKE $${searchIndex}
      OR c.client_name ILIKE $${searchIndex}
    )`);
  }
  if (command.query.dateFrom) {
    clauses.push(`o.order_date >= $${params.push(command.query.dateFrom)}::date`);
  }
  if (command.query.dateTo) {
    clauses.push(`o.order_date <= $${params.push(command.query.dateTo)}::date`);
  }

  const resourceFilters = buildResourceFilters(command.query, params, 'od_filter', 'smt_filter', 'film_filter');
  if (resourceFilters.length > 0) {
    const hdfResourceFilters = buildHdfResourceFilters(command.query, params, 'hdf_filter', 'hdf_smt_filter');
    clauses.push(`(
      EXISTS (
        SELECT 1
        FROM order_details od_filter
        LEFT JOIN sheet_material_types smt_filter
          ON smt_filter.sheet_material_type_id = od_filter.sheet_material_type_id
        LEFT JOIN films film_filter ON film_filter.film_id = od_filter.film_id
        WHERE od_filter.order_id = o.order_id
          AND od_filter.delete_flag = false
          AND ${resourceFilters.join('\n          AND ')}
      )
      OR EXISTS (
        SELECT 1
        FROM order_hdf_details hdf_filter
        JOIN hdf_calculation_config_state hdf_state_filter ON hdf_state_filter.id = 1
        LEFT JOIN sheet_material_types hdf_smt_filter
          ON hdf_smt_filter.sheet_material_type_id = hdf_filter.hdf_sheet_material_type_id
        WHERE hdf_filter.order_id = o.order_id
          AND hdf_filter.delete_flag = false
          AND hdf_filter.status = 'ok'
          AND hdf_filter.config_revision = hdf_state_filter.revision
          AND ${hdfResourceFilters.join('\n          AND ')}
      )
    )`);
  }

  if (command.query.unpurchasedOnly) {
    clauses.push(buildUnpurchasedPredicate(options.procurementEnabled));
  }
  if (command.query.onecDocumentId !== undefined) {
    // Без флага таблицы документов 1С не читаются — и распределений быть не может.
    clauses.push(options.procurementEnabled
      ? `EXISTS (
          SELECT 1
            FROM order_resource_procurement orp_d
            JOIN order_resource_onec_allocations a_d
              ON a_d.order_resource_procurement_id = orp_d.order_resource_procurement_id
             AND a_d.removed_at IS NULL
            JOIN onec_document_lines l_d ON l_d.onec_document_line_id = a_d.onec_document_line_id
           WHERE orp_d.order_id = o.order_id
             AND l_d.onec_document_id = $${params.push(command.query.onecDocumentId)}
        )`
      : 'FALSE');
  }

  const query = command.query;
  if (query.orderIds) {
    clauses.push(`o.order_id = ANY($${params.push(query.orderIds)}::bigint[])`);
  }
  if (query.orderDates) {
    const { values, exclude, includeEmpty } = query.orderDates;
    clauses.push(valueOrEmpty(
      exclude
        ? `o.order_date <> ALL($${params.push(values)}::date[])`
        : values.length > 0 ? `o.order_date = ANY($${params.push(values)}::date[])` : null,
      includeEmpty ? 'o.order_date IS NULL' : null,
    ));
  }
  if (query.sheetMaterialTypeIds) {
    const { values, exclude, includeEmpty } = query.sheetMaterialTypeIds;
    clauses.push(valueOrEmpty(
      exclude || values.length > 0 ? orderHasSheetSql({ idsSql: `$${params.push(values)}::bigint[]`, exclude: exclude === true }) : null,
      includeEmpty ? `o.order_id NOT IN ${sheetOrdersSql(null)}` : null,
    ));
  }
  if (query.filmIds) {
    const { values, exclude, includeEmpty } = query.filmIds;
    clauses.push(valueOrEmpty(
      exclude || values.length > 0 ? orderHasFilmSql({ idsSql: `$${params.push(values)}::bigint[]`, exclude: exclude === true }) : null,
      includeEmpty ? `o.order_id NOT IN ${filmOrdersSql(null)}` : null,
    ));
  }
  if (supplierResources) {
    const sheetSql = supplierResources.sheetIds.length > 0
      ? orderHasSheetSql({ idsSql: `$${params.push(supplierResources.sheetIds)}::bigint[]`, exclude: false })
      : null;
    const filmSql = supplierResources.filmIds.length > 0
      ? orderHasFilmSql({ idsSql: `$${params.push(supplierResources.filmIds)}::bigint[]`, exclude: false })
      : null;
    clauses.push(valueOrEmpty(sheetSql, filmSql));
  }
  if (query.readyCutsOnly) {
    clauses.push(READY_FILM_CUT_SQL);
  }
  if (query.payment === 'any_paid') {
    clauses.push(`o.payment_status_id IN (${STANDARD_PAYMENT_STATUS_IDS.PARTIALLY_PAID}, ${STANDARD_PAYMENT_STATUS_IDS.PAID})`);
  } else if (query.payment === 'fully_paid') {
    clauses.push(`o.payment_status_id = ${STANDARD_PAYMENT_STATUS_IDS.PAID}`);
  }

  return { whereSql: clauses.join('\n        AND '), params };
}

const DEFAULT_ORDER_BY_SQL = 'o.order_date DESC NULLS LAST, o.order_id DESC';

/**
 * Страница списка с сортировкой по всем страницам (до LIMIT/OFFSET). По умолчанию — дата заказа, новые сверху; по
 * дате — в SQL. Номер заказа и материалы сортируются здесь тем же сравнением, что у клиента (`ru`, числа по
 * значению, без учёта регистра), по тем же текстам, что видны в строке: номер — `orderName` (или `#id`), материалы —
 * отсортированные имена через пробел с теми же правилами имени и сужения (legacy-фильтры, «Поставщик»), что у
 * проекции. Пустые значения — в конце при любом направлении; при равных — порядок по умолчанию.
 */
async function loadOrderPage(
  client: DatabaseClient,
  query: OrderResourceDemandQuery,
  whereSql: string,
  params: unknown[],
  supplierResources: SupplierResourceSets | undefined,
): Promise<{ rows: ResourceDemandOrderRow[] }> {
  const offset = (query.page - 1) * query.pageSize;
  const sort = query.sort;
  if (!sort || sort.key === 'date') {
    const orderBySql = sort
      ? `o.order_date ${sort.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, o.order_id DESC`
      : DEFAULT_ORDER_BY_SQL;
    const pageParams = [...params];
    const pageSizeIndex = pageParams.push(query.pageSize);
    const offsetIndex = pageParams.push(offset);
    return client.query<ResourceDemandOrderRow>(
      `${ORDER_SELECT_SQL}
      WHERE ${whereSql}
      ORDER BY ${orderBySql}
      LIMIT $${pageSizeIndex} OFFSET $${offsetIndex}
      `,
      pageParams,
    );
  }

  const candidates = await client.query<{ order_id: string; order_name: string | null; order_date: string | Date | null }>(
    `SELECT o.order_id, o.order_name, o.order_date
      FROM orders o
      JOIN projects p ON p.project_id = o.project_id
      LEFT JOIN clients c ON c.client_id = o.client_id
      WHERE ${whereSql}`,
    params,
  );
  const orderIds = candidates.rows.map((row) => toNumber(row.order_id));
  const keys = sort.key === 'order'
    ? new Map(candidates.rows.map((row) => [toNumber(row.order_id), row.order_name?.trim() || `#${toNumber(row.order_id)}`]))
    : await loadMaterialSortKeys(client, sort.key, orderIds, query, supplierResources);
  const pageIds = sortOrderIds(candidates.rows.map((row) => ({
    orderId: toNumber(row.order_id),
    orderDate: toDateOnly(row.order_date),
    key: keys.get(toNumber(row.order_id)) ?? '',
  })), sort.direction).slice(offset, offset + query.pageSize);
  if (pageIds.length === 0) return { rows: [] };
  const page = await client.query<ResourceDemandOrderRow>(
    `${ORDER_SELECT_SQL}
      WHERE o.order_id = ANY($1::bigint[])`,
    [pageIds],
  );
  const position = new Map(pageIds.map((orderId, index) => [orderId, index]));
  return { rows: [...page.rows].sort((left, right) => position.get(toNumber(left.order_id))! - position.get(toNumber(right.order_id))!) };
}

const SORT_COLLATOR = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

/** Порядок заказов по ключу: пустой ключ — в конце при любом направлении; равные — дата (новые сверху), затем id. */
export function sortOrderIds(
  rows: Array<{ orderId: number; orderDate: string | null; key: string }>,
  direction: 'asc' | 'desc',
): number[] {
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => {
    if (!left.key !== !right.key) return left.key ? -1 : 1;
    const byKey = left.key && right.key ? sign * SORT_COLLATOR.compare(left.key, right.key) : 0;
    if (byKey !== 0) return byKey;
    if (left.orderDate !== right.orderDate) {
      if (left.orderDate === null) return 1;
      if (right.orderDate === null) return -1;
      return left.orderDate < right.orderDate ? 1 : -1;
    }
    return right.orderId - left.orderId;
  }).map((row) => row.orderId);
}

/** Текст колонки материалов: имена по возрастанию через пробел (как сортирует клиент). */
export function materialSortKey(names: Iterable<string>): string {
  return [...names].sort((left, right) => SORT_COLLATOR.compare(left, right)).join(' ');
}

/**
 * Ключи колонок «Листовые материалы» / «Плёнка» для заказов выборки — по правилам `projectOrders`: материал по id,
 * имя — из первой детали (справочник), иначе из первой HDF-позиции текущей ревизии; legacy-фильтры отбирают детали и
 * HDF-позиции целиком; фильтр «Поставщик» оставляет материалы выбранных поставщиков.
 */
async function loadMaterialSortKeys(
  client: DatabaseClient,
  kind: 'sheetMaterials' | 'films',
  orderIds: number[],
  query: OrderResourceDemandQuery,
  supplierResources: SupplierResourceSets | undefined,
): Promise<Map<number, string>> {
  if (orderIds.length === 0) return new Map();
  const legacy = hasResourceFilters(query);
  const kept = supplierResources
    ? new Set(kind === 'sheetMaterials' ? supplierResources.sheetIds : supplierResources.filmIds)
    : null;
  const names = new Map<number, Map<number, string>>();
  const add = (orderId: number, resourceId: number | null, name: string | null) => {
    if (resourceId === null || (kept && !kept.has(resourceId))) return;
    const rows = getOrCreate(names, orderId, () => new Map<number, string>());
    if (!rows.has(resourceId)) rows.set(resourceId, name ?? `ID: ${resourceId}`);
  };
  // Сочетания «лист × плёнка» деталей заказа: legacy-фильтры зависят только от них (поставщик листа, производитель плёнки).
  const details = await client.query<Pick<ResourceDemandDetailRow,
    'order_id' | 'sheet_material_type_id' | 'sheet_material_name' | 'supplier_id' | 'film_id' | 'film_name' | 'vendor_id'> & QueryResultRow>(
    `SELECT DISTINCT od.order_id, od.sheet_material_type_id, smt.name AS sheet_material_name, smt.supplier_id,
            od.film_id, f.film_name, f.vendor_id
       FROM order_details od
       LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
       LEFT JOIN films f ON f.film_id = od.film_id
      WHERE od.order_id = ANY($1::bigint[])
        AND od.delete_flag = false
        AND od.${kind === 'sheetMaterials' ? 'sheet_material_type_id' : 'film_id'} IS NOT NULL`,
    [orderIds],
  );
  for (const row of details.rows) {
    if (legacy && !detailMatchesResourceFilters(row, query)) continue;
    if (kind === 'sheetMaterials') add(toNumber(row.order_id), toNullableNumber(row.sheet_material_type_id), cleanName(row.sheet_material_name));
    else add(toNumber(row.order_id), toNullableNumber(row.film_id), cleanName(row.film_name));
  }
  if (kind === 'sheetMaterials') {
    const hdf = await client.query<Pick<ResourceDemandHdfRow, 'order_id' | 'hdf_sheet_material_type_id' | 'hdf_sheet_material_name' | 'supplier_id'> & QueryResultRow>(
      `SELECT DISTINCT ON (hdf.order_id, hdf.hdf_sheet_material_type_id)
              hdf.order_id, hdf.hdf_sheet_material_type_id, hdf.hdf_sheet_material_name, hdf_smt.supplier_id
         FROM order_hdf_details hdf
         JOIN hdf_calculation_config_state hdf_state ON hdf_state.id = 1
         LEFT JOIN sheet_material_types hdf_smt ON hdf_smt.sheet_material_type_id = hdf.hdf_sheet_material_type_id
        WHERE hdf.order_id = ANY($1::bigint[])
          AND hdf.delete_flag = false
          AND hdf.status = 'ok'
          AND hdf.config_revision = hdf_state.revision
          AND hdf.hdf_sheet_material_type_id IS NOT NULL
        ORDER BY hdf.order_id, hdf.hdf_sheet_material_type_id, hdf.source_detail_number, hdf.order_hdf_detail_id`,
      [orderIds],
    );
    for (const row of hdf.rows) {
      if (legacy && !hdfMatchesResourceFilters(row, query)) continue;
      add(toNumber(row.order_id), toNullableNumber(row.hdf_sheet_material_type_id), cleanName(row.hdf_sheet_material_name));
    }
  }
  return new Map([...names].map(([orderId, rows]) => [orderId, materialSortKey(rows.values())]));
}

/** OR двух условий фильтра заголовка (значения / «без значения»); ни одного — заказов нет. */
function valueOrEmpty(values: string | null, empty: string | null): string {
  const parts = [values, empty].filter((part): part is string => part !== null);
  if (parts.length === 0) return 'FALSE';
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

/**
 * Заказы с листовым материалом (из массива `idsSql` или любым при null): деталь или HDF-позиция текущей ревизии
 * расчёта — те же источники, что у строк потребности. Некоррелированный подзапрос — один проход по деталям.
 */
function sheetOrdersSql(ids: ResourceIdsSql | null): string {
  const match = (column: string) => matchIdsSql(column, ids);
  return `(
        SELECT od_sh.order_id FROM order_details od_sh
         WHERE od_sh.delete_flag = false
           AND ${match('od_sh.sheet_material_type_id')}
        UNION
        SELECT hdf_sh.order_id FROM order_hdf_details hdf_sh
          JOIN hdf_calculation_config_state hdf_state_sh ON hdf_state_sh.id = 1
         WHERE hdf_sh.delete_flag = false
           AND hdf_sh.status = 'ok'
           AND hdf_sh.config_revision = hdf_state_sh.revision
           AND ${match('hdf_sh.hdf_sheet_material_type_id')}
      )`;
}

/** Заказы с плёнкой (из массива `idsSql` или любой при null) у активной детали. */
function filmOrdersSql(ids: ResourceIdsSql | null): string {
  return `(
        SELECT od_fm.order_id FROM order_details od_fm
         WHERE od_fm.delete_flag = false
           AND ${matchIdsSql('od_fm.film_id', ids)}
      )`;
}

/** Массив id параметром; `exclude` — «любой, кроме этих». */
interface ResourceIdsSql {
  idsSql: string;
  exclude: boolean;
}

function matchIdsSql(column: string, ids: ResourceIdsSql | null): string {
  if (ids === null) return `${column} IS NOT NULL`;
  return ids.exclude ? `${column} IS NOT NULL AND ${column} <> ALL(${ids.idsSql})` : `${column} = ANY(${ids.idsSql})`;
}

function orderHasSheetSql(ids: ResourceIdsSql): string {
  return `o.order_id IN ${sheetOrdersSql(ids)}`;
}

function orderHasFilmSql(ids: ResourceIdsSql): string {
  return `o.order_id IN ${filmOrdersSql(ids)}`;
}

/** Число из JSON (число или строка с числом), иначе NULL — как mmOrNaN раскроя. */
function jsonMmSql(path: string): string {
  return `(CASE
          WHEN jsonb_typeof(${path}) = 'number' THEN (${path})::numeric
          WHEN jsonb_typeof(${path}) = 'string' AND (${path} #>> '{}') ~ '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$' THEN btrim(${path} #>> '{}')::numeric
        END)`;
}

/**
 * «Готовые раскрои»: у заказа есть плёнка с посчитанными метрами — то же правило, что у `projectOrders`
 * (`hasCutData`): деталь с плёнкой в своём последнем активном готовом раскрое лежит на листе группы вакуумного
 * стола из материала «Ванна…» с длинной стороной 2800 мм (ручная раскладка, если активна и не устарела, иначе
 * автоматическая), и сам лист — 2800 мм по длинной стороне. Считается одним проходом от листов ванны к деталям.
 */
const READY_FILM_CUT_SQL = `o.order_id IN (
        WITH bath_sheets_rc AS MATERIALIZED (
          SELECT cg_rc.cut_job_id, sheet_rc.placements
            FROM cut_group cg_rc
            JOIN cut_job cj_rc ON cj_rc.cut_job_id = cg_rc.cut_job_id AND cj_rc.status = 'ready'
            LEFT JOIN sheet_material_types smt_rc ON smt_rc.sheet_material_type_id = cg_rc.sheet_material_type_id
            LEFT JOIN cut_group_manual_layout man_rc
              ON man_rc.cut_job_id = cg_rc.cut_job_id
             AND man_rc.group_key = cg_rc.group_key
            CROSS JOIN LATERAL (
              SELECT sheet_all.placements,
                     ${jsonMmSql("sheet_all.placements -> 'sheet_width_mm'")} AS width_mm,
                     ${jsonMmSql("sheet_all.placements -> 'sheet_height_mm'")} AS height_mm
                FROM (
                  SELECT manual_sheet.value -> 'placements' AS placements
                    FROM jsonb_array_elements(
                      CASE WHEN man_rc.is_active = true AND man_rc.is_stale IS NOT TRUE AND jsonb_typeof(man_rc.sheets) = 'array'
                           THEN man_rc.sheets ELSE '[]'::jsonb END
                    ) manual_sheet
                  UNION ALL
                  SELECT cgs_rc.placements
                    FROM cut_group_sheet cgs_rc
                   WHERE cgs_rc.cut_group_id = cg_rc.cut_group_id
                     AND NOT (man_rc.is_active IS TRUE AND man_rc.is_stale IS NOT TRUE)
                ) sheet_all
            ) sheet_rc
           WHERE cg_rc.summary ->> 'engine_used' = 'vacuum_table'
             AND lower(regexp_replace(normalize(smt_rc.name, NFKC), '^\\s+', '')) LIKE 'ванна%'
             AND GREATEST(COALESCE(smt_rc.width_mm, sheet_rc.width_mm), COALESCE(smt_rc.height_mm, sheet_rc.height_mm))
                 = ${BATH_METER_GUIDE_SHEET_HEIGHT_MM}
             AND sheet_rc.width_mm > 0
             AND sheet_rc.height_mm > 0
             AND GREATEST(sheet_rc.width_mm, sheet_rc.height_mm) = ${BATH_METER_GUIDE_SHEET_HEIGHT_MM}
             AND jsonb_typeof(sheet_rc.placements -> 'pieces') = 'array'
             -- calculateBathSheetFilmUsage: the pieces occupy a positive length along the long side
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(sheet_rc.placements -> 'pieces') occupied_rc
                WHERE CASE WHEN sheet_rc.width_mm > sheet_rc.height_mm
                           THEN COALESCE(${jsonMmSql("sheet_rc.placements -> 'trim_mm' -> 'left'")}, 0)
                                + COALESCE(${jsonMmSql("occupied_rc.value -> 'x_mm'")}, 0)
                                + COALESCE(${jsonMmSql("occupied_rc.value -> 'width_mm'")}, 0)
                           ELSE COALESCE(${jsonMmSql("sheet_rc.placements -> 'trim_mm' -> 'top'")}, 0)
                                + COALESCE(${jsonMmSql("occupied_rc.value -> 'y_mm'")}, 0)
                                + COALESCE(${jsonMmSql("occupied_rc.value -> 'height_mm'")}, 0)
                      END > 0
             )
        ),
        bath_pieces_rc AS MATERIALIZED (
          -- «det-<detail id>» (parseFreecutItemId) without a regex: a regex per piece costs seconds here
          SELECT DISTINCT
                 bs_rc.cut_job_id,
                 CASE WHEN left(item_rc, 4) = 'det-' AND length(item_rc) BETWEEN 5 AND 22
                           AND translate(substr(item_rc, 5), '0123456789', '') = ''
                      THEN substr(item_rc, 5)::bigint END AS detail_id
            FROM bath_sheets_rc bs_rc
            CROSS JOIN LATERAL jsonb_array_elements_text(jsonb_path_query_array(bs_rc.placements, '$.pieces[*].item_id')) item_rc
        )
        SELECT od_rc.order_id
          FROM bath_pieces_rc bp_rc
          JOIN order_details od_rc
            ON od_rc.detail_id = bp_rc.detail_id
           AND od_rc.delete_flag = false
           AND od_rc.film_id IS NOT NULL
         -- the group's job is the detail's latest active ready cut job
         WHERE bp_rc.cut_job_id = (
           SELECT max(cj_last.cut_job_id)
             FROM cut_job_item cji_last
             JOIN cut_job cj_last ON cj_last.cut_job_id = cji_last.cut_job_id
            WHERE cji_last.order_detail_id = od_rc.detail_id
              AND cji_last.is_active = true
              AND cj_last.status = 'ready'
         )
      )`;

/**
 * Заказ, у которого есть хоть один материал без отметки «Закуплено».
 * Без флага закупа отметок нет — подходит любой заказ с потребностью.
 */
function buildUnpurchasedPredicate(procurementEnabled: boolean): string {
  const notPurchased = (kind: OrderResourceKind, column: string, value: string) => (procurementEnabled
    ? `NOT EXISTS (
            SELECT 1 FROM order_resource_procurement orp_u
            WHERE orp_u.order_id = o.order_id
              AND orp_u.resource_kind = '${kind}'
              AND orp_u.${column} = ${value}
              AND orp_u.purchased = true
          )`
    : 'TRUE');
  return `(
      EXISTS (
        SELECT 1 FROM order_details od_u
        WHERE od_u.order_id = o.order_id
          AND od_u.delete_flag = false
          AND (
            (od_u.sheet_material_type_id IS NOT NULL AND ${notPurchased('sheet_material', 'sheet_material_type_id', 'od_u.sheet_material_type_id')})
            OR (od_u.film_id IS NOT NULL AND ${notPurchased('film', 'film_id', 'od_u.film_id')})
          )
      )
      OR EXISTS (
        SELECT 1 FROM order_hdf_details hdf_u
        JOIN hdf_calculation_config_state hdf_state_u ON hdf_state_u.id = 1
        WHERE hdf_u.order_id = o.order_id
          AND hdf_u.delete_flag = false
          AND hdf_u.status = 'ok'
          AND hdf_u.config_revision = hdf_state_u.revision
          AND hdf_u.hdf_sheet_material_type_id IS NOT NULL
          AND ${notPurchased('sheet_material', 'sheet_material_type_id', 'hdf_u.hdf_sheet_material_type_id')}
      )
    )`;
}

function buildHdfResourceFilters(
  query: OrderResourceDemandQuery,
  params: unknown[],
  hdfAlias: string,
  sheetAlias: string,
): string[] {
  const filters: string[] = [];
  if (query.sheetMaterialTypeId !== undefined) {
    filters.push(`${hdfAlias}.hdf_sheet_material_type_id = $${params.push(query.sheetMaterialTypeId)}`);
  }
  if (query.supplierId !== undefined) {
    filters.push(`${sheetAlias}.supplier_id = $${params.push(query.supplierId)}`);
  }
  if (query.filmId !== undefined || query.vendorId !== undefined) {
    filters.push('FALSE');
  }
  return filters.length > 0 ? filters : ['TRUE'];
}

function buildResourceFilters(
  query: OrderResourceDemandQuery,
  params: unknown[],
  detailAlias: string,
  sheetAlias: string,
  filmAlias: string,
): string[] {
  const filters: string[] = [];
  if (query.sheetMaterialTypeId !== undefined) {
    filters.push(`${detailAlias}.sheet_material_type_id = $${params.push(query.sheetMaterialTypeId)}`);
  }
  if (query.filmId !== undefined) {
    filters.push(`${detailAlias}.film_id = $${params.push(query.filmId)}`);
  }
  if (query.supplierId !== undefined) {
    filters.push(`${sheetAlias}.supplier_id = $${params.push(query.supplierId)}`);
  }
  if (query.vendorId !== undefined) {
    filters.push(`${filmAlias}.vendor_id = $${params.push(query.vendorId)}`);
  }
  return filters;
}

/** Scope set (access groups stage 0A): `all` → TRUE; own ∪ assigned → OR of both; empty → FALSE. */
function buildScopePredicate(scope: readonly ScopeGrant[], actorIndex: number | null): string {
  if (scope.includes('all')) return 'TRUE';
  if (actorIndex === null) return 'FALSE';
  const parts: string[] = [];
  if (scope.includes('own')) parts.push(`(o.created_by = $${actorIndex} OR o.manager_id = $${actorIndex})`);
  if (scope.includes('assigned')) {
    parts.push(`EXISTS (
    SELECT 1
    FROM order_workshops assigned_ow
    JOIN users assigned_user
      ON assigned_user.employee_id = assigned_ow.responsible_employee_id
    WHERE assigned_ow.order_id = o.order_id
      AND assigned_ow.delete_flag = false
      AND assigned_user.is_active = true
      AND assigned_user.user_id = $${actorIndex}
  )`);
  }
  if (parts.length === 0) return 'FALSE';
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

function scopeNeedsActor(scope: readonly ScopeGrant[]): boolean {
  return !scope.includes('all') && (scope.includes('own') || scope.includes('assigned'));
}

function response(
  query: OrderResourceDemandQuery,
  total: number,
  data: OrderResourceDemandDto[],
  options: OrderResourceReadOptions,
): OrderResourceDemandResponseDto {
  return {
    capabilities: capabilities(options),
    data,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
    refreshedAt: new Date().toISOString(),
  };
}

function readManualSheets(value: unknown): Array<{ sheetIndex: number; placements: SheetPlacementsJson }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const candidate = row as { sheetIndex?: unknown; placements?: unknown };
    const placements = readPlacements(candidate.placements);
    if (!placements) return [];
    return [{ sheetIndex: toNumber(candidate.sheetIndex), placements }];
  });
}

function readPlacements(value: unknown): SheetPlacementsJson | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SheetPlacementsJson>;
  if (!Array.isArray(candidate.pieces)) return null;
  return candidate as SheetPlacementsJson;
}

function detailAreaMm2(detail: ResourceDemandDetailRow): number {
  const height = positiveNumber(detail.height);
  const width = positiveNumber(detail.width);
  const quantity = positiveNumber(detail.quantity);
  return height === null || width === null || quantity === null ? 0 : height * width * quantity;
}

function hdfAreaMm2(detail: ResourceDemandHdfRow): number {
  const height = positiveNumber(detail.hdf_height_mm);
  const width = positiveNumber(detail.hdf_width_mm);
  const quantity = positiveNumber(detail.quantity);
  return height === null || width === null || quantity === null ? 0 : height * width * quantity;
}

function roundAreaMm2(value: number): number {
  const hundredthsM2 = value / 10_000;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(hundredthsM2));
  return Math.round(hundredthsM2 + tolerance) / 100;
}

function roundTo1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = factory();
  map.set(key, value);
  return value;
}

/** Ключ поставщика из справочника листового (основной `supplier_id`), без него — `none`. */
function catalogSupplierKey(supplierId: unknown): string {
  const id = toNullableNumber(supplierId);
  return id === null ? RESOURCE_SUPPLIER_NONE_KEY : `s:${id}`;
}

function uniqueNumbers(values: unknown[]): number[] {
  return [...new Set(values.map(toNumber).filter((value) => value > 0))];
}

function normalizeActorUserId(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : -1;
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function toNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toDateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
