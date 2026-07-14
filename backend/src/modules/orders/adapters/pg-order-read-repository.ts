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
} from '../application/order-query.types';

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
  sheet_eligible: boolean | null;
  material_name: string | null;
  header_material_name: string | null;
  header_sheet_material_type_id: string | number | null;
  material_ids: unknown[] | null;
  material_names: unknown[] | null;
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
  edge_type_id: string | number;
  film_id: string | number | null;
  milling_cost_per_sqm: string | number | null;
  detail_cost: string | number | null;
  priority: string | number | null;
  production_status_id: string | number | null;
  joint_order_id: string | number | null;
  note: string | null;
  basis_project: string | null;
  basis_product: string | null;
  basis_data: string | null;
  basis_designation: string | null;
  doweling: boolean;
  link_cutting_file: string | null;
  link_cutting_image_file: string | null;
  link_cad_file: string | null;
  link_pdf_file: string | null;
  ref_key_1c: string | null;
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
}

interface MaterialLookupRow extends IdNameLookupRow {
  unit_id: string | number | null;
}

interface MillingTypeLookupRow extends IdNameLookupRow {
  cost_per_sqm: string | number | null;
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
}

export class PgOrderReadRepository implements OrderReadRepositoryPort {
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
        ${deletedJoin}
        ${headerListMaterialJoin}
        ${headerSheetJoin}
        ${where}
        ORDER BY ${orderBy} ${command.query.sortOrder === 'asc' ? 'ASC' : 'DESC'}, o.order_id DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}
      )
      SELECT
        o.*,
        material_projection.material_ids,
        material_projection.material_names,
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
        SELECT ARRAY_AGG(events.production_status_code ORDER BY events.sort_order, events.production_status_code) AS passed_production_status_codes
        FROM (
          SELECT
            ps.production_status_code,
            MIN(COALESCE(ps.sort_order, 0)) AS sort_order
          FROM production_status_events pse
          INNER JOIN production_statuses ps ON ps.production_status_id = pse.production_status_id
          WHERE pse.order_id = o.order_id
          GROUP BY ps.production_status_code
        ) events
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
        o.planned_completion_date, o.completion_date, o.issue_date, o.payment_date,
        o.discount, o.surcharge, o.notes, o.manager_id,
        o.link_cutting_file, o.link_cutting_image_file, o.link_cad_file, o.link_pdf_file,
        o.total_amount, o.final_amount, o.paid_amount, o.parts_count, o.total_area,
        o.created_at, o.updated_at, o.created_by, o.edited_by, o.version, o.ref_key_1c,
        ${headerSheetCols}${deletedHeaderSelect}
      FROM orders o
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
      LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id
      LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = o.production_status_id
      ${deletedHeaderJoin}
      ${headerMaterialJoin}
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
      SELECT od.*,
             ${detailSheetName}
      FROM order_details od
      ${detailMaterialJoin}
      ${detailSheetJoin}
      WHERE od.order_id = $1 AND od.delete_flag = false
      ORDER BY od.detail_number ASC, od.detail_id ASC
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
        SELECT client_id AS id, client_name::text AS name
        FROM clients
        WHERE is_active = true
        ORDER BY client_name ASC, client_id ASC
        `,
      ),
      this.database.query<MaterialLookupRow>(
        `
        SELECT material_id AS id, material_name AS name, unit_id
        FROM materials
        -- SP3 Task 10b: never offer synthetic sheet-shadow materials in the order
        -- form's material dropdown (sheet materials are picked via their own field).
        -- The is_sheet_shadow column only exists after migration 029; the filter is gated
        -- so this lookup works pre-migration (no shadows can exist before 029 anyway).
        WHERE is_active = true${this.sheetOrdersReads ? ' AND is_sheet_shadow = false' : ''}
        ORDER BY material_name ASC, material_id ASC
        `,
      ),
      this.database.query<MillingTypeLookupRow>(
        `
        SELECT milling_type_id AS id, milling_type_name AS name, cost_per_sqm
        FROM milling_types
        WHERE is_active = true
        ORDER BY sort_order ASC, milling_type_name ASC, milling_type_id ASC
        `,
      ),
      this.database.query<IdNameLookupRow>(
        `
        SELECT edge_type_id AS id, edge_type_name AS name
        FROM edge_types
        WHERE is_active = true
        ORDER BY sort_order ASC, edge_type_name ASC, edge_type_id ASC
        `,
      ),
      this.database.query<IdNameLookupRow>(
        `
        SELECT film_id AS id, film_name AS name
        FROM films
        WHERE is_active = true
        ORDER BY film_name ASC, film_id ASC
        `,
      ),
      this.database.query<StatusLookupRow>(
        `
        SELECT order_status_id AS id, order_status_name AS name, NULL::text AS code, color
        FROM order_statuses
        WHERE is_active = true
        ORDER BY sort_order ASC, order_status_name ASC, order_status_id ASC
        `,
      ),
      this.database.query<StatusLookupRow>(
        `
        SELECT payment_status_id AS id, payment_status_name AS name, NULL::text AS code, color
        FROM payment_statuses
        WHERE is_active = true
        ORDER BY sort_order ASC, payment_status_name ASC, payment_status_id ASC
        `,
      ),
      this.database.query<IdNameLookupRow>(
        `
        SELECT type_paid_id AS id, type_paid_name AS name
        FROM payment_types
        WHERE is_active = true
        ORDER BY sort_order ASC, type_paid_name ASC, type_paid_id ASC
        `,
      ),
      this.database.query<StatusLookupRow>(
        `
        SELECT production_status_id AS id, production_status_name AS name, production_status_code AS code, color
        FROM production_statuses
        WHERE is_active = true
        ORDER BY sort_order ASC, production_status_name ASC, production_status_id ASC
        `,
      ),
      this.database.query<IdNameLookupRow>(
        `
        SELECT workshop_id AS id, workshop_name AS name
        FROM workshops
        WHERE is_active = true
        ORDER BY workshop_name ASC, workshop_id ASC
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
        SELECT unit_id AS id, unit_code AS code, COALESCE(unit_name, unit_code) AS name, unit_symbol AS symbol
        FROM units
        ORDER BY unit_code ASC, unit_id ASC
        `,
      ),
      // SP3: ALL sheet types (active + inactive) — repo stays dumb; the service
      // decides whether to attach them (sheet_materials.view) and the FE disables
      // inactive non-current options so a deactivated-but-selected sheet still edits.
      // Variant B: is_cuttable=false marks header-only materials (e.g. «краска»)
      // the FE DETAIL picker must exclude (HEADER picker keeps the full set).
      this.database.query<SheetMaterialTypeLookupRow>(
        `
        SELECT sheet_material_type_id AS id, name, width_mm, height_mm, is_active, is_cuttable
        FROM sheet_material_types
        ORDER BY is_active DESC, name ASC, sheet_material_type_id ASC
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

  private buildListWhere(command: ListOrdersCommand, params: unknown[]): string {
    const clauses = [command.query.deleted === true ? 'o.delete_flag = true' : 'o.delete_flag = false'];

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
  };
}

