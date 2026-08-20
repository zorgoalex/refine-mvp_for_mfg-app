import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import type { OrderFormDataResponseDto } from '../dto/order-form-data.dto';
import type {
  OrderAuditEventDto,
  OrderAuditListResponseDto,
  OrderDto,
  OrderListItemDto,
  OrderListResponseDto,
} from '../dto/order.dto';
import type { OrderGroupRelationType, OrderGroupSummaryDto } from '../dto/order-group-link.dto';
import type {
  GetOrderFormDataCommand,
  GetOrderAuditCommand,
  GetOrderByIdCommand,
  ListOrdersCommand,
  OrderListSortBy,
  OrderReadRepositoryPort,
  OrderNameSuggestionRepositoryPort,
} from '../application/order-query.types';
import { formatCutJobNumber } from '../../cut/application/cut-numbering';

const SORT_COLUMNS: Record<OrderListSortBy, string> = {
  orderId: 'o.order_id',
  orderName: 'o.order_name',
  orderDate: 'o.order_date',
  plannedCompletionDate: 'o.planned_completion_date',
  completionDate: 'o.completion_date',
  issueDate: 'o.issue_date',
  deletedAt: 'o.deleted_at',
  projectCode: 'mp.code',
  clientName: 'c.client_name',
  orderStatusName: 'os.order_status_name',
  paymentStatusName: 'pay_s.payment_status_name',
  productionStatusName: 'prod_s.production_status_name',
  finalAmount: 'o.final_amount',
  paidAmount: 'o.paid_amount',
  debtAmount: '(o.final_amount - o.paid_amount)',
  updatedAt: 'o.updated_at',
};

const PAGE_SORT_COLUMNS: Record<OrderListSortBy, string> = {
  orderId: 'o.order_id',
  orderName: 'o.order_name',
  orderDate: 'o.order_date',
  plannedCompletionDate: 'o.planned_completion_date',
  completionDate: 'o.completion_date',
  issueDate: 'o.issue_date',
  deletedAt: 'o.deleted_at',
  projectCode: 'o.project_code',
  clientName: 'o.client_name',
  orderStatusName: 'o.order_status_name',
  paymentStatusName: 'o.payment_status_name',
  productionStatusName: 'o.production_status_name',
  finalAmount: 'o.final_amount',
  paidAmount: 'o.paid_amount',
  debtAmount: '(o.final_amount - o.paid_amount)',
  updatedAt: 'o.updated_at',
};

interface OrderHeaderRow extends QueryResultRow {
  order_id: string | number;
  order_name: string;
  project_id: string | number;
  project_code: string;
  full_number: string;
  client_id: string | number;
  client_name: string | null;
  order_date: string | Date;
  priority: string | number;
  order_status_id: string | number;
  order_status_name: string | null;
  payment_status_id: string | number;
  payment_status_name: string | null;
  production_status_id: string | number | null;
  production_status_name: string | null;
  production_status_from_details_enabled: boolean;
  planned_completion_date: string | Date | null;
  completion_date: string | Date | null;
  issue_date: string | Date | null;
  payment_date: string | Date | null;
  discount: string | number | null;
  surcharge: string | number | null;
  notes: string | null;
  manager_id: string | number | null;
  link_cutting_file: string | null;
  link_cutting_image_file: string | null;
  link_cad_file: string | null;
  link_pdf_file: string | null;
  total_amount: string | number | null;
  final_amount: string | number | null;
  paid_amount: string | number | null;
  parts_count: string | number | null;
  total_area: string | number | null;
  created_at: string | Date;
  updated_at: string | Date;
  created_by: string | number | null;
  edited_by: string | number | null;
  version: string | number;
  ref_key_1c: string | null;
  sheet_material_type_id: string | number | null;
  hdf_min_threshold_mm: string | number | null;
  sheet_eligible: boolean | null;
  material_name: string | null;
  header_material_name: string | null;
  header_sheet_material_type_id: string | number | null;
  material_ids: unknown[] | null;
  material_names: unknown[] | null;
  basis_projects: unknown[] | null;
  bazis_cut_numbers: unknown[] | null;
  cut_numbers: unknown[] | null;
  bath_cut_numbers: unknown[] | null;
  film_names: unknown[] | null;
  sheet_material_type_ids: unknown[] | null;
  material_id: string | number | null;
  milling_type_id: string | number | null;
  edge_type_id: string | number | null;
  film_id: string | number | null;
  delete_flag: boolean;
  deleted_at: string | Date | null;
  deleted_by: string | number | null;
  deleted_by_name: string | null;
  milling_type_name: string | null;
  latest_doweling_order_id: string | number | null;
  latest_doweling_order_name: string | null;
  latest_design_engineer_id: string | number | null;
  passed_production_status_codes: unknown[] | null;
  group_links_json: unknown;
}

interface OrderDetailRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  detail_number: string | number;
  detail_name: string | null;
  height: string | number;
  width: string | number;
  quantity: string | number;
  area: string | number;
  material_id: string | number | null;
  sheet_material_type_id: string | number | null;
  material_name: string | null;
  milling_type_id: string | number;
  hdf_parameter_override_mm: string | number | null;
  edge_type_id: string | number;
  film_id: string | number | null;
  milling_cost_per_sqm: string | number | null;
  detail_cost: string | number | null;
  priority: string | number | null;
  production_status_id: string | number | null;
  joint_order_id: string | number | null;
  note: string | null;
  basis_project: string | null;
  bazis_project_id: string | number | null;
  basis_product: string | null;
  basis_data: string | null;
  basis_designation: string | null;
  doweling: boolean;
  link_cutting_file: string | null;
  link_cutting_image_file: string | null;
  link_cad_file: string | null;
  link_pdf_file: string | null;
  ref_key_1c: string | null;
  cut_job_id: string | number | null;
  cut_result_no: string | number | null;
  cut_job_source_display_number: string | number | null;
  cut_job_name: string | null;
  cut_job_param_profile_id: string | number | null;
  cut_job_profile_name: string | null;
  cut_job_profile_is_active: boolean | null;
  bath_cut_job_id: string | number | null;
  bath_cut_result_no: string | number | null;
  bath_cut_job_source_display_number: string | number | null;
  bath_cut_job_name: string | null;
  bath_cut_job_param_profile_id: string | number | null;
  bath_cut_job_profile_name: string | null;
  bath_cut_job_profile_is_active: boolean | null;
  bazis_cut_sets: unknown;
  bazis_projects: unknown;
}

interface OrderHdfDetailRow extends QueryResultRow {
  order_hdf_detail_id: string | number;
  order_id: string | number;
  source_order_detail_id: string | number | null;
  source_order_detail_id_snapshot: string | number;
  source_detail_number: string | number | null;
  source_detail_name: string | null;
  source_height_mm: string | number | null;
  source_width_mm: string | number | null;
  source_quantity: string | number | null;
  milling_type_id: string | number | null;
  milling_type_name: string | null;
  edge_mm: string | number | null;
  threshold_mm: string | number | null;
  hdf_sheet_material_type_id: string | number | null;
  hdf_sheet_material_name: string | null;
  hdf_height_mm: string | number | null;
  hdf_width_mm: string | number | null;
  quantity: string | number | null;
  area_m2: string | number | null;
  status: string;
  config_errors: unknown;
  config_revision: string | number;
  current_config_revision: string | number;
  is_stale: boolean;
  production_status_id: string | number | null;
  production_status_name: string | null;
  production_status_locked: boolean;
  version: string | number;
  cut_job_id: string | number | null;
  cut_result_no: string | number | null;
  cut_job_source_display_number: string | number | null;
  cut_job_name: string | null;
  cut_job_param_profile_id: string | number | null;
  cut_job_profile_name: string | null;
  cut_job_profile_is_active: boolean | null;
  bazis_cut_sets: unknown;
}

interface OrderPaymentRow extends QueryResultRow {
  payment_id: string | number;
  order_id: string | number;
  type_paid_id: string | number;
  amount: string | number;
  payment_date: string | Date;
  notes: string | null;
  ref_key_1c: string | null;
}

interface OrderWorkshopRow extends QueryResultRow {
  order_workshop_id: string | number;
  order_id: string | number;
  workshop_id: string | number;
  production_status_id: string | number;
  received_date: string | Date | null;
  started_date: string | Date | null;
  completed_date: string | Date | null;
  planned_completion_date: string | Date | null;
  sequence_order: string | number | null;
  responsible_employee_id: string | number | null;
  notes: string | null;
  ref_key_1c: string | null;
}

interface OrderRequirementRow extends QueryResultRow {
  requirement_id: string | number;
  order_id: string | number;
  resource_type: string;
  material_id: string | number | null;
  film_id: string | number | null;
  edge_type_id: string | number | null;
  required_quantity: string | number;
  unit_id: string | number;
  waste_percentage: string | number | null;
  final_quantity: string | number | null;
  requirement_status_id: string | number;
  supplier_id: string | number | null;
  purchase_price: string | number | null;
  requisition_id: string | number | null;
  warehouse_id: string | number | null;
  reserved_at: string | Date | null;
  consumed_at: string | Date | null;
  notes: string | null;
  calculation_details: unknown;
  ref_key_1c: string | null;
}

interface OrderDowelingLinkRow extends QueryResultRow {
  order_doweling_link_id: string | number;
  order_id: string | number;
  doweling_order_id: string | number;
  doweling_order_name: string | null;
  design_engineer_id: string | number | null;
  ref_key_1c: string | null;
}

