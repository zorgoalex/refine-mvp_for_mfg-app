import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { appendOrderReadScopeSql } from '../../../permissions/policies/order-read-scope-sql';
import type {
  BazisCutPickerCriteria,
  BazisCutPickerDetailDto,
  BazisCutPickerFacetsDto,
  BazisCutPickerMembershipDto,
  BazisCutPickerSearchDto,
} from '../dto/bazis-cut.dto';

interface FacetRow extends QueryResultRow {
  facet_key: string;
  id_value: string | number | null;
  key_value: string | null;
  label: string | null;
  type_value: 'project' | 'order' | 'legacy' | null;
}

interface SearchEnvelopeRow extends QueryResultRow {
  total_count: string | number;
  total_quantity: string | number;
  total_area_m2: string | number;
  items: PickerRow[] | string | null;
}

export interface PickerRow extends QueryResultRow {
  detail_id: string | number;
  detail_number: string | number;
  detail_version: string | number;
  detail_updated_at: string | Date;
  order_id: string | number;
  order_version: string | number;
  order_name: string;
  order_date: string | Date;
  client_id: string | number;
  client_name: string | null;
  project_id: string | number;
  quantity: string | number;
  height_mm: string | number;
  width_mm: string | number;
  area_m2: string | number;
  detail_name: string | null;
  note: string | null;
  doweling: boolean;
  sheet_material_type_id: string | number;
  material_name: string;
  material_thickness_mm: string | number;
  milling_type_id: string | number | null;
  milling_name: string | null;
  film_id: string | number | null;
  basis_designation: string | null;
  basis_data: string | null;
  basis_project: string | null;
  basis_product: string | null;
  bazis_key: string | null;
  bazis_label: string | null;
  bazis_type: 'project' | 'order' | 'legacy' | null;
  doweling_order_id: string | number | null;
  doweling_order_name: string | null;
  design_engineer_id: string | number | null;
  design_engineer_name: string | null;
  bazis_cut_sets: unknown;
}

export class PgBazisCutPicker {
  constructor(private readonly database: DatabaseClient) {}

  async listFacets(
    currentUser: CurrentUser,
    period: Pick<BazisCutPickerCriteria, 'dateFrom' | 'dateTo'>,
  ): Promise<BazisCutPickerFacetsDto> {
    const criteria = normalizeBazisCutPickerCriteria({
      ...period,
      orderIds: [], clientIds: [], sheetMaterialTypeIds: [], millingTypeIds: [], bazisKeys: [],
      designEngineerIds: [], dowelingOrderIds: [], excludedDetailIds: [],
    });
    const params: unknown[] = [];
    const eligibleCte = buildEligibleCte(params, currentUser, criteria);
    const result = await this.database.query<FacetRow>(
      `WITH eligible AS (${eligibleCte}), facets AS (
         SELECT DISTINCT 'orders'::text AS facet_key, e.order_id::bigint AS id_value,
           NULL::text AS key_value, e.order_name::text AS label, NULL::text AS type_value
         FROM eligible e
         UNION ALL
         SELECT DISTINCT 'clients', e.client_id, NULL, e.client_name, NULL FROM eligible e
         UNION ALL
         SELECT DISTINCT 'sheet_materials', e.sheet_material_type_id, NULL, e.material_name, NULL FROM eligible e
         UNION ALL
         SELECT DISTINCT 'milling_types', e.milling_type_id, NULL, e.milling_name, NULL
           FROM eligible e WHERE e.milling_type_id IS NOT NULL
         UNION ALL
         SELECT DISTINCT 'bazis_sources', NULL, e.bazis_key, e.bazis_label, e.bazis_type
           FROM eligible e WHERE e.bazis_key IS NOT NULL
         UNION ALL
         SELECT DISTINCT 'design_engineers', e.design_engineer_id, NULL, e.design_engineer_name, NULL
           FROM eligible e WHERE e.design_engineer_id IS NOT NULL
         UNION ALL
         SELECT DISTINCT 'doweling_orders', e.doweling_order_id, NULL, e.doweling_order_name, NULL
           FROM eligible e WHERE e.doweling_order_id IS NOT NULL
       )
       SELECT facet_key, id_value, key_value, label, type_value
       FROM facets WHERE NULLIF(btrim(label), '') IS NOT NULL`,
      params,
    );
    return mapFacets(result.rows);
  }