function mapMaterialLookup(row: MaterialLookupRow) {
  return {
    id: toNumber(row.id),
    name: row.name,
    unitId: toNullableNumber(row.unit_id),
  };
}

function mapMillingTypeLookup(row: MillingTypeLookupRow) {
  return {
    id: toNumber(row.id),
    name: row.name,
    costPerSqm: toNullableNumber(row.cost_per_sqm),
  };
}

function mapStatusLookup(row: StatusLookupRow) {
  return {
    id: toNumber(row.id),
    name: row.name,
    code: row.code,
    color: row.color,
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
      paymentStatusId: toNumber(row.payment_status_id),
      productionStatusId: toNullableNumber(row.production_status_id),
      productionStatusFromDetailsEnabled: row.production_status_from_details_enabled,
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
    edgeTypeId: toNumber(row.edge_type_id),
    filmId: toNullableNumber(row.film_id),
    millingCostPerSqm: toNullableNumber(row.milling_cost_per_sqm),
    detailCost: toNumber(row.detail_cost),
    priority: toNumber(row.priority),
    productionStatusId: toNullableNumber(row.production_status_id),
    jointOrderId: toNullableNumber(row.joint_order_id),
    note: row.note,
    basisProject: row.basis_project,
    basisProduct: row.basis_product,
    basisData: row.basis_data,
    basisDesignation: row.basis_designation,
    doweling: row.doweling === true,
    linkCuttingFile: row.link_cutting_file,
    linkCuttingImageFile: row.link_cutting_image_file,
    linkCadFile: row.link_cad_file,
    linkPdfFile: row.link_pdf_file,
    refKey1c: row.ref_key_1c,
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