interface OrderGroupLinkRow extends QueryResultRow {
  group_id: string;
  code: string;
  name: string;
  relation_type: OrderGroupRelationType;
  is_primary: boolean;
  valid_from: string | Date;
}

interface CountRow extends QueryResultRow {
  total: string | number;
}

export function parseOrderSearchInput(raw: string): {
  plain: string;
  codePrefix: string | null;
  codeExact: string | null;
  namePrefix: string | null;
} {
  const trimmed = raw.trim();
  const lastDash = trimmed.lastIndexOf('-');
  const tail = lastDash > 0 ? trimmed.slice(lastDash + 1) : '';
  const isFullNumber = lastDash > 0 && /^\d+$/.test(tail);
  const isPlainNumeric = /^\d+$/.test(trimmed);

  return {
    plain: trimmed,
    // Чисто числовой ввод ищет только по названию заказа/клиента.
    // Иначе числовой запрос начнет матчить коды проектов и ломать текущее поведение.
    codePrefix: isPlainNumeric ? null : trimmed,
    codeExact: isFullNumber ? trimmed.slice(0, lastDash) : null,
    namePrefix: isFullNumber ? tail : null,
  };
}

interface AuditLogRow extends QueryResultRow {
  audit_id: string;
  entity_type: string | null;
  entity_id: string | null;
  event: string;
  user_id: string | number | null;
  username: string | null;
  role: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  diff_json: Record<string, unknown> | null;
  created_at: string | Date;
}

interface IdNameLookupRow extends QueryResultRow {
  id: string | number;
  name: string;
  sort_order: string | number;
}

interface MaterialLookupRow extends IdNameLookupRow {
  unit_id: string | number | null;
}

interface MillingTypeLookupRow extends IdNameLookupRow {
  cost_per_sqm: string | number | null;
  hdf_enabled: boolean | null;
  hdf_edge_mm: string | number | null;
  version: string | number | null;
}

interface SheetMaterialTypeLookupRow extends IdNameLookupRow {
  width_mm: string | number | null;
  height_mm: string | number | null;
  is_active: boolean;
  is_cuttable: boolean;
}

interface StatusLookupRow extends IdNameLookupRow {
  code: string | null;
  color: string | null;
}

interface EmployeeLookupRow extends QueryResultRow {
  id: string | number;
  full_name: string;
}

interface UnitLookupRow extends QueryResultRow {
  id: string | number;
  code: string;
  name: string;
  symbol: string | null;
  sort_order: string | number;
}