  async search(
    currentUser: CurrentUser,
    criteriaInput: BazisCutPickerCriteria,
    page: number,
    pageSize: number,
  ): Promise<BazisCutPickerSearchDto> {
    const criteria = normalizeBazisCutPickerCriteria(criteriaInput);
    const criteriaHash = hashBazisCutPickerCriteria(criteria);
    const params: unknown[] = [];
    const eligibleCte = buildEligibleCte(params, currentUser, criteria);
    const filters = buildFilterPredicate(params, criteria, 'e');
    const limitIndex = params.push(pageSize);
    const offsetIndex = params.push((page - 1) * pageSize);
    const result = await this.database.query<SearchEnvelopeRow>(
      `WITH eligible AS (${eligibleCte}), filtered AS (
         SELECT e.* FROM eligible e WHERE ${filters}
       )
       SELECT
         (SELECT COUNT(*)::bigint FROM filtered) AS total_count,
         (SELECT COALESCE(SUM(quantity), 0)::numeric FROM filtered) AS total_quantity,
         (SELECT COALESCE(SUM(area_m2), 0)::numeric FROM filtered) AS total_area_m2,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(page_row))
           FROM (
             SELECT * FROM filtered
             ORDER BY order_date DESC, order_id DESC, detail_number ASC, detail_id ASC
             LIMIT $${limitIndex} OFFSET $${offsetIndex}
           ) page_row
         ), '[]'::jsonb) AS items`,
      params,
    );
    const envelope = result.rows[0] ?? {
      total_count: 0, total_quantity: 0, total_area_m2: 0, items: [],
    };
    const rawItems = parsePickerRows(envelope.items);
    return {
      items: rawItems.map((row) => mapPickerDetail(row, criteriaHash)),
      page,
      pageSize,
      total: toNumber(envelope.total_count),
      totalQuantity: toNumber(envelope.total_quantity),
      totalAreaM2: roundArea(toNumber(envelope.total_area_m2)),
      criteriaHash,
    };
  }

  async loadSelection(
    currentUser: CurrentUser,
    criteriaInput: BazisCutPickerCriteria,
    detailIds: readonly number[],
  ): Promise<{ criteria: BazisCutPickerCriteria; criteriaHash: string; rows: PickerRow[] }> {
    const criteria = normalizeBazisCutPickerCriteria(criteriaInput);
    const criteriaHash = hashBazisCutPickerCriteria(criteria);
    const params: unknown[] = [];
    const eligibleCte = buildEligibleCte(params, currentUser, criteria);
    const filters = buildFilterPredicate(params, criteria, 'e');
    const detailIdsIndex = params.push([...detailIds]);
    const result = await this.database.query<PickerRow>(
      `WITH eligible AS (${eligibleCte})
       SELECT e.* FROM eligible e
       WHERE ${filters} AND e.detail_id=ANY($${detailIdsIndex}::bigint[])
       ORDER BY e.order_id, e.detail_number, e.detail_id`,
      params,
    );
    return { criteria, criteriaHash, rows: result.rows };
  }
}

export function normalizeBazisCutPickerCriteria(
  criteria: BazisCutPickerCriteria,
): BazisCutPickerCriteria {
  return {
    dateFrom: criteria.dateFrom,
    dateTo: criteria.dateTo,
    orderIds: uniqueNumbers(criteria.orderIds),
    clientIds: uniqueNumbers(criteria.clientIds),
    sheetMaterialTypeIds: uniqueNumbers(criteria.sheetMaterialTypeIds),
    millingTypeIds: uniqueNumbers(criteria.millingTypeIds),
    bazisKeys: uniqueStrings(criteria.bazisKeys),
    designEngineerIds: uniqueNumbers(criteria.designEngineerIds),
    dowelingOrderIds: uniqueNumbers(criteria.dowelingOrderIds),
    excludedDetailIds: uniqueNumbers(criteria.excludedDetailIds),
  };
}

export function hashBazisCutPickerCriteria(criteria: BazisCutPickerCriteria): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeBazisCutPickerCriteria(criteria)))
    .digest('hex');
}

