import type { QueryResultRow } from 'pg';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import { ROLE_POLICIES, type Scope } from '../../../permissions/policies/role-policies';
import {
  calculateBathSheetFilmUsage,
  shouldShowBathMeterGuides,
} from '../../../shared/cut-geometry';
import {
  parseFreecutItemId,
  type SheetPlacementsJson,
} from '../../cut/application/cut-freecut-mapping';
import type {
  ListOrderResourceDemandsCommand,
  OrderFilmDemandDto,
  OrderResourceDemandDto,
  OrderResourceDemandQuery,
  OrderResourceDemandRepositoryPort,
  OrderResourceDemandResponseDto,
  OrderSheetMaterialDemandDto,
} from '../application/order-resource-demand.types';

interface CountRow extends QueryResultRow {
  total: string | number;
}

interface OrderRow extends QueryResultRow {
  order_id: string | number;
  order_name: string;
  full_number: string;
  order_date: string | Date | null;
  project_code: string;
  client_name: string | null;
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
}

interface DetailCutJobRow extends QueryResultRow {
  order_detail_id: string | number;
  cut_job_id: string | number;
}

interface ResourceDemandHdfRow extends QueryResultRow {
  order_hdf_detail_id: string | number;
  order_id: string | number;
  hdf_height_mm: string | number | null;
  hdf_width_mm: string | number | null;
  quantity: string | number | null;
  hdf_sheet_material_type_id: string | number | null;
  hdf_sheet_material_name: string | null;
  supplier_id: string | number | null;
  supplier_name: string | null;
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

interface SheetAccumulator {
  sheetMaterialTypeId: number;
  name: string;
  areaMm2: number;
  detailsCount: number;
  supplierId: number | null;
  supplierName: string | null;
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
}

interface ProjectionInput {
  orders: OrderRow[];
  details: ResourceDemandDetailRow[];
  hdfDetails?: ResourceDemandHdfRow[];
  detailCutJobs: DetailCutJobRow[];
  cutGroups: ResourceDemandCutGroupRow[];
  cutSheets: ResourceDemandCutSheetRow[];
}

export class PgOrderResourceDemandRepository implements OrderResourceDemandRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  async list(command: ListOrderResourceDemandsCommand): Promise<OrderResourceDemandResponseDto> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return this.listInSnapshot(client, command);
    });
  }

  private async listInSnapshot(
    client: DatabaseClient,
    command: ListOrderResourceDemandsCommand,
  ): Promise<OrderResourceDemandResponseDto> {
    const { whereSql, params } = buildOrderWhere(command);
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
    const orderResult = await client.query<OrderRow>(
      `
      SELECT
        o.order_id,
        o.order_name,
        (p.code || '-' || o.order_name) AS full_number,
        o.order_date,
        p.code AS project_code,
        c.client_name,
        o.updated_at
      FROM orders o
      JOIN projects p ON p.project_id = o.project_id
      LEFT JOIN clients c ON c.client_id = o.client_id
      WHERE ${whereSql}
      ORDER BY o.order_date DESC NULLS LAST, o.order_id DESC
      LIMIT $${pageSizeIndex} OFFSET $${offsetIndex}
      `,
      pageParams,
    );

    const orderIds = orderResult.rows.map((row) => toNumber(row.order_id));
    if (orderIds.length === 0) {
      return response(command.query, total, []);
    }

    const detailParams: unknown[] = [orderIds];
    const detailResourceFilters = buildResourceFilters(command.query, detailParams, 'od', 'smt', 'f');
    const detailResult = await client.query<ResourceDemandDetailRow>(
      `
      SELECT
        od.detail_id,
        od.order_id,
        od.height,
        od.width,
        od.quantity,
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
        ${detailResourceFilters.length > 0 ? `AND ${detailResourceFilters.join('\n        AND ')}` : ''}
      ORDER BY od.order_id, od.detail_number, od.detail_id
      `,
      detailParams,
    );

    const hdfParams: unknown[] = [orderIds];
    const hdfResourceFilters = buildHdfResourceFilters(command.query, hdfParams, 'hdf', 'hdf_smt');
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
        ${hdfResourceFilters.length > 0 ? `AND ${hdfResourceFilters.join('\n        AND ')}` : ''}
      ORDER BY hdf.order_id, hdf.source_detail_number, hdf.order_hdf_detail_id
      `,
      hdfParams,
    );

    const detailIds = detailResult.rows.map((row) => toNumber(row.detail_id));
    if (detailIds.length === 0) {
      return response(
        command.query,
        total,
        buildOrderResourceDemandProjection({
          orders: orderResult.rows,
          details: [],
          hdfDetails: hdfResult.rows,
          detailCutJobs: [],
          cutGroups: [],
          cutSheets: [],
        }),
      );
    }

    const detailCutJobs = await client.query<DetailCutJobRow>(
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
    if (cutJobIds.length === 0) {
      return response(
        command.query,
        total,
        buildOrderResourceDemandProjection({
          orders: orderResult.rows,
          details: detailResult.rows,
          hdfDetails: hdfResult.rows,
          detailCutJobs: [],
          cutGroups: [],
          cutSheets: [],
        }),
      );
    }

    const cutGroups = await client.query<ResourceDemandCutGroupRow>(
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

    return response(
      command.query,
      total,
      buildOrderResourceDemandProjection({
        orders: orderResult.rows,
        details: detailResult.rows,
        hdfDetails: hdfResult.rows,
        detailCutJobs: detailCutJobs.rows,
        cutGroups: cutGroups.rows,
        cutSheets: cutSheets.rows,
      }),
    );
  }
}

export function buildOrderResourceDemandProjection(input: ProjectionInput): OrderResourceDemandDto[] {
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
      };
      current.areaMm2 += areaMm2;
      current.detailsCount += 1;
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
      };
      current.areaMm2 += areaMm2;
      current.detailsCount += 1;
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
    };
    current.areaMm2 += areaMm2;
    current.detailsCount += Math.max(0, Math.trunc(positiveNumber(hdf.quantity) ?? 0));
    rows.set(sheetMaterialTypeId, current);
  }

  const autoSheetsByGroup = new Map<number, ResourceDemandCutSheetRow[]>();
  for (const sheet of input.cutSheets) {
    getOrCreate(autoSheetsByGroup, toNumber(sheet.cut_group_id), () => []).push(sheet);
  }

  for (const group of input.cutGroups) {
    const cutJobId = toNumber(group.cut_job_id);
    const cutGroupId = toNumber(group.cut_group_id);
    const sourceSheets = group.manual_is_active === true && group.manual_is_stale !== true
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
      }
    }
  }

  return input.orders.map((order) => {
    const orderId = toNumber(order.order_id);
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

function buildOrderWhere(command: ListOrderResourceDemandsCommand): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [];
  const scope: Scope = ROLE_POLICIES[command.currentUser.role].orders.view;
  const actorIndex = scopeNeedsActor(scope)
    ? params.push(normalizeActorUserId(command.currentUser.id))
    : null;
  const clauses = [
    'o.delete_flag = false',
    "o.order_kind = 'production_order'",
    buildScopePredicate(scope, actorIndex),
  ];

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

  return { whereSql: clauses.join('\n        AND '), params };
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
): OrderResourceDemandResponseDto {
  return {
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