export class PgOrderReadRepository
  implements OrderReadRepositoryPort, OrderNameSuggestionRepositoryPort
{
  // SP3: sheetOrdersReads gates the migration-029 sheet columns/joins in order reads.
  // Defaults true so direct instantiations (tests) keep full sheet reads; the orders
  // module + tx-manager pass the env flag (BACKEND_SHEET_ORDERS_READS, default false) so
  // backend code is safe before migration 029 is applied.
  constructor(
    private readonly database: DatabaseClient,
    private readonly sheetOrdersReads: boolean = true,
  ) {}

  async listOrders(command: ListOrdersCommand): Promise<OrderListResponseDto> {
    const params: unknown[] = [];
    const where = this.buildListWhere(command, params);
    const orderBy = SORT_COLUMNS[command.query.sortBy];
    const limitIndex = params.push(command.query.pageSize);
    const offsetIndex = params.push((command.query.page - 1) * command.query.pageSize);
    // SP3: migration-029 sheet columns/joins gated so backend list reads work pre-migration.
    // Variant B (flag-ON): sheet name is smt.name directly — no COALESCE fallback to materials.
    // flag-OFF stays as the legacy pre-migration path (materials join only).
    const headerSheetSelect = this.sheetOrdersReads
      ? `o.sheet_material_type_id AS header_sheet_material_type_id,
          hsmt.name AS header_material_name`
      : `NULL::bigint AS header_sheet_material_type_id,
          hm.material_name AS header_material_name`;
    const headerSheetJoin = this.sheetOrdersReads
      ? 'LEFT JOIN sheet_material_types hsmt ON hsmt.sheet_material_type_id = o.sheet_material_type_id'
      : '';
    // Variant B: detail name from sheet type only; legacy path still reads materials.
    const listDetailNameSelect = this.sheetOrdersReads
      ? 'smt.name AS material_name'
      : 'm.material_name AS material_name';
    // Variant B: no materials join in the detail aggregate (material_id is NULL post-034).
    const listDetailMaterialJoin = this.sheetOrdersReads
      ? ''
      : 'LEFT JOIN materials m ON m.material_id = od.material_id';
    const listDetailSheetJoin = this.sheetOrdersReads
      ? 'LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id'
      : '';
    // Variant B: group by sheet_material_type_id (not material_id which is NULL post-034).
    const listDetailNameGroupBy = this.sheetOrdersReads
      ? 'GROUP BY od.sheet_material_type_id, smt.name'
      : 'GROUP BY od.material_id, m.material_name';
    // Variant B: filter by sheet_material_type_id presence; legacy path filters on material_id.
    const listDetailFilter = this.sheetOrdersReads
      ? 'od.sheet_material_type_id IS NOT NULL'
      : 'od.material_id IS NOT NULL';
    // Variant B: header materials join is dead weight when flag-ON (hm alias not referenced).
    const headerListMaterialJoin = this.sheetOrdersReads
      ? ''
      : 'LEFT JOIN materials hm ON hm.material_id = o.material_id';
    // Variant B: aggregate sheet_material_type_id in flag-ON; produce NULL column in flag-OFF.
    const listDetailSheetIdSelect = this.sheetOrdersReads
      ? 'od.sheet_material_type_id,'
      : 'NULL::bigint AS sheet_material_type_id,';
    // Note: no trailing comma — this is the last column in the outer LATERAL SELECT before FROM.
    const listSheetTypeIdsAggregate = this.sheetOrdersReads
      ? 'ARRAY_AGG(materials.sheet_material_type_id ORDER BY materials.first_detail_number, materials.first_detail_id) AS sheet_material_type_ids'
      : 'NULL::bigint[] AS sheet_material_type_ids';
    const deletedSelect = command.query.deleted === true
      ? `,
          o.deleted_at,
          o.deleted_by,
          deleted_by_user.full_name AS deleted_by_name`
      : '';
    const deletedJoin = command.query.deleted === true
      ? 'LEFT JOIN users deleted_by_user ON deleted_by_user.user_id = o.deleted_by'
      : '';
    const headerListMetadataJoin = command.query.deleted === true
      ? [headerListMaterialJoin, deletedJoin].filter((fragment) => fragment.length > 0).join('\n        ')
      : headerListMaterialJoin;
    const count = await this.database.query<CountRow>(
      `
      SELECT COUNT(*)::int AS total
      FROM orders o
      JOIN projects mp ON mp.project_id = o.project_id
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
      LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id
      LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = o.production_status_id
      ${where}
      `,
      params.slice(0, params.length - 2),
    );
    const rows = await this.database.query<OrderHeaderRow>(
      `
      WITH page_orders AS (
        SELECT
          o.order_id, o.order_name, o.project_id, mp.code AS project_code,
          (mp.code || '-' || o.order_name) AS full_number,
          o.client_id, c.client_name,
          o.order_date, o.priority,
          o.order_status_id, os.order_status_name,
          o.payment_status_id, pay_s.payment_status_name,
          o.production_status_id, prod_s.production_status_name,
          o.production_status_from_details_enabled,
          o.planned_completion_date, o.completion_date, o.issue_date, o.payment_date,
          o.discount, o.surcharge, o.notes, o.manager_id,
          o.link_cutting_file, o.link_cutting_image_file, o.link_cad_file, o.link_pdf_file,
          o.total_amount, o.final_amount, o.paid_amount, o.parts_count, o.total_area,
          o.created_at, o.updated_at, o.created_by, o.edited_by, o.version, o.ref_key_1c,
          ${headerSheetSelect}${deletedSelect}
        FROM orders o
        JOIN projects mp ON mp.project_id = o.project_id
        LEFT JOIN clients c ON c.client_id = o.client_id
        LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
        LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id
        LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = o.production_status_id
        ${headerListMetadataJoin}
        ${headerSheetJoin}
        ${where}
        ORDER BY ${orderBy} ${command.query.sortOrder === 'asc' ? 'ASC' : 'DESC'}, o.order_id DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}
      )
      SELECT
        o.*,
        material_projection.material_ids,
        material_projection.material_names,
        basis_projection.basis_projects,
        bazis_cut_projection.bazis_cut_numbers,
        cut_projection.cut_numbers,
        cut_projection.bath_cut_numbers,
        film_projection.film_names,
        material_projection.sheet_material_type_ids,
        milling_projection.milling_type_id,
        milling_projection.milling_type_name,
        latest_doweling.doweling_order_id AS latest_doweling_order_id,
        latest_doweling.doweling_order_name AS latest_doweling_order_name,
        latest_doweling.design_engineer_id AS latest_design_engineer_id,
        production_projection.passed_production_status_codes,
        group_projection.group_links_json
      FROM page_orders o
      LEFT JOIN LATERAL (
        SELECT
          ARRAY_AGG(materials.material_id ORDER BY materials.first_detail_number, materials.first_detail_id) AS material_ids,
          ARRAY_AGG(materials.material_name ORDER BY materials.first_detail_number, materials.first_detail_id) AS material_names,
          ${listSheetTypeIdsAggregate}
        FROM (
          SELECT
            ${this.sheetOrdersReads ? 'NULL::bigint AS material_id,' : 'od.material_id,'}
            ${listDetailSheetIdSelect}
            ${listDetailNameSelect},
            MIN(od.detail_number) AS first_detail_number,
            MIN(od.detail_id) AS first_detail_id
          FROM order_details od
          ${listDetailMaterialJoin}
          ${listDetailSheetJoin}
          WHERE od.order_id = o.order_id AND od.delete_flag = false AND ${listDetailFilter}
          ${listDetailNameGroupBy}
        ) materials
      ) material_projection ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(projects.basis_project ORDER BY projects.first_detail_number, projects.first_detail_id) AS basis_projects
        FROM (
          SELECT DISTINCT ON (LOWER(BTRIM(od.basis_project)))
            BTRIM(od.basis_project) AS basis_project,
            od.detail_number AS first_detail_number,
            od.detail_id AS first_detail_id
          FROM order_details od
          WHERE od.order_id = o.order_id
            AND od.delete_flag = false
            AND NULLIF(BTRIM(od.basis_project), '') IS NOT NULL
          ORDER BY LOWER(BTRIM(od.basis_project)), od.detail_number, od.detail_id
        ) projects
      ) basis_projection ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG('БР-' || sets.bazis_cut_set_id::text ORDER BY sets.bazis_cut_set_id) AS bazis_cut_numbers
        FROM (
          SELECT DISTINCT detail.bazis_cut_set_id
          FROM bazis_cut_set_details detail
          WHERE detail.source_order_id = o.order_id
        ) sets
      ) bazis_cut_projection ON true
      LEFT JOIN LATERAL (
        SELECT
          ARRAY_AGG(cuts.cut_number ORDER BY cuts.cut_job_id)
            FILTER (WHERE cuts.is_vacuum = false) AS cut_numbers,
          ARRAY_AGG(cuts.cut_number ORDER BY cuts.cut_job_id)
            FILTER (WHERE cuts.is_vacuum = true) AS bath_cut_numbers
        FROM (
          SELECT DISTINCT
            cj.cut_job_id,
            cr.result_no,
            CASE
              WHEN COALESCE(
                cj.last_calc_params->>'layout_mode',
                cpp.params->>'layout_mode',
                cj.params->>'layout_mode'
              ) = 'vacuum_table'
                THEN CASE
                  WHEN COALESCE(NULLIF(btrim(cj.source_display_number), ''), cj.cut_job_id::text) LIKE 'В-%'
                    THEN COALESCE(NULLIF(btrim(cj.source_display_number), ''), cj.cut_job_id::text)
                  ELSE 'В-' || COALESCE(NULLIF(btrim(cj.source_display_number), ''), cj.cut_job_id::text)
                END
              ELSE COALESCE(NULLIF(btrim(cj.source_display_number), ''), cj.cut_job_id::text)
            END AS cut_number,
            COALESCE(
              cj.last_calc_params->>'layout_mode',
              cpp.params->>'layout_mode',
              cj.params->>'layout_mode'
            ) = 'vacuum_table' AS is_vacuum
          FROM cut_job_item cji
          JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
          JOIN cut_result cr
            ON cr.cut_result_id = cj.current_cut_result_id
           AND cr.cut_job_id = cj.cut_job_id
          LEFT JOIN cut_result_archive_state archived
            ON archived.cut_job_id = cr.cut_job_id
           AND archived.result_no = cr.result_no
          LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = cj.param_profile_id
          WHERE cji.order_id = o.order_id
            AND cji.is_active = true
            AND cj.status = 'ready'
            AND cj.last_calc_basis IS NOT NULL
            AND archived.cut_job_id IS NULL
        ) cuts
      ) cut_projection ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(films.film_name ORDER BY films.first_detail_number, films.first_detail_id) AS film_names
        FROM (
          SELECT
            f.film_name,
            MIN(od.detail_number) AS first_detail_number,
            MIN(od.detail_id) AS first_detail_id
          FROM order_details od
          INNER JOIN films f ON f.film_id = od.film_id
          WHERE od.order_id = o.order_id AND od.delete_flag = false
          GROUP BY f.film_name
        ) films
      ) film_projection ON true
      LEFT JOIN LATERAL (
        SELECT
          CASE WHEN COUNT(DISTINCT od.milling_type_id) = 1 THEN MIN(od.milling_type_id) END AS milling_type_id,
          CASE WHEN COUNT(DISTINCT od.milling_type_id) = 1 THEN MAX(mt.milling_type_name) END AS milling_type_name
        FROM order_details od
        LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
        WHERE od.order_id = o.order_id AND od.delete_flag = false
      ) milling_projection ON true
      LEFT JOIN LATERAL (
        SELECT
          odl.doweling_order_id,
          d.doweling_order_name,
          d.design_engineer_id
        FROM order_doweling_links odl
        LEFT JOIN doweling_orders d ON d.doweling_order_id = odl.doweling_order_id
        WHERE odl.order_id = o.order_id AND odl.delete_flag = false
        ORDER BY odl.order_doweling_link_id DESC
        LIMIT 1
      ) latest_doweling ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(statuses.production_status_code ORDER BY statuses.sort_order, statuses.production_status_code) AS passed_production_status_codes
        FROM (
          SELECT
            ps.production_status_code,
            MIN(COALESCE(ps.sort_order, 0)) AS sort_order
          FROM (
            SELECT pse.production_status_id
            FROM production_status_events pse
            WHERE pse.order_id = o.order_id
            UNION
            SELECT o.production_status_id
            WHERE o.production_status_id IS NOT NULL
            UNION
            SELECT od.production_status_id
            FROM order_details od
            WHERE od.order_id = o.order_id
              AND od.delete_flag = false
              AND od.production_status_id IS NOT NULL
          ) actual_statuses
          INNER JOIN production_statuses ps ON ps.production_status_id = actual_statuses.production_status_id
          GROUP BY ps.production_status_code
        ) statuses
      ) production_projection ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', p.id::text,
              'code', p.code,
              'name', p.name,
              'relationType', pop.relation_type,
              'isPrimary', pop.is_primary,
              'validFrom', pop.valid_from
            )
            ORDER BY pop.is_primary DESC, pop.relation_type ASC, p.name ASC, p.code ASC
          ),
          '[]'::jsonb
        ) AS group_links_json
        FROM public.group_order_groups pop
        INNER JOIN public.group_groups p ON p.id = pop.group_id
        WHERE pop.order_id = o.order_id
          AND pop.valid_to IS NULL
      ) group_projection ON true
      ORDER BY ${PAGE_SORT_COLUMNS[command.query.sortBy]} ${command.query.sortOrder === 'asc' ? 'ASC' : 'DESC'}, o.order_id DESC
      `,
      params,
    );
    const total = toNumber(count.rows[0]?.total ?? 0);

    return {
      data: rows.rows.map((row) => mapListItem(row, command.query.deleted === true)),
      pagination: {
        page: command.query.page,
        pageSize: command.query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / command.query.pageSize)),
      },
    };
  }

  async getOrderById(command: GetOrderByIdCommand): Promise<OrderDto | null> {
    // SP3: gate migration-029 sheet columns/joins so single-order reads work pre-migration.
    // Variant B (flag-ON): sheet name is smt.name directly — no COALESCE fallback to materials.
    // flag-OFF stays as the legacy pre-migration path (materials join only).
    const headerSheetCols = this.sheetOrdersReads
      ? `o.sheet_material_type_id, o.sheet_eligible,
        smt.name AS material_name,
        NULL::bigint AS material_id,
        o.milling_type_id, o.edge_type_id, o.film_id`
      : `NULL::bigint AS sheet_material_type_id, false AS sheet_eligible,
        m.material_name AS material_name,
        o.material_id,
        o.milling_type_id, o.edge_type_id, o.film_id`;
    const headerSheetJoin = this.sheetOrdersReads
      ? 'LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = o.sheet_material_type_id'
      : '';
    // Variant B: detail name from sheet type only; legacy path still reads materials.
    const detailSheetName = this.sheetOrdersReads
      ? 'smt.name AS material_name'
      : 'm.material_name AS material_name';
    // Variant B: no materials join for header or detail reads (material_id is NULL post-034).
    const headerMaterialJoin = this.sheetOrdersReads
      ? ''
      : 'LEFT JOIN materials m ON m.material_id = o.material_id';
    const detailMaterialJoin = this.sheetOrdersReads
      ? ''
      : 'LEFT JOIN materials m ON m.material_id = od.material_id';
    const detailSheetJoin = this.sheetOrdersReads
      ? 'LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id'
      : '';
    const includeDeleted = command.includeDeleted === true;
    const deletedHeaderSelect = includeDeleted
      ? `,
        o.delete_flag,
        o.deleted_at,
        deleted_by_user.full_name AS deleted_by_name`
      : '';
    const deletedHeaderJoin = includeDeleted
      ? 'LEFT JOIN users deleted_by_user ON deleted_by_user.user_id = o.deleted_by'
      : '';
    const headerMetadataJoin = includeDeleted
      ? [headerMaterialJoin, deletedHeaderJoin].filter((fragment) => fragment.length > 0).join('\n      ')
      : headerMaterialJoin;
    const headerWhere = includeDeleted
      ? 'WHERE o.order_id = $1'
      : 'WHERE o.order_id = $1 AND o.delete_flag = false';
    const headerResult = await this.database.query<OrderHeaderRow>(
      `
      SELECT
        o.order_id, o.order_name, o.client_id, c.client_name,
        o.order_date, o.priority,
        o.order_status_id, os.order_status_name,
        o.payment_status_id, pay_s.payment_status_name,
        o.production_status_id, prod_s.production_status_name,
        o.production_status_from_details_enabled,
        (
          SELECT ARRAY_AGG(statuses.production_status_code ORDER BY statuses.sort_order, statuses.production_status_code)
          FROM (
            SELECT
              ps.production_status_code,
              MIN(COALESCE(ps.sort_order, 0)) AS sort_order
            FROM (
              SELECT pse.production_status_id
              FROM production_status_events pse
              WHERE pse.order_id = o.order_id
              UNION
              SELECT o.production_status_id
              WHERE o.production_status_id IS NOT NULL
              UNION
              SELECT od.production_status_id
              FROM order_details od
              WHERE od.order_id = o.order_id
                AND od.delete_flag = false
                AND od.production_status_id IS NOT NULL
            ) actual_statuses
            INNER JOIN production_statuses ps ON ps.production_status_id = actual_statuses.production_status_id
            GROUP BY ps.production_status_code
          ) statuses
        ) AS passed_production_status_codes,
        o.planned_completion_date, o.completion_date, o.issue_date, o.payment_date,
        o.discount, o.surcharge, o.notes, o.manager_id,
        o.link_cutting_file, o.link_cutting_image_file, o.link_cad_file, o.link_pdf_file,
        o.total_amount, o.final_amount, o.paid_amount, o.parts_count, o.total_area,
        o.created_at, o.updated_at, o.created_by, o.edited_by, o.version, o.ref_key_1c,
        o.hdf_min_threshold_mm,
        ${headerSheetCols}${deletedHeaderSelect}
      FROM orders o
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
      LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id
      LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = o.production_status_id
      ${headerMetadataJoin}
      ${headerSheetJoin}
      ${headerWhere}
      `,
      [command.orderId],
    );
    const header = headerResult.rows[0];

    if (!header) {
      return null;
    }

    // Server-resolved per-detail material name (sheet name only in Variant B) so the caller
    // needs no sheet_materials.view; sheet_material_type_id carried for FE hydration.
    const details = await this.database.query<OrderDetailRow>(
      `
      WITH linked_bazis_project_candidates AS MATERIALIZED (
        SELECT link.order_id,
               project.bazis_project_id,
               revision.bazis_revision_id,
               revision.revision_no,
               project.name,
               substring(
                 btrim(COALESCE(
                   NULLIF(revision.bazis_order_no, ''),
                   (
                     SELECT NULLIF(btrim(root.raw_json->>'Заказ'), '')
                     FROM bazis_nodes root
                     WHERE root.revision_id = revision.bazis_revision_id
                       AND root.parent_node_id IS NULL
                     ORDER BY root.seq, root.bazis_node_id
                     LIMIT 1
                   ),
                   project.name
                 ))
                 from '(?i)(?:№[[:space:]]*)?([0-9]+)'
               ) AS project_no
        FROM bazis_order_links link
        JOIN bazis_project_revisions revision ON revision.bazis_revision_id = link.revision_id
        JOIN bazis_projects project ON project.bazis_project_id = link.bazis_project_id
        WHERE link.order_id = $1
      ),
      linked_bazis_projects AS MATERIALIZED (
        SELECT candidate.*
        FROM linked_bazis_project_candidates candidate
        JOIN (
          SELECT order_id, project_no
          FROM linked_bazis_project_candidates
          WHERE project_no IS NOT NULL
          GROUP BY order_id, project_no
          HAVING count(DISTINCT bazis_project_id) = 1
        ) safe
          ON safe.order_id = candidate.order_id
         AND safe.project_no = candidate.project_no
      ),
      cut_candidates AS (
        SELECT cji.order_detail_id,
               cj.cut_job_id,
               cj.source_display_number,
               cj.name,
               cr.result_no,
               cj.param_profile_id,
               cpp.name AS profile_name,
               cpp.is_active AS profile_is_active,
               COALESCE(
                 cj.last_calc_params->>'layout_mode',
                 cpp.params->>'layout_mode',
                 cj.params->>'layout_mode'
               ) = 'vacuum_table' AS is_vacuum
        FROM cut_job_item cji
        JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
        JOIN cut_result cr
          ON cr.cut_result_id = cj.current_cut_result_id
         AND cr.cut_job_id = cj.cut_job_id
        LEFT JOIN cut_result_archive_state archived
          ON archived.cut_job_id = cr.cut_job_id
         AND archived.result_no = cr.result_no
        LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = cj.param_profile_id
        WHERE cji.order_id = $1
          AND cji.is_active = true
          AND cj.status = 'ready'
          AND cj.last_calc_basis IS NOT NULL
          AND archived.cut_job_id IS NULL
      ),
      ranked_cut AS (
        SELECT *,
               row_number() OVER (
                 PARTITION BY order_detail_id, is_vacuum
                 ORDER BY cut_job_id DESC
               ) AS rn
        FROM cut_candidates
      )
      SELECT od.*,
             ${detailSheetName},
             regular.cut_job_id AS cut_job_id,
             regular.result_no AS cut_result_no,
             regular.source_display_number AS cut_job_source_display_number,
             regular.name AS cut_job_name,
             regular.param_profile_id AS cut_job_param_profile_id,
             regular.profile_name AS cut_job_profile_name,
             regular.profile_is_active AS cut_job_profile_is_active,
             bath.cut_job_id AS bath_cut_job_id,
             bath.result_no AS bath_cut_result_no,
             bath.source_display_number AS bath_cut_job_source_display_number,
             bath.name AS bath_cut_job_name,
             bath.param_profile_id AS bath_cut_job_param_profile_id,
             bath.profile_name AS bath_cut_job_profile_name,
             bath.profile_is_active AS bath_cut_job_profile_is_active,
             COALESCE(
               (SELECT revision.bazis_project_id
                FROM bazis_node_order_detail_map map
                JOIN bazis_nodes node ON node.bazis_node_id = map.node_id
                JOIN bazis_project_revisions revision ON revision.bazis_revision_id = node.revision_id
                WHERE map.order_id = od.order_id
                  AND map.order_detail_id = od.detail_id
                ORDER BY map.created_at DESC, map.bazis_node_order_detail_map_id DESC
                LIMIT 1),
               (SELECT linked.bazis_project_id
                FROM linked_bazis_projects linked
                WHERE linked.order_id = od.order_id
                  AND linked.project_no = substring(
                    btrim(od.basis_project)
                    from '(?i)(?:№[[:space:]]*)?([0-9]+)'
                  )
                ORDER BY linked.revision_no DESC, linked.bazis_project_id
                LIMIT 1)
             ) AS bazis_project_id,
             (SELECT jsonb_agg(jsonb_build_object(
                'bazisCutSetId', refs.bazis_cut_set_id,
                'name', refs.name
              ) ORDER BY refs.bazis_cut_set_id)
              FROM (
                SELECT s.bazis_cut_set_id, s.name
                FROM bazis_cut_set_details d
                JOIN bazis_cut_sets s ON s.bazis_cut_set_id = d.bazis_cut_set_id
                WHERE d.source_order_detail_id = od.detail_id
                UNION
                SELECT s.bazis_cut_set_id, s.name
                FROM bazis_node_order_detail_map detail_map
                JOIN bazis_cut_set_details d ON d.source_bazis_node_id = detail_map.node_id
                JOIN bazis_cut_sets s ON s.bazis_cut_set_id = d.bazis_cut_set_id
                WHERE detail_map.order_id = od.order_id
                  AND detail_map.order_detail_id = od.detail_id
              ) refs) AS bazis_cut_sets
             ,(SELECT jsonb_agg(jsonb_build_object(
                'bazisProjectId', refs.bazis_project_id,
                'bazisRevisionId', refs.bazis_revision_id,
                'revisionNo', refs.revision_no,
                'name', refs.name
              ) ORDER BY refs.bazis_project_id, refs.revision_no)
              FROM (
                SELECT DISTINCT project.bazis_project_id,
                       revision.bazis_revision_id,
                       revision.revision_no,
                       project.name
                FROM bazis_node_order_detail_map detail_map
                JOIN bazis_nodes node ON node.bazis_node_id = detail_map.node_id
                JOIN bazis_project_revisions revision ON revision.bazis_revision_id = node.revision_id
                JOIN bazis_projects project ON project.bazis_project_id = revision.bazis_project_id
                WHERE detail_map.order_id = od.order_id
                  AND detail_map.order_detail_id = od.detail_id
                UNION
                SELECT linked.bazis_project_id,
                       linked.bazis_revision_id,
                       linked.revision_no,
                       linked.name
                FROM linked_bazis_projects linked
                WHERE linked.order_id = od.order_id
                  AND linked.project_no = substring(
                    btrim(od.basis_project)
                    from '(?i)(?:№[[:space:]]*)?([0-9]+)'
                  )
              ) refs) AS bazis_projects
      FROM order_details od
      ${detailMaterialJoin}
      ${detailSheetJoin}
      LEFT JOIN ranked_cut regular
        ON regular.order_detail_id = od.detail_id
       AND regular.is_vacuum = false
       AND regular.rn = 1
      LEFT JOIN ranked_cut bath
        ON bath.order_detail_id = od.detail_id
       AND bath.is_vacuum = true
       AND bath.rn = 1
      WHERE od.order_id = $1 AND od.delete_flag = false
      ORDER BY od.detail_number ASC, od.detail_id ASC
      `,
      [command.orderId],
    );
    const hdfDetails = await this.database.query<OrderHdfDetailRow>(
      `
      WITH cut_candidates AS (
        SELECT cji.order_hdf_detail_id,
               cj.cut_job_id,
               cj.source_display_number,
               cj.name,
               cr.result_no,
               cj.param_profile_id,
               cpp.name AS profile_name,
               cpp.is_active AS profile_is_active
        FROM cut_job_item cji
        JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
        JOIN cut_result cr
          ON cr.cut_result_id = cj.current_cut_result_id
         AND cr.cut_job_id = cj.cut_job_id
        LEFT JOIN cut_result_archive_state archived
          ON archived.cut_job_id = cr.cut_job_id
         AND archived.result_no = cr.result_no
        LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = cj.param_profile_id
        WHERE cji.order_id = $1
          AND cji.source_type = 'order_hdf_detail'
          AND cji.is_active = true
          AND cj.status = 'ready'
          AND cj.last_calc_basis IS NOT NULL
          AND archived.cut_job_id IS NULL
      ),
      ranked_cut AS (
        SELECT *,
               row_number() OVER (
                 PARTITION BY order_hdf_detail_id
                 ORDER BY cut_job_id DESC
               ) AS rn
        FROM cut_candidates
      )
      SELECT h.*,
             state.revision AS current_config_revision,
             (h.config_revision <> state.revision) AS is_stale,
             ps.production_status_name,
             cut.cut_job_id,
             cut.result_no AS cut_result_no,
             cut.source_display_number AS cut_job_source_display_number,
             cut.name AS cut_job_name,
             cut.param_profile_id AS cut_job_param_profile_id,
             cut.profile_name AS cut_job_profile_name,
             cut.profile_is_active AS cut_job_profile_is_active,
             (SELECT jsonb_agg(jsonb_build_object(
                'bazisCutSetId', s.bazis_cut_set_id,
                'name', s.name
              ) ORDER BY s.bazis_cut_set_id)
              FROM bazis_cut_set_details d
              JOIN bazis_cut_sets s ON s.bazis_cut_set_id = d.bazis_cut_set_id
              WHERE d.source_order_hdf_detail_id = h.order_hdf_detail_id) AS bazis_cut_sets
      FROM order_hdf_details h
      CROSS JOIN hdf_calculation_config_state state
      LEFT JOIN production_statuses ps ON ps.production_status_id = h.production_status_id
      LEFT JOIN ranked_cut cut
        ON cut.order_hdf_detail_id = h.order_hdf_detail_id
       AND cut.rn = 1
      WHERE h.order_id = $1 AND h.delete_flag = false
      ORDER BY h.source_detail_number NULLS LAST, h.order_hdf_detail_id
      `,
      [command.orderId],
    );
    const payments = await this.database.query<OrderPaymentRow>(
      `
      SELECT *
      FROM payments
      WHERE order_id = $1 AND delete_flag = false
      ORDER BY payment_date ASC, payment_id ASC
      `,
      [command.orderId],
    );
    const workshops = await this.database.query<OrderWorkshopRow>(
      `
      SELECT *
      FROM order_workshops
      WHERE order_id = $1 AND delete_flag = false
      ORDER BY sequence_order NULLS LAST, order_workshop_id ASC
      `,
      [command.orderId],
    );
    const requirements = await this.database.query<OrderRequirementRow>(
      `
      SELECT *
      FROM order_resource_requirements
      WHERE order_id = $1 AND is_active = true
      ORDER BY requirement_id ASC
      `,
      [command.orderId],
    );
    const dowelingLinks = await this.database.query<OrderDowelingLinkRow>(
      `
      SELECT odl.*, d.doweling_order_name, d.design_engineer_id
      FROM order_doweling_links odl
      LEFT JOIN doweling_orders d ON d.doweling_order_id = odl.doweling_order_id
      WHERE odl.order_id = $1 AND odl.delete_flag = false
      ORDER BY odl.order_doweling_link_id ASC
      `,
      [command.orderId],
    );
    const groupLinks = await this.database.query<OrderGroupLinkRow>(
      `
      SELECT
        p.id::text AS group_id,
        p.code,
        p.name,
        pop.relation_type,
        pop.is_primary,
        pop.valid_from
      FROM public.group_order_groups pop
      INNER JOIN public.group_groups p ON p.id = pop.group_id
      WHERE pop.order_id = $1
        AND pop.valid_to IS NULL
      ORDER BY pop.is_primary DESC, pop.relation_type ASC, p.name ASC, p.code ASC, pop.id ASC
      `,
      [command.orderId],
    );

    return mapOrderDto(
      header,
      details.rows,
      hdfDetails.rows,
      payments.rows,
      workshops.rows,
      requirements.rows,
      dowelingLinks.rows,
      groupLinks.rows.map(mapGroupLinkRow),
      includeDeleted,
    );
  }

  async getOrderAudit(command: GetOrderAuditCommand): Promise<OrderAuditListResponseDto> {
    const orderIdText = String(command.orderId);
    const count = await this.database.query<CountRow>(
      `
      SELECT COUNT(*)::int AS total
      FROM audit_log
      WHERE (entity_type = 'order' AND entity_id = $1)
        OR related_order_id = $2
      `,
      [orderIdText, command.orderId],
    );
    const rows = await this.database.query<AuditLogRow>(
      `
      SELECT
        audit_id, entity_type, entity_id, event, user_id, username, role,
        ip_address, user_agent, request_id, before_json, after_json, diff_json, created_at
      FROM audit_log
      WHERE (entity_type = 'order' AND entity_id = $1)
        OR related_order_id = $2
      ORDER BY created_at DESC, audit_id DESC
      LIMIT $3 OFFSET $4
      `,
      [orderIdText, command.orderId, command.pageSize, (command.page - 1) * command.pageSize],
    );
    const total = toNumber(count.rows[0]?.total ?? 0);

    return {
      data: rows.rows.map(mapAuditEvent),
      pagination: {
        page: command.page,
        pageSize: command.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / command.pageSize)),
      },
      requestId: command.requestId,
    };
  }

  async getOrderFormData(_command: GetOrderFormDataCommand): Promise<OrderFormDataResponseDto> {
    const [
      clients,
      materials,
      millingTypes,
      edgeTypes,
      films,
      orderStatuses,
      paymentStatuses,
      paymentTypes,
      productionStatuses,
      workshops,
      employees,
      units,
      sheetMaterialTypes,
    ] = await Promise.all([
      this.database.query<IdNameLookupRow>(
        `
        SELECT client_id AS id, client_name::text AS name, sort_order
        FROM clients
        WHERE is_active = true
        ORDER BY sort_order ASC, client_name ASC, client_id ASC
        `,
      ),
      this.database.query<MaterialLookupRow>(
        `
        SELECT material_id AS id, material_name AS name, unit_id, sort_order
        FROM materials
        -- SP3 Task 10b: never offer synthetic sheet-shadow materials in the order
        -- form's material dropdown (sheet materials are picked via their own field).
        -- The is_sheet_shadow column only exists after migration 029; the filter is gated
        -- so this lookup works pre-migration (no shadows can exist before 029 anyway).
        WHERE is_active = true${this.sheetOrdersReads ? ' AND is_sheet_shadow = false' : ''}
        ORDER BY sort_order ASC, material_name ASC, material_id ASC
        `,
      ),
      this.database.query<MillingTypeLookupRow>(
        `
        SELECT milling_type_id AS id, milling_type_name AS name, cost_per_sqm, sort_order,
               hdf_enabled, hdf_edge_mm, version
        FROM milling_types
        WHERE is_active = true
        ORDER BY sort_order ASC, milling_type_name ASC, milling_type_id ASC
        `,
      ),
      this.database.query<IdNameLookupRow>(
        `
        SELECT edge_type_id AS id, edge_type_name AS name, sort_order
        FROM edge_types
        WHERE is_active = true
        ORDER BY sort_order ASC, edge_type_name ASC, edge_type_id ASC
        `,
      ),
      this.database.query<IdNameLookupRow>(
        `
        SELECT film_id AS id, film_name AS name, sort_order
        FROM films
        WHERE is_active = true
        ORDER BY sort_order ASC, film_name ASC, film_id ASC
        `,
      ),
      this.database.query<StatusLookupRow>(
        `
        SELECT order_status_id AS id, order_status_name AS name, NULL::text AS code, color, sort_order
        FROM order_statuses
        WHERE is_active = true
        ORDER BY sort_order ASC, order_status_name ASC, order_status_id ASC
        `,
      ),
      this.database.query<StatusLookupRow>(
        `
        SELECT payment_status_id AS id, payment_status_name AS name, NULL::text AS code, color, sort_order
        FROM payment_statuses
        WHERE is_active = true
        ORDER BY sort_order ASC, payment_status_name ASC, payment_status_id ASC
        `,
      ),
      this.database.query<IdNameLookupRow>(
        `
        SELECT type_paid_id AS id, type_paid_name AS name, sort_order
        FROM payment_types
        WHERE is_active = true
        ORDER BY sort_order ASC, type_paid_name ASC, type_paid_id ASC
        `,
      ),
      this.database.query<StatusLookupRow>(
        `
        SELECT production_status_id AS id, production_status_name AS name, production_status_code AS code, color, sort_order
        FROM production_statuses
        WHERE is_active = true
        ORDER BY sort_order ASC, production_status_name ASC, production_status_id ASC
        `,
      ),
      this.database.query<IdNameLookupRow>(
        `
        SELECT workshop_id AS id, workshop_name AS name, sort_order
        FROM workshops
        WHERE is_active = true
        ORDER BY sort_order ASC, workshop_name ASC, workshop_id ASC
        `,
      ),
      this.database.query<EmployeeLookupRow>(
        `
        SELECT employee_id AS id, full_name
        FROM employees
        WHERE is_active = true
        ORDER BY full_name ASC, employee_id ASC
        `,
      ),
      this.database.query<UnitLookupRow>(
        `
        SELECT unit_id AS id, unit_code AS code, COALESCE(unit_name, unit_code) AS name, unit_symbol AS symbol, sort_order
        FROM units
        ORDER BY sort_order ASC, unit_code ASC, unit_id ASC
        `,
      ),
      // SP3: ALL sheet types (active + inactive) — repo stays dumb; the service
      // decides whether to attach them (sheet_materials.view) and the FE disables
      // inactive non-current options so a deactivated-but-selected sheet still edits.
      // Variant B: is_cuttable=false marks header-only materials (e.g. «краска»)
      // the FE DETAIL picker must exclude (HEADER picker keeps the full set).
      this.database.query<SheetMaterialTypeLookupRow>(
        `
        SELECT sheet_material_type_id AS id, name, width_mm, height_mm, is_active, is_cuttable, sort_order
        FROM sheet_material_types
        ORDER BY is_active DESC, sort_order ASC, name ASC, sheet_material_type_id ASC
        `,
      ),
    ]);

    return {
      clients: clients.rows.map(mapIdNameLookup),
      materials: materials.rows.map(mapMaterialLookup),
      millingTypes: millingTypes.rows.map(mapMillingTypeLookup),
      edgeTypes: edgeTypes.rows.map(mapIdNameLookup),
      films: films.rows.map(mapIdNameLookup),
      orderStatuses: orderStatuses.rows.map(mapStatusLookup),
      paymentStatuses: paymentStatuses.rows.map(mapStatusLookup),
      paymentTypes: paymentTypes.rows.map(mapIdNameLookup),
      productionStatuses: productionStatuses.rows.map(mapStatusLookup),
      workshops: workshops.rows.map(mapIdNameLookup),
      employees: employees.rows.map(mapEmployeeLookup),
      units: units.rows.map(mapUnitLookup),
      sheetMaterialTypes: sheetMaterialTypes.rows.map(mapSheetMaterialTypeLookup),
    };
  }

  async getNextOrderName(): Promise<string> {
    const result = await this.database.query<{ next_order_name: string }>(
      `
      SELECT (COALESCE(MAX(order_name::bigint), 0) + 1)::text AS next_order_name
      FROM orders
      WHERE order_name ~ '^\\d{1,15}$'
        AND delete_flag = false
        AND order_date >= DATE '2025-12-01'
      `,
    );

    return result.rows[0]?.next_order_name ?? '1';
  }

  private buildListWhere(command: ListOrdersCommand, params: unknown[]): string {
    const clauses = [command.query.deleted === true ? 'o.delete_flag = true' : 'o.delete_flag = false'];

    if (command.query.deleted === true && command.query.deletedScopeUserId) {
      const deletedScopeUserIdIndex = params.push(Number(command.query.deletedScopeUserId));
      clauses.push(`(o.created_by = $${deletedScopeUserIdIndex} OR o.manager_id = $${deletedScopeUserIdIndex})`);
    }

    if (command.query.search) {
      const search = parseOrderSearchInput(command.query.search);
      const plainIndex = params.push(`%${search.plain}%`);
      const searchClauses = [
        `o.order_name ILIKE $${plainIndex}`,
        `c.client_name::text ILIKE $${plainIndex}`,
      ];

      if (search.codePrefix !== null) {
        searchClauses.push(`mp.code ILIKE $${params.push(`${search.codePrefix}%`)}`);
        // Dash-split of a full number is ambiguous when the order name (or the
        // code) contains dashes — match the composed full number directly too.
        // Numeric-only input stays out (codePrefix === null) so plain numbers
        // keep matching order/client names only, never project codes.
        searchClauses.push(`(mp.code || '-' || o.order_name) ILIKE $${plainIndex}`);
      }

      if (search.codeExact !== null && search.namePrefix !== null) {
        const codeExactIndex = params.push(search.codeExact);
        const namePrefixIndex = params.push(`${search.namePrefix}%`);
        searchClauses.push(`(mp.code = $${codeExactIndex} AND o.order_name ILIKE $${namePrefixIndex})`);
      }

      clauses.push(`(${searchClauses.join(' OR ')})`);
    }

    if (command.query.clientId) {
      clauses.push(`o.client_id = $${params.push(command.query.clientId)}`);
    }

    if (command.query.projectId) {
      clauses.push(`o.project_id = $${params.push(command.query.projectId)}`);
    }

    if (command.query.orderStatusId) {
      clauses.push(`o.order_status_id = $${params.push(command.query.orderStatusId)}`);
    }

    if (command.query.paymentStatusId) {
      clauses.push(`o.payment_status_id = $${params.push(command.query.paymentStatusId)}`);
    }

    if (command.query.productionStatusId) {
      clauses.push(`o.production_status_id = $${params.push(command.query.productionStatusId)}`);
    }

    if (command.query.dateFrom) {
      clauses.push(`o.order_date >= $${params.push(command.query.dateFrom)}`);
    }

    if (command.query.dateTo) {
      clauses.push(`o.order_date <= $${params.push(command.query.dateTo)}`);
    }

    if (command.query.plannedCompletionDateFrom) {
      clauses.push(
        `o.planned_completion_date >= $${params.push(command.query.plannedCompletionDateFrom)}`,
      );
    }

    if (command.query.plannedCompletionDateTo) {
      clauses.push(
        `o.planned_completion_date <= $${params.push(command.query.plannedCompletionDateTo)}`,
      );
    }

    if (command.query.onlyMyOrders) {
      clauses.push(`o.manager_id = $${params.push(Number(command.currentUser.id))}`);
    }

    if (command.query.groupMode === 'none') {
      clauses.push(`
        NOT EXISTS (
          SELECT 1
          FROM public.group_order_groups pop_filter
          WHERE pop_filter.order_id = o.order_id
            AND pop_filter.valid_to IS NULL
        )
      `);
    } else if (command.query.groupIds?.length) {
      const groupIdsIndex = params.push(command.query.groupIds);
      if (command.query.groupMode === 'all') {
        clauses.push(`
          (
            SELECT COUNT(DISTINCT pop_filter.group_id)::int
            FROM public.group_order_groups pop_filter
            WHERE pop_filter.order_id = o.order_id
              AND pop_filter.valid_to IS NULL
              AND pop_filter.group_id = ANY($${groupIdsIndex}::uuid[])
          ) = ${command.query.groupIds.length}
        `);
      } else if (command.query.groupMode === 'primary') {
        clauses.push(`
          EXISTS (
            SELECT 1
            FROM public.group_order_groups pop_filter
            WHERE pop_filter.order_id = o.order_id
              AND pop_filter.valid_to IS NULL
              AND pop_filter.is_primary
              AND pop_filter.group_id = ANY($${groupIdsIndex}::uuid[])
          )
        `);
      } else {
        clauses.push(`
          EXISTS (
            SELECT 1
            FROM public.group_order_groups pop_filter
            WHERE pop_filter.order_id = o.order_id
              AND pop_filter.valid_to IS NULL
              AND pop_filter.group_id = ANY($${groupIdsIndex}::uuid[])
          )
        `);
      }
    }

    return `WHERE ${clauses.join(' AND ')}`;
  }
}

