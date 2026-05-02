import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import type { OrderDto, OrderListItemDto, OrderListResponseDto } from '../dto/order.dto';
import type {
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
  clientName: 'c.client_name',
  orderStatusName: 'os.order_status_name',
  paymentStatusName: 'pay_s.payment_status_name',
  productionStatusName: 'prod_s.production_status_name',
  finalAmount: 'o.final_amount',
  paidAmount: 'o.paid_amount',
  debtAmount: '(o.final_amount - o.paid_amount)',
  updatedAt: 'o.updated_at',
};

interface OrderHeaderRow extends QueryResultRow {
  order_id: string | number;
  order_name: string;
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
  version: string | number;
  ref_key_1c: string | null;
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
  material_id: string | number;
  milling_type_id: string | number;
  edge_type_id: string | number;
  film_id: string | number | null;
  milling_cost_per_sqm: string | number | null;
  detail_cost: string | number | null;
  priority: string | number | null;
  production_status_id: string | number | null;
  joint_order_id: string | number | null;
  note: string | null;
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
  design_engineer_id: string | number | null;
  ref_key_1c: string | null;
}

interface CountRow extends QueryResultRow {
  total: string | number;
}

export class PgOrderReadRepository implements OrderReadRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async listOrders(command: ListOrdersCommand): Promise<OrderListResponseDto> {
    const params: unknown[] = [];
    const where = this.buildListWhere(command, params);
    const orderBy = SORT_COLUMNS[command.query.sortBy];
    const limitIndex = params.push(command.query.pageSize);
    const offsetIndex = params.push((command.query.page - 1) * command.query.pageSize);
    const count = await this.database.query<CountRow>(
      `
      SELECT COUNT(*)::int AS total
      FROM orders o
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
        o.created_at, o.updated_at, o.version, o.ref_key_1c
      FROM orders o
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
      LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id
      LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = o.production_status_id
      ${where}
      ORDER BY ${orderBy} ${command.query.sortOrder === 'asc' ? 'ASC' : 'DESC'}, o.order_id DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `,
      params,
    );
    const total = toNumber(count.rows[0]?.total ?? 0);

    return {
      data: rows.rows.map(mapListItem),
      pagination: {
        page: command.query.page,
        pageSize: command.query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / command.query.pageSize)),
      },
    };
  }

  async getOrderById(command: GetOrderByIdCommand): Promise<OrderDto | null> {
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
        o.created_at, o.updated_at, o.version, o.ref_key_1c
      FROM orders o
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
      LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id
      LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = o.production_status_id
      WHERE o.order_id = $1 AND o.delete_flag = false
      `,
      [command.orderId],
    );
    const header = headerResult.rows[0];

    if (!header) {
      return null;
    }

    const details = await this.database.query<OrderDetailRow>(
      `
      SELECT *
      FROM order_details
      WHERE order_id = $1 AND delete_flag = false
      ORDER BY detail_number ASC, detail_id ASC
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
      SELECT odl.*, d.design_engineer_id
      FROM order_doweling_links odl
      LEFT JOIN doweling_orders d ON d.doweling_order_id = odl.doweling_order_id
      WHERE odl.order_id = $1 AND odl.delete_flag = false
      ORDER BY odl.order_doweling_link_id ASC
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
    );
  }

  private buildListWhere(command: ListOrdersCommand, params: unknown[]): string {
    const clauses = ['o.delete_flag = false'];

    if (command.query.search) {
      const index = params.push(`%${command.query.search}%`);
      clauses.push(`(o.order_name ILIKE $${index} OR c.client_name::text ILIKE $${index})`);
    }

    if (command.query.clientId) {
      clauses.push(`o.client_id = $${params.push(command.query.clientId)}`);
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

    return `WHERE ${clauses.join(' AND ')}`;
  }
}

function mapOrderDto(
  row: OrderHeaderRow,
  details: OrderDetailRow[],
  payments: OrderPaymentRow[],
  workshops: OrderWorkshopRow[],
  requirements: OrderRequirementRow[],
  dowelingLinks: OrderDowelingLinkRow[],
): OrderDto {
  return {
    header: {
      orderId: toNumber(row.order_id),
      orderName: row.order_name,
      clientId: toNumber(row.client_id),
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
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
      version: toNumber(row.version),
    },
    details: details.map(mapDetail),
    payments: payments.map(mapPayment),
    workshops: workshops.map(mapWorkshop),
    requirements: requirements.map(mapRequirement),
    dowelingLinks: dowelingLinks.map(mapDowelingLink),
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
  };
}

function mapListItem(row: OrderHeaderRow): OrderListItemDto {
  return {
    orderId: toNumber(row.order_id),
    orderName: row.order_name,
    clientId: toNumber(row.client_id),
    clientName: row.client_name,
    orderDate: toDateOnly(row.order_date) ?? '',
    plannedCompletionDate: toDateOnly(row.planned_completion_date),
    completionDate: toDateOnly(row.completion_date),
    issueDate: toDateOnly(row.issue_date),
    orderStatusName: row.order_status_name ?? '',
    paymentStatusName: row.payment_status_name ?? '',
    productionStatusName: row.production_status_name,
    totalAmount: toNumber(row.total_amount),
    discount: toNumber(row.discount),
    surcharge: toNumber(row.surcharge),
    finalAmount: toNumber(row.final_amount),
    paidAmount: toNumber(row.paid_amount),
    debtAmount: roundMoney(toNumber(row.final_amount) - toNumber(row.paid_amount)),
    partsCount: toNumber(row.parts_count),
    totalArea: toNumber(row.total_area),
    managerId: toNullableNumber(row.manager_id),
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
    materialId: toNumber(row.material_id),
    millingTypeId: toNumber(row.milling_type_id),
    edgeTypeId: toNumber(row.edge_type_id),
    filmId: toNullableNumber(row.film_id),
    millingCostPerSqm: toNullableNumber(row.milling_cost_per_sqm),
    detailCost: toNumber(row.detail_cost),
    priority: toNumber(row.priority),
    productionStatusId: toNullableNumber(row.production_status_id),
    jointOrderId: toNullableNumber(row.joint_order_id),
    note: row.note,
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
  return {
    id: toNumber(row.order_doweling_link_id),
    orderId: toNumber(row.order_id),
    dowelingOrderId: toNumber(row.doweling_order_id),
    designEngineerId: toNullableNumber(row.design_engineer_id),
    refKey1c: row.ref_key_1c,
  };
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