export function buildBazisCutPickerSelectionToken(criteriaHash: string, row: PickerRow): string {
  const stableState = {
    detailId: toNumber(row.detail_id), detailNumber: toNumber(row.detail_number),
    detailVersion: toNumber(row.detail_version), detailUpdatedAt: isoValue(row.detail_updated_at),
    orderId: toNumber(row.order_id), orderVersion: toNumber(row.order_version),
    orderName: textValue(row.order_name), orderDate: dateValue(row.order_date),
    clientId: toNumber(row.client_id), projectId: toNumber(row.project_id),
    quantity: toNumber(row.quantity), heightMm: toNumber(row.height_mm), widthMm: toNumber(row.width_mm),
    detailName: textValue(row.detail_name), note: textValue(row.note), doweling: row.doweling === true,
    sheetMaterialTypeId: toNumber(row.sheet_material_type_id), materialName: textValue(row.material_name),
    materialThicknessMm: toNumber(row.material_thickness_mm), millingTypeId: nullableNumber(row.milling_type_id),
    millingName: textValue(row.milling_name), filmId: nullableNumber(row.film_id),
    basisDesignation: textValue(row.basis_designation), basisData: textValue(row.basis_data),
    basisProject: textValue(row.basis_project), basisProduct: textValue(row.basis_product),
    bazisKey: textValue(row.bazis_key), dowelingOrderId: nullableNumber(row.doweling_order_id),
    designEngineerId: nullableNumber(row.design_engineer_id),
  };
  return createHash('sha256').update(`${criteriaHash}:${JSON.stringify(stableState)}`).digest('hex');
}