function mapIdNameLookup(row: IdNameLookupRow) {
  return {
    id: toNumber(row.id),
    name: row.name,
    sortOrder: toNumber(row.sort_order),
  };
}

function mapMaterialLookup(row: MaterialLookupRow) {
  return {
    id: toNumber(row.id),
    name: row.name,
    unitId: toNullableNumber(row.unit_id),
    sortOrder: toNumber(row.sort_order),
  };
}

function mapMillingTypeLookup(row: MillingTypeLookupRow) {
  return {
    id: toNumber(row.id),
    name: row.name,
    costPerSqm: toNullableNumber(row.cost_per_sqm),
    hdfEnabled: row.hdf_enabled === true,
    hdfEdgeMm: toNullableNumber(row.hdf_edge_mm),
    version: toNumber(row.version ?? 0),
    sortOrder: toNumber(row.sort_order),
  };
}

function mapStatusLookup(row: StatusLookupRow) {
  return {
    id: toNumber(row.id),
    name: row.name,
    code: row.code,
    color: row.color,
    sortOrder: toNumber(row.sort_order),
  };
}

function mapSheetMaterialTypeLookup(row: SheetMaterialTypeLookupRow) {
  return {
    id: toNumber(row.id),
    name: row.name,
    widthMm: toNullableNumber(row.width_mm),
    heightMm: toNullableNumber(row.height_mm),
    isActive: row.is_active,
    isCuttable: row.is_cuttable,
    sortOrder: toNumber(row.sort_order),
  };
}

