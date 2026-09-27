import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { Scope } from '../../../permissions/policies/role-policies';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  calculateBathSheetFilmUsage,
  shouldShowBathMeterGuides,
} from '../../../shared/cut-geometry';
import {
  parseFreecutItemId,
  type SheetPlacementsJson,
} from '../../cut/application/cut-freecut-mapping';
import {
  RESOURCE_BY_MATERIAL_ORDER_LIMIT,
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
}

export type OrderResourceDemandBaseDto = Omit<OrderResourceDemandDto, 'lines' | 'procurementSummary'>;

/** Строка потребности до наложения закупа: количество, источники и отпечаток. */
export interface ProjectedResourceLine {
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
  supplierName: string | null;
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
      const lines = applyProcurement(order.lines, procurement.filter((row) => toNumber(row.order_id) === order.orderId));
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
      const { whereSql, params } = buildOrderWhere(command, options);
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
        data: aggregateByMaterial(projected, procurement),
        ordersCount: projected.length,
        refreshedAt: new Date().toISOString(),
        capabilities: capabilities(options),
      };
    });
  }

  private async listInSnapshot(
    client: DatabaseClient,
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceDemandResponseDto> {
    const { whereSql, params } = buildOrderWhere(command, options);
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
    const pageParams = [...params, command.query.pageSize, (command.query.page - 1) * command.query.pageSize];
    const pageSizeIndex = pageParams.length - 1;
    const offsetIndex = pageParams.length;
    const orderResult = await client.query<ResourceDemandOrderRow>(
      `${ORDER_SELECT_SQL}
      WHERE ${whereSql}
      ORDER BY o.order_date DESC NULLS LAST, o.order_id DESC
      LIMIT $${pageSizeIndex} OFFSET $${offsetIndex}
      `,
      pageParams,
    );

    const projected = await loadProjectedOrders(client, orderResult.rows, command.query);
    const procurement = options.procurementEnabled && projected.length > 0
      ? await loadProcurementRows(client, projected.map((order) => order.orderId))
      : [];
    const data = projected.map<OrderResourceDemandDto>((order) => {
      const lines = applyProcurement(
        order.lines,
        procurement.filter((row) => toNumber(row.order_id) === order.orderId),
      ).map(({ line }) => line);
      return { ...order.base, lines, procurementSummary: summarizeProcurement(lines) };
    });
    return response(command.query, total, data, options);
  }
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
 * совместимые поля `sheetMaterials`/`films`, как раньше.
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

  const full = projectOrders({
    orders: orderRows,
    details: detailResult.rows,
    hdfDetails: hdfResult.rows,
    detailCutJobs: detailCutJobs.rows,
    cutGroups: cutGroups.rows,
    cutSheets: cutSheets.rows,
  });
  const legacyBase = query && hasResourceFilters(query)
    ? projectOrders({
        orders: orderRows,
        details: detailResult.rows.filter((row) => detailMatchesResourceFilters(row, query)),
        hdfDetails: hdfResult.rows.filter((row) => hdfMatchesResourceFilters(row, query)),
        detailCutJobs: detailCutJobs.rows,
        cutGroups: cutGroups.rows,
        cutSheets: cutSheets.rows,
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
export function applyProcurement(
  lines: ProjectedResourceLine[],
  procurement: ResourceProcurementRow[],
): Array<{ line: OrderResourceDemandLineDto; details: OrderResourceDetailRefDto[] }> {
  const byKey = new Map(procurement.map((row) => [procurementRowKey(row), row]));
  const result = lines.map((projected) => {
    const { details, ...rest } = projected;
    return {
      line: {
        ...rest,
        orphan: false,
        procurement: procurementDto(byKey.get(projected.resourceKey), projected.demandFingerprint),
      },
      details,
    };
  });
  const present = new Set(lines.map((line) => line.resourceKey));
  for (const row of procurement) {
    if (present.has(procurementRowKey(row)) || !row.purchased) continue;
    result.push({ line: orphanLine(row), details: [] });
  }
  return result;
}

/**
 * Строка для записи закупа, материала которой больше нет в потребности заказа.
 * В списки попадает только отмеченная; команды используют её и после снятия
 * отметки, чтобы вернуть итоговое состояние (и для no-op повтора снятия).
 */
export function orphanLine(row: ResourceProcurementRow): OrderResourceDemandLineDto {
  const kind = row.resource_kind;
  const refId = kind === 'sheet_material' ? toNumber(row.sheet_material_type_id) : toNumber(row.film_id);
  const fingerprint = emptyDemandFingerprint(kind, refId);
  return {
    resourceKey: procurementRowKey(row),
    kind,
    refId,
    name: cleanName(row.resource_name) ?? `ID: ${refId}`,
    supplierName: null,
    quantity: 0,
    unit: kind === 'film' ? 'lm' : 'm2',
    areaM2: 0,
    detailsCount: 0,
    source: 'none',
    demandFingerprint: fingerprint,
    orphan: true,
    procurement: procurementDto(row, fingerprint),
  };
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
): OrderResourceMaterialAggregateDto[] {
  const byMaterial = new Map<string, OrderResourceMaterialAggregateDto>();
  for (const order of orders) {
    const orderProcurement = procurement.filter((row) => toNumber(row.order_id) === order.orderId);
    for (const { line } of applyProcurement(order.lines, orderProcurement)) {
      if (line.orphan) continue;
      const current = byMaterial.get(line.resourceKey) ?? {
        resourceKey: line.resourceKey,
        kind: line.kind,
        refId: line.refId,
        name: line.name,
        supplierName: line.supplierName,
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
      sheetMaterials: mapSheetRows(sheetByOrder.get(orderId)),
      films: mapFilmRows(filmByOrder.get(orderId)),
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
        supplierName: row.vendorName,
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

function detailMatchesResourceFilters(row: ResourceDemandDetailRow, query: OrderResourceDemandQuery): boolean {
  return (query.sheetMaterialTypeId === undefined || toNullableNumber(row.sheet_material_type_id) === query.sheetMaterialTypeId)
    && (query.filmId === undefined || toNullableNumber(row.film_id) === query.filmId)
    && (query.supplierId === undefined || toNullableNumber(row.supplier_id) === query.supplierId)
    && (query.vendorId === undefined || toNullableNumber(row.vendor_id) === query.vendorId);
}

function hdfMatchesResourceFilters(row: ResourceDemandHdfRow, query: OrderResourceDemandQuery): boolean {
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
    onecDocuments: false,
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
  const scope: Scope = rolePolicyForUser(currentUser).orders.view;
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

function buildOrderWhere(
  command: ListOrderResourceDemandsCommand,
  options: OrderResourceReadOptions,
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

  return { whereSql: clauses.join('\n        AND '), params };
}

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

function buildScopePredicate(scope: Scope, actorIndex: number | null): string {
  if (scope === 'all') return 'TRUE';
  if (scope === 'none') return 'FALSE';
  if (actorIndex === null) return 'FALSE';
  if (scope === 'own') {
    return `(o.created_by = $${actorIndex} OR o.manager_id = $${actorIndex})`;
  }
  return `EXISTS (
    SELECT 1
    FROM order_workshops assigned_ow
    JOIN users assigned_user
      ON assigned_user.employee_id = assigned_ow.responsible_employee_id
    WHERE assigned_ow.order_id = o.order_id
      AND assigned_ow.delete_flag = false
      AND assigned_user.is_active = true
      AND assigned_user.user_id = $${actorIndex}
  )`;
}

function scopeNeedsActor(scope: Scope): boolean {
  return scope === 'own' || scope === 'assigned';
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