function buildEligibleCte(
  params: unknown[],
  currentUser: CurrentUser,
  criteria: BazisCutPickerCriteria,
): string {
  const fromIndex = params.push(criteria.dateFrom);
  const toIndex = params.push(criteria.dateTo);
  const scope = appendOrderReadScopeSql(params, currentUser, 'o');
  return `
    SELECT
      od.detail_id, od.detail_number, od.version AS detail_version, od.updated_at AS detail_updated_at,
      o.order_id, o.version AS order_version, o.order_name::text AS order_name, o.order_date,
      o.client_id, COALESCE(c.client_name::text, '—') AS client_name, o.project_id,
      od.quantity, od.height AS height_mm, od.width AS width_mm,
      (od.height * od.width * od.quantity / 1000000.0)::numeric AS area_m2,
      od.detail_name, od.note, COALESCE(od.doweling, false) AS doweling,
      od.sheet_material_type_id, smt.name::text AS material_name,
      smt.thickness_mm AS material_thickness_mm,
      od.milling_type_id, mt.milling_type_name::text AS milling_name, od.film_id,
      od.basis_designation, od.basis_data, od.basis_project, od.basis_product,
      CASE
        WHEN chosen.revision_id IS NOT NULL AND basis.root_product_count > 1
          THEN 'project:' || chosen.bazis_project_id::text
        WHEN chosen.revision_id IS NOT NULL THEN 'order:' || chosen.revision_id::text
        WHEN NULLIF(btrim(od.basis_project), '') IS NOT NULL
          THEN 'legacy:' || lower(btrim(od.basis_project))
        ELSE NULL
      END AS bazis_key,
      CASE
        WHEN chosen.revision_id IS NOT NULL AND basis.root_product_count > 1
          THEN 'Базис-проект: ' || COALESCE(basis.revision_order_no, '№' || chosen.bazis_project_id::text)
        WHEN chosen.revision_id IS NOT NULL
          THEN 'Базис-заказ: ' || COALESCE(basis.product_order_no, basis.revision_order_no, '№' || chosen.revision_id::text)
        WHEN NULLIF(btrim(od.basis_project), '') IS NOT NULL
          THEN 'Базис-заказ: ' || btrim(od.basis_project)
        ELSE NULL
      END AS bazis_label,
      CASE
        WHEN chosen.revision_id IS NOT NULL AND basis.root_product_count > 1 THEN 'project'
        WHEN chosen.revision_id IS NOT NULL THEN 'order'
        WHEN NULLIF(btrim(od.basis_project), '') IS NOT NULL THEN 'legacy'
        ELSE NULL
      END AS bazis_type,
      doweling.doweling_order_id, doweling.doweling_order_name,
      doweling.design_engineer_id, doweling.design_engineer_name,
      memberships.bazis_cut_sets
    FROM orders o
    JOIN order_details od ON od.order_id=o.order_id AND od.delete_flag=false
    JOIN sheet_material_types smt
      ON smt.sheet_material_type_id=od.sheet_material_type_id AND smt.is_cuttable=true
    LEFT JOIN clients c ON c.client_id=o.client_id
    LEFT JOIN milling_types mt ON mt.milling_type_id=od.milling_type_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS exact_count,
        MIN(br.bazis_revision_id) AS revision_id,
        MIN(br.bazis_project_id) AS bazis_project_id
      FROM bazis_node_order_detail_map map
      JOIN bazis_nodes node ON node.bazis_node_id=map.node_id
      JOIN bazis_project_revisions br ON br.bazis_revision_id=node.revision_id
      WHERE map.order_detail_id=od.detail_id
    ) exact ON true
    LEFT JOIN LATERAL (
      SELECT link.revision_id, link.bazis_project_id
      FROM bazis_order_links link
      WHERE link.order_id=o.order_id
      ORDER BY link.created_at DESC, link.bazis_order_link_id DESC
      LIMIT 1
    ) linked ON true
    LEFT JOIN LATERAL (
      SELECT
        CASE WHEN COALESCE(exact.exact_count, 0)=1 THEN exact.revision_id ELSE linked.revision_id END AS revision_id,
        CASE WHEN COALESCE(exact.exact_count, 0)=1 THEN exact.bazis_project_id ELSE linked.bazis_project_id END AS bazis_project_id
    ) chosen ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(root.bazis_node_id)::integer AS root_product_count,
        NULLIF(btrim(revision.bazis_order_no), '') AS revision_order_no,
        (
          SELECT NULLIF(btrim(first_root.raw_json->>'Заказ'), '')
          FROM bazis_nodes first_root
          WHERE first_root.revision_id=chosen.revision_id
            AND first_root.parent_node_id IS NULL AND first_root.node_kind='product'
            AND NULLIF(btrim(first_root.raw_json->>'Заказ'), '') IS NOT NULL
          ORDER BY first_root.seq LIMIT 1
        ) AS product_order_no
      FROM bazis_project_revisions revision
      LEFT JOIN bazis_nodes root
        ON root.revision_id=revision.bazis_revision_id
       AND root.parent_node_id IS NULL AND root.node_kind='product'
      WHERE revision.bazis_revision_id=chosen.revision_id
      GROUP BY revision.bazis_revision_id, revision.bazis_order_no
    ) basis ON true
    LEFT JOIN LATERAL (
      SELECT dow.doweling_order_id, dow.doweling_order_name::text AS doweling_order_name,
        dow.design_engineer_id, employee.full_name::text AS design_engineer_name
      FROM order_doweling_links link
      JOIN doweling_orders dow
        ON dow.doweling_order_id=link.doweling_order_id AND dow.delete_flag=false
      LEFT JOIN employees employee ON employee.employee_id=dow.design_engineer_id
      WHERE link.order_id=o.order_id AND link.delete_flag=false
      ORDER BY link.updated_at DESC, link.order_doweling_link_id DESC
      LIMIT 1
    ) doweling ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'bazisCutSetId', refs.bazis_cut_set_id, 'name', refs.name
      ) ORDER BY refs.bazis_cut_set_id), '[]'::jsonb) AS bazis_cut_sets
      FROM (
        SELECT DISTINCT set.bazis_cut_set_id, set.name
        FROM bazis_cut_set_details detail
        JOIN bazis_cut_sets set ON set.bazis_cut_set_id=detail.bazis_cut_set_id
        WHERE detail.source_order_detail_id=od.detail_id
      ) refs
    ) memberships ON true
    WHERE o.delete_flag=false
      AND o.order_date BETWEEN $${fromIndex}::date AND $${toIndex}::date
      AND ${scope.predicate}
      AND COALESCE(exact.exact_count, 0) <= 1
      AND od.height > 0 AND od.width > 0 AND od.quantity > 0
      AND smt.thickness_mm > 0
  `;
}

function buildFilterPredicate(
  params: unknown[],
  criteria: BazisCutPickerCriteria,
  alias: string,
): string {
  const conditions: string[] = [];
  appendAny(conditions, params, criteria.orderIds, `${alias}.order_id`, 'bigint');
  appendAny(conditions, params, criteria.clientIds, `${alias}.client_id`, 'bigint');
  appendAny(conditions, params, criteria.sheetMaterialTypeIds, `${alias}.sheet_material_type_id`, 'bigint');
  appendAny(conditions, params, criteria.millingTypeIds, `${alias}.milling_type_id`, 'smallint');
  appendAny(conditions, params, criteria.bazisKeys, `${alias}.bazis_key`, 'text');
  appendAny(conditions, params, criteria.designEngineerIds, `${alias}.design_engineer_id`, 'bigint');
  appendAny(conditions, params, criteria.dowelingOrderIds, `${alias}.doweling_order_id`, 'bigint');
  if (criteria.excludedDetailIds.length > 0) {
    const index = params.push(criteria.excludedDetailIds);
    conditions.push(`NOT (${alias}.detail_id=ANY($${index}::bigint[]))`);
  }
  return conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';
}