function mapEmployeeLookup(row: EmployeeLookupRow) {
  return {
    id: toNumber(row.id),
    fullName: row.full_name,
  };
}

function mapUnitLookup(row: UnitLookupRow) {
  return {
    id: toNumber(row.id),
    code: row.code,
    name: row.name,
    ...(row.symbol ? { symbol: row.symbol } : {}),
    sortOrder: toNumber(row.sort_order),
  };
}

function mapAuditEvent(row: AuditLogRow): OrderAuditEventDto {
  return {
    auditId: row.audit_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.event,
    userId: toNullableNumber(row.user_id),
    username: row.username,
    role: row.role,
    before: row.before_json,
    after: row.after_json,
    diff: row.diff_json,
    requestId: row.request_id,
    ip: row.ip_address,
    userAgent: row.user_agent,
    createdAt: toIsoString(row.created_at),
  };
}

function mapOrderDto(
  row: OrderHeaderRow,
  details: OrderDetailRow[],
  hdfDetails: OrderHdfDetailRow[],
  payments: OrderPaymentRow[],
  workshops: OrderWorkshopRow[],
  requirements: OrderRequirementRow[],
  dowelingLinks: OrderDowelingLinkRow[],
  groups: OrderGroupSummaryDto[],
  includeDeleted: boolean = false,
): OrderDto {
  return {
    header: {
      orderId: toNumber(row.order_id),
      orderName: row.order_name,
      clientId: toNumber(row.client_id),
      clientName: row.client_name,
      orderDate: toDateOnly(row.order_date) ?? '',
      priority: toNumber(row.priority),
      managerId: toNullableNumber(row.manager_id),
      orderStatusId: toNumber(row.order_status_id),
      orderStatusName: row.order_status_name ?? '',
      paymentStatusId: toNumber(row.payment_status_id),
      paymentStatusName: row.payment_status_name ?? '',
      productionStatusId: toNullableNumber(row.production_status_id),
      productionStatusName: row.production_status_name,
      productionStatusFromDetailsEnabled: row.production_status_from_details_enabled,
      passedProductionStatusCodes: toStringArray(row.passed_production_status_codes),
      plannedCompletionDate: toDateOnly(row.planned_completion_date),
      completionDate: toDateOnly(row.completion_date),
      issueDate: toDateOnly(row.issue_date),
      paymentDate: toDateOnly(row.payment_date),
      discount: toNumber(row.discount),
      surcharge: toNumber(row.surcharge),
      totalAmount: toNumber(row.total_amount),
      finalAmount: toNumber(row.final_amount),
      paidAmount: toNumber(row.paid_amount),
      partsCount: toNumber(row.parts_count),
      totalArea: toNumber(row.total_area),
      linkCuttingFile: row.link_cutting_file,
      linkCuttingImageFile: row.link_cutting_image_file,
      linkCadFile: row.link_cad_file,
      linkPdfFile: row.link_pdf_file,
      notes: row.notes,
      refKey1c: row.ref_key_1c,
      sheetMaterialTypeId: toNullableNumber(row.sheet_material_type_id),
      sheetEligible: row.sheet_eligible ?? false,
      materialName: row.material_name ?? null,
      // Variant B: materialId is null post-034 (flag-ON); preserved from o.material_id in flag-OFF.
      materialId: toNullableNumber(row.material_id),
      millingTypeId: toNullableNumber(row.milling_type_id),
      edgeTypeId: toNullableNumber(row.edge_type_id),
      filmId: toNullableNumber(row.film_id),
      hdfMinThresholdMm: toNullableNumber(row.hdf_min_threshold_mm),
      ...(includeDeleted
        ? {
            deleteFlag: row.delete_flag,
            deletedAt: row.deleted_at === null ? null : toIsoString(row.deleted_at),
            deletedByName: row.deleted_by_name ?? null,
          }
        : {}),
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
      createdBy: toNullableNumber(row.created_by),
      editedBy: toNullableNumber(row.edited_by),
      version: toNumber(row.version),
    },
    details: details.map(mapDetail),
    hdfDetails: hdfDetails.map(mapHdfDetail),
    payments: payments.map(mapPayment),
    workshops: workshops.map(mapWorkshop),
    requirements: requirements.map(mapRequirement),
    dowelingLinks: dowelingLinks.map(mapDowelingLink),
    primaryGroup: groups.find((group) => group.isPrimary) ?? null,
    groups,
    totals: {
      totalAmount: toNumber(row.total_amount),
      finalAmount: toNumber(row.final_amount),
      paidAmount: toNumber(row.paid_amount),
      debtAmount: roundMoney(toNumber(row.final_amount) - toNumber(row.paid_amount)),
      partsCount: toNumber(row.parts_count),
      totalArea: toNumber(row.total_area),
    },
    version: toNumber(row.version),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    createdBy: toNullableNumber(row.created_by),
    editedBy: toNullableNumber(row.edited_by),
  };
}

function mapListItem(row: OrderHeaderRow, includeDeleted: boolean = false): OrderListItemDto {
  const groups = mapGroupSummaryArray(row.group_links_json);
  return {
    orderId: toNumber(row.order_id),
    orderName: row.order_name,
    projectId: toNumber(row.project_id),
    projectCode: row.project_code,
    fullNumber: row.full_number,
    clientId: toNumber(row.client_id),
    clientName: row.client_name,
    orderDate: toDateOnly(row.order_date) ?? '',
    plannedCompletionDate: toDateOnly(row.planned_completion_date),
    completionDate: toDateOnly(row.completion_date),
    issueDate: toDateOnly(row.issue_date),
    paymentDate: toDateOnly(row.payment_date),
    orderStatusId: toNumber(row.order_status_id),
    orderStatusName: row.order_status_name ?? '',
    paymentStatusId: toNumber(row.payment_status_id),
    paymentStatusName: row.payment_status_name ?? '',
    productionStatusId: toNullableNumber(row.production_status_id),
    productionStatusName: row.production_status_name,
    priority: toNumber(row.priority),
    totalAmount: toNumber(row.total_amount),
    discount: toNumber(row.discount),
    surcharge: toNumber(row.surcharge),
    finalAmount: toNumber(row.final_amount),
    paidAmount: toNumber(row.paid_amount),
    debtAmount: roundMoney(toNumber(row.final_amount) - toNumber(row.paid_amount)),
    partsCount: toNumber(row.parts_count),
    totalArea: toNumber(row.total_area),
    managerId: toNullableNumber(row.manager_id),
    notes: row.notes,
    // Variant B: materialIds is empty (material_id is NULL post-034); sheetMaterialTypeIds is authoritative.
    materialIds: toNumberArray(row.material_ids),
    materialNames: toStringArray(row.material_names),
    basisProjects: toStringArray(row.basis_projects),
    bazisCutNumbers: toStringArray(row.bazis_cut_numbers),
    cutNumbers: toStringArray(row.cut_numbers),
    bathCutNumbers: toStringArray(row.bath_cut_numbers),
    filmNames: toStringArray(row.film_names),
    sheetMaterialTypeIds: toNumberArray(row.sheet_material_type_ids),
    headerMaterialName: row.header_material_name ?? null,
    headerSheetMaterialTypeId: toNullableNumber(row.header_sheet_material_type_id),
    millingTypeId: toNullableNumber(row.milling_type_id),
    millingTypeName: row.milling_type_name,
    dowelingOrderId: toNullableNumber(row.latest_doweling_order_id),
    dowelingOrderName: row.latest_doweling_order_name,
    designEngineerId: toNullableNumber(row.latest_design_engineer_id),
    passedProductionStatusCodes: toStringArray(row.passed_production_status_codes),
    primaryGroup: groups.find((group) => group.isPrimary) ?? null,
    groups,
    createdBy: toNullableNumber(row.created_by),
    editedBy: toNullableNumber(row.edited_by),
    ...(includeDeleted
      ? {
          deletedAt: row.deleted_at === null ? null : toIsoString(row.deleted_at),
          deletedBy: toNullableNumber(row.deleted_by),
          deletedByName: row.deleted_by_name ?? null,
        }
      : {}),
    updatedAt: toIsoString(row.updated_at),
    version: toNumber(row.version),
  };
}