function appendAny(
  conditions: string[], params: unknown[], values: readonly unknown[], expression: string, cast: string,
): void {
  if (values.length === 0) return;
  const index = params.push([...values]);
  conditions.push(`${expression}=ANY($${index}::${cast}[])`);
}

function mapFacets(rows: FacetRow[]): BazisCutPickerFacetsDto {
  const result: BazisCutPickerFacetsDto = {
    orders: [], clients: [], sheetMaterials: [], millingTypes: [], bazisSources: [],
    designEngineers: [], dowelingOrders: [],
  };
  for (const row of rows) {
    const label = row.label?.trim();
    if (!label) continue;
    if (row.facet_key === 'bazis_sources' && row.key_value && row.type_value) {
      result.bazisSources.push({ key: row.key_value, label, type: row.type_value });
      continue;
    }
    const id = nullableNumber(row.id_value);
    if (id === null) continue;
    const option = { id, label };
    if (row.facet_key === 'orders') result.orders.push(option);
    else if (row.facet_key === 'clients') result.clients.push(option);
    else if (row.facet_key === 'sheet_materials') result.sheetMaterials.push(option);
    else if (row.facet_key === 'milling_types') result.millingTypes.push(option);
    else if (row.facet_key === 'design_engineers') result.designEngineers.push(option);
    else if (row.facet_key === 'doweling_orders') result.dowelingOrders.push(option);
  }
  const byLabel = (left: { label: string }, right: { label: string }) =>
    left.label.localeCompare(right.label, 'ru', { numeric: true });
  result.orders.sort(byLabel);
  result.clients.sort(byLabel);
  result.sheetMaterials.sort(byLabel);
  result.millingTypes.sort(byLabel);
  result.bazisSources.sort(byLabel);
  result.designEngineers.sort(byLabel);
  result.dowelingOrders.sort(byLabel);
  return result;
}

function mapPickerDetail(row: PickerRow, criteriaHash: string): BazisCutPickerDetailDto {
  return {
    detailId: toNumber(row.detail_id), orderId: toNumber(row.order_id), orderNumber: textValue(row.order_name),
    orderDate: dateValue(row.order_date), clientName: textValue(row.client_name) || '—',
    detailNumber: toNumber(row.detail_number), detailName: textValue(row.detail_name),
    quantity: toNumber(row.quantity), heightMm: toNumber(row.height_mm), widthMm: toNumber(row.width_mm),
    areaM2: roundArea(toNumber(row.area_m2)), materialName: textValue(row.material_name),
    millingName: textValue(row.milling_name), bazisLabel: textValue(row.bazis_label),
    designEngineerName: textValue(row.design_engineer_name), dowelingOrderName: textValue(row.doweling_order_name),
    bazisCutSets: mapMemberships(row.bazis_cut_sets),
    selectionToken: buildBazisCutPickerSelectionToken(criteriaHash, row),
  };
}

function mapMemberships(value: unknown): BazisCutPickerMembershipDto[] {
  const source = typeof value === 'string' ? safeParseArray(value) : value;
  if (!Array.isArray(source)) return [];
  return source.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as { bazisCutSetId?: unknown; name?: unknown };
    const bazisCutSetId = nullableNumber(item.bazisCutSetId);
    if (bazisCutSetId === null) return [];
    return [{ bazisCutSetId, name: textValue(item.name) }];
  }).sort((left, right) => left.bazisCutSetId - right.bazisCutSetId);
}

function parsePickerRows(value: PickerRow[] | string | null): PickerRow[] {
  if (typeof value === 'string') return safeParseArray(value) as PickerRow[];
  return Array.isArray(value) ? value : [];
}

function safeParseArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'ru', { numeric: true }));
}

function roundArea(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100; }
function toNumber(value: unknown): number { return Number(value); }
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function textValue(value: unknown): string { return value == null ? '' : String(value).trim(); }
function dateValue(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
function isoValue(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