function mapDetail(row: OrderDetailRow) {
  return {
    id: toNumber(row.detail_id),
    orderId: toNumber(row.order_id),
    detailNumber: toNumber(row.detail_number),
    detailName: row.detail_name,
    height: toNumber(row.height),
    width: toNumber(row.width),
    quantity: toNumber(row.quantity),
    area: toNumber(row.area),
    // Variant B: material_id is NULL post-034; null-safe to avoid 0/NaN.
    materialId: row.material_id == null ? null : toNumber(row.material_id),
    sheetMaterialTypeId: toNullableNumber(row.sheet_material_type_id),
    materialName: row.material_name ?? null,
    millingTypeId: toNumber(row.milling_type_id),
    hdfParameterOverrideMm: toNullableNumber(row.hdf_parameter_override_mm),
    edgeTypeId: toNumber(row.edge_type_id),
    filmId: toNullableNumber(row.film_id),
    millingCostPerSqm: toNullableNumber(row.milling_cost_per_sqm),
    detailCost: toNumber(row.detail_cost),
    priority: toNumber(row.priority),
    productionStatusId: toNullableNumber(row.production_status_id),
    jointOrderId: toNullableNumber(row.joint_order_id),
    note: row.note,
    basisProject: row.basis_project,
    bazisProjectId: toNullableNumber(row.bazis_project_id),
    basisProduct: row.basis_product,
    basisData: row.basis_data,
    basisDesignation: row.basis_designation,
    doweling: row.doweling === true,
    linkCuttingFile: row.link_cutting_file,
    linkCuttingImageFile: row.link_cutting_image_file,
    linkCadFile: row.link_cad_file,
    linkPdfFile: row.link_pdf_file,
    refKey1c: row.ref_key_1c,
    cutJob: mapDetailCutJob(row, 'cut'),
    bathCutJob: mapDetailCutJob(row, 'bath'),
    bazisCutSets: mapBazisCutSetRefs(row.bazis_cut_sets),
    bazisProjects: mapBazisProjectRefs(row.bazis_projects),
  };
}

function mapHdfDetail(row: OrderHdfDetailRow) {
  return {
    id: toNumber(row.order_hdf_detail_id),
    orderId: toNumber(row.order_id),
    sourceOrderDetailId: toNullableNumber(row.source_order_detail_id),
    sourceOrderDetailIdSnapshot: toNumber(row.source_order_detail_id_snapshot),
    sourceDetailNumber: toNullableNumber(row.source_detail_number),
    sourceDetailName: row.source_detail_name,
    sourceHeightMm: toNullableNumber(row.source_height_mm),
    sourceWidthMm: toNullableNumber(row.source_width_mm),
    sourceQuantity: toNullableNumber(row.source_quantity),
    millingTypeId: toNullableNumber(row.milling_type_id),
    millingTypeName: row.milling_type_name,
    edgeMm: toNullableNumber(row.edge_mm),
    thresholdMm: toNullableNumber(row.threshold_mm),
    hdfSheetMaterialTypeId: toNullableNumber(row.hdf_sheet_material_type_id),
    hdfSheetMaterialName: row.hdf_sheet_material_name,
    hdfHeightMm: toNullableNumber(row.hdf_height_mm),
    hdfWidthMm: toNullableNumber(row.hdf_width_mm),
    quantity: toNullableNumber(row.quantity),
    areaM2: toNumber(row.area_m2 ?? 0),
    status: row.status,
    configErrors: readStringArray(row.config_errors),
    configRevision: toNumber(row.config_revision),
    isStale: row.is_stale === true,
    productionStatusId: toNullableNumber(row.production_status_id),
    productionStatusName: row.production_status_name,
    productionStatusLocked: row.production_status_locked === true,
    version: toNumber(row.version),
    cutJob: mapHdfCutJob(row),
    bazisCutSets: mapBazisCutSetRefs(row.bazis_cut_sets),
  };
}

function mapHdfCutJob(row: OrderHdfDetailRow) {
  const cutJobId = toNullableNumber(row.cut_job_id);
  const resultNo = toNullableNumber(row.cut_result_no);
  if (cutJobId === null || resultNo === null) return null;
  return {
    cutJobId,
    resultNo,
    cutNumber: formatCutJobNumber(cutJobId, false, row.cut_job_source_display_number),
    name: row.cut_job_name ?? '',
    paramProfileId: toNullableNumber(row.cut_job_param_profile_id),
    profileName: row.cut_job_profile_name,
    profileIsActive: row.cut_job_profile_is_active,
  };
}

function mapBazisCutSetRefs(value: unknown): Array<{ bazisCutSetId: number; name: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (entry == null || typeof entry !== 'object') return [];
      const candidate = entry as Record<string, unknown>;
      const bazisCutSetId = Number(candidate.bazisCutSetId);
      if (!Number.isInteger(bazisCutSetId) || bazisCutSetId <= 0) return [];
      return [{
        bazisCutSetId,
        name: typeof candidate.name === 'string' ? candidate.name : '',
      }];
    })
    .sort((left, right) => left.bazisCutSetId - right.bazisCutSetId);
}

function mapBazisProjectRefs(value: unknown): Array<{
  bazisProjectId: number;
  bazisRevisionId: number;
  revisionNo: number;
  name: string;
}> {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (entry == null || typeof entry !== 'object') return [];
      const candidate = entry as Record<string, unknown>;
      const bazisProjectId = Number(candidate.bazisProjectId);
      const bazisRevisionId = Number(candidate.bazisRevisionId);
      const revisionNo = Number(candidate.revisionNo);
      if (
        !Number.isInteger(bazisProjectId) || bazisProjectId <= 0 ||
        !Number.isInteger(bazisRevisionId) || bazisRevisionId <= 0 ||
        !Number.isInteger(revisionNo) || revisionNo <= 0
      ) return [];
      return [{
        bazisProjectId,
        bazisRevisionId,
        revisionNo,
        name: typeof candidate.name === 'string' ? candidate.name : '',
      }];
    })
    .sort((left, right) => left.bazisProjectId - right.bazisProjectId || left.revisionNo - right.revisionNo);
}

function mapDetailCutJob(row: OrderDetailRow, kind: 'cut' | 'bath') {
  const cutJobId = toNullableNumber(kind === 'cut' ? row.cut_job_id : row.bath_cut_job_id);
  const resultNo = toNullableNumber(kind === 'cut' ? row.cut_result_no : row.bath_cut_result_no);
  if (cutJobId == null || resultNo == null) return null;
  const name = kind === 'cut' ? row.cut_job_name : row.bath_cut_job_name;
  const sourceDisplayNumber = kind === 'cut' ? row.cut_job_source_display_number : row.bath_cut_job_source_display_number;
  return {
    cutJobId,
    resultNo,
    cutNumber: formatCutJobNumber(cutJobId, kind === 'bath', sourceDisplayNumber),
    name: name ?? `Раскрой ${cutJobId}`,
    paramProfileId: toNullableNumber(kind === 'cut' ? row.cut_job_param_profile_id : row.bath_cut_job_param_profile_id),
    profileName: kind === 'cut' ? row.cut_job_profile_name : row.bath_cut_job_profile_name,
    profileIsActive: kind === 'cut' ? row.cut_job_profile_is_active : row.bath_cut_job_profile_is_active,
  };
}

function mapPayment(row: OrderPaymentRow) {
  return {
    id: toNumber(row.payment_id),
    orderId: toNumber(row.order_id),
    typePaidId: toNumber(row.type_paid_id),
    amount: toNumber(row.amount),
    paymentDate: toDateOnly(row.payment_date) ?? '',
    notes: row.notes,
    refKey1c: row.ref_key_1c,
  };
}

function mapWorkshop(row: OrderWorkshopRow) {
  return {
    id: toNumber(row.order_workshop_id),
    orderId: toNumber(row.order_id),
    workshopId: toNumber(row.workshop_id),
    productionStatusId: toNumber(row.production_status_id),
    receivedDate: toIsoNullable(row.received_date),
    startedDate: toIsoNullable(row.started_date),
    completedDate: toIsoNullable(row.completed_date),
    plannedCompletionDate: toDateOnly(row.planned_completion_date),
    sequenceOrder: toNullableNumber(row.sequence_order),
    responsibleEmployeeId: toNullableNumber(row.responsible_employee_id),
    notes: row.notes,
    refKey1c: row.ref_key_1c,
  };
}

function mapRequirement(row: OrderRequirementRow) {
  return {
    id: toNumber(row.requirement_id),
    orderId: toNumber(row.order_id),
    resourceType: row.resource_type,
    materialId: toNullableNumber(row.material_id),
    filmId: toNullableNumber(row.film_id),
    edgeTypeId: toNullableNumber(row.edge_type_id),
    requiredQuantity: toNumber(row.required_quantity),
    unitId: toNumber(row.unit_id),
    wastePercentage: toNullableNumber(row.waste_percentage),
    finalQuantity: toNullableNumber(row.final_quantity),
    requirementStatusId: toNumber(row.requirement_status_id),
    supplierId: toNullableNumber(row.supplier_id),
    purchasePrice: toNullableNumber(row.purchase_price),
    requisitionId: toNullableNumber(row.requisition_id),
    warehouseId: toNullableNumber(row.warehouse_id),
    reservedAt: toIsoNullable(row.reserved_at),
    consumedAt: toIsoNullable(row.consumed_at),
    notes: row.notes,
    calculationDetails:
      row.calculation_details === null || row.calculation_details === undefined
        ? null
        : JSON.stringify(row.calculation_details),
    refKey1c: row.ref_key_1c,
  };
}

function mapDowelingLink(row: OrderDowelingLinkRow) {
  const dowelingOrderId = toNumber(row.doweling_order_id);
  const designEngineerId = toNullableNumber(row.design_engineer_id);

  return {
    id: toNumber(row.order_doweling_link_id),
    orderId: toNumber(row.order_id),
    dowelingOrderId,
    designEngineerId,
    refKey1c: row.ref_key_1c,
    dowelingOrder: {
      id: dowelingOrderId,
      name: row.doweling_order_name,
      designEngineerId,
    },
  };
}

function mapGroupLinkRow(row: OrderGroupLinkRow): OrderGroupSummaryDto {
  return {
    id: row.group_id,
    code: row.code,
    name: row.name,
    relationType: row.relation_type,
    isPrimary: row.is_primary,
    validFrom: toIsoString(row.valid_from),
  };
}

function mapGroupSummaryArray(value: unknown): OrderGroupSummaryDto[] {
  const parsed = typeof value === 'string' ? parseJsonArray(value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      if (
        typeof record.id !== 'string' ||
        typeof record.code !== 'string' ||
        typeof record.name !== 'string' ||
        typeof record.relationType !== 'string'
      ) {
        return null;
      }
      return {
        id: record.id,
        code: record.code,
        name: record.name,
        relationType: record.relationType as OrderGroupRelationType,
        isPrimary: Boolean(record.isPrimary),
        validFrom:
          record.validFrom instanceof Date
            ? record.validFrom.toISOString()
            : String(record.validFrom ?? ''),
      };
    })
    .filter((item): item is OrderGroupSummaryDto => item !== null);
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  return Number(value);
}

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return Number(value);
}

function toNumberArray(value: unknown[] | null | undefined): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toNullableNumber(item as string | number | null | undefined))
    .filter((item): item is number => item !== null && Number.isFinite(item));
}

function toStringArray(value: unknown[] | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (item === null || item === undefined ? '' : String(item).trim()))
    .filter((item) => item.length > 0);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item === null || item === undefined ? '' : String(item).trim()))
    .filter((item) => item.length > 0);
}

function toDateOnly(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return value.slice(0, 10);
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function toIsoNullable(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return toIsoString(value);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
