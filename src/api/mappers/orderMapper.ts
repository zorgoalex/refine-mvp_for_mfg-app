import type {
  Order,
  OrderDetail,
  OrderDowelingLink,
  OrderFormValues,
  OrderResourceRequirement,
  OrderWorkshop,
  Payment,
} from '../../types/orders';
import type {
  DateOnlyString,
  OrderDetailDto,
  OrderDto,
  OrderDowelingLinkDto,
  OrderListItemDto,
  OrderResourceRequirementDto,
  OrderWorkshopDto,
  PaymentDto,
  SaveOrderDetailDto,
  SaveOrderDowelingLinkDto,
  SaveOrderDto,
  SaveOrderPaymentDto,
  SaveOrderRequirementDto,
  SaveOrderWorkshopDto,
} from '../types/orderApi.types';

type DateLike = {
  format: (format: string) => string;
};

export type LegacyOrderListRow = Partial<Order> & Record<string, unknown>;

const FRONTEND_ONLY_FIELDS = new Set([
  '__typename',
  'created_by',
  'edited_by',
  'created_at',
  'updated_at',
  'delete_flag',
  'order_id',
  'doweling_links',
  'doweling_order_id',
  'doweling_order_name',
  'primary_project',
  'projects',
  'client_name',
  'order_status_name',
  'payment_status_name',
  'production_status_name',
  'milling_type_name',
  'edge_type_name',
  'film_name',
  'material_name',
  'design_engineer',
  'design_engineer_id',
  'total_amount',
  'final_amount',
  'paid_amount',
  'debt_amount',
  'parts_count',
  'total_area',
]);

export function mapOrderFormToSaveOrderDto(values: OrderFormValues): SaveOrderDto {
  const header = values.header;
  const version = optionalNonNegativeInteger(values.version ?? header.version);
  const dto: SaveOrderDto = {
    header: {
      orderName: requiredString(header.order_name, 'header.order_name'),
      clientId: requiredNumber(header.client_id, 'header.client_id'),
      orderDate: requiredDateOnly(header.order_date, 'header.order_date'),
      priority: normalizeNumber(header.priority, 100),

      orderStatusId: requiredNumber(header.order_status_id, 'header.order_status_id'),
      paymentStatusId: optionalNumber(header.payment_status_id),
      productionStatusId: optionalNumber(header.production_status_id),
      productionStatusFromDetailsEnabled: normalizeBoolean(
        header.production_status_from_details_enabled,
        true,
      ),

      plannedCompletionDate: normalizeDateOnly(header.planned_completion_date),
      completionDate: normalizeDateOnly(header.completion_date),
      issueDate: normalizeDateOnly(header.issue_date),
      paymentDate: normalizeDateOnly(header.payment_date),

      discount: normalizeNumber(header.discount, 0),
      surcharge: normalizeNumber(header.surcharge, 0),

      managerId: optionalNumber(header.manager_id),

      // Variant B: header materialId is sunsetted; always emit null.
      // The legacy header material picker is removed in Task 9.
      materialId: null,
      sheetMaterialTypeId: optionalNumber(header.sheet_material_type_id),
      millingTypeId: optionalNumber(header.milling_type_id),
      edgeTypeId: optionalNumber(header.edge_type_id),
      filmId: optionalNumber(header.film_id),

      linkCuttingFile: normalizeOptionalString(header.link_cutting_file),
      linkCuttingImageFile: normalizeOptionalString(header.link_cutting_image_file),
      linkCadFile: normalizeOptionalString(header.link_cad_file),
      linkPdfFile: normalizeOptionalString(header.link_pdf_file),

      notes: normalizeOptionalString(header.notes),
      refKey1c: normalizeOptionalString(header.ref_key_1c),
    },
    details: normalizeDetails(values.details ?? []),
    payments: normalizePayments(values.payments ?? []),
    workshops: normalizeWorkshops(values.workshops ?? []),
    requirements: normalizeRequirements(values.requirements ?? []),
    dowelingLinks: normalizeDowelingLinks(values.dowelingLinks ?? []),
    deleted: {
      detailIds: normalizeDeletedIds(values.deletedDetails),
      paymentIds: normalizeDeletedIds(values.deletedPayments),
      workshopIds: normalizeDeletedIds(values.deletedWorkshops),
      requirementIds: normalizeDeletedIds(values.deletedRequirements),
      dowelingLinkIds: normalizeDeletedIds(values.deletedDowelingLinks),
    },
  };

  if (version !== undefined) {
    dto.version = version;
  }

  return dto;
}

export function mapOrderDtoToFormValues(order: OrderDto): OrderFormValues {
  const header: Order = {
    order_id: order.header.orderId,
    order_name: order.header.orderName,
    client_id: order.header.clientId,
    client_name: order.header.clientName ?? null,
    order_date: order.header.orderDate,
    priority: normalizeNumber(order.header.priority, 100),

    order_status_id: order.header.orderStatusId,
    order_status_name: order.header.orderStatusName ?? undefined,
    payment_status_id: optionalNumber(order.header.paymentStatusId) ?? 0,
    payment_status_name: order.header.paymentStatusName ?? undefined,
    production_status_id: optionalNumber(order.header.productionStatusId),
    production_status_name: order.header.productionStatusName ?? undefined,
    production_status_from_details_enabled: normalizeBoolean(
      order.header.productionStatusFromDetailsEnabled,
      true,
    ),

    planned_completion_date: order.header.plannedCompletionDate ?? null,
    completion_date: order.header.completionDate ?? null,
    issue_date: order.header.issueDate ?? null,
    payment_date: order.header.paymentDate ?? null,

    total_amount: order.totals.totalAmount,
    final_amount: order.totals.finalAmount,
    paid_amount: order.totals.paidAmount,
    parts_count: order.totals.partsCount,
    total_area: order.totals.totalArea,

    discount: normalizeNumber(order.header.discount, 0),
    surcharge: normalizeNumber(order.header.surcharge, 0),

    manager_id: optionalNumber(order.header.managerId),

    material_id: optionalNumber(order.header.materialId),
    sheet_material_type_id: optionalNumber(order.header.sheetMaterialTypeId),
    // SP3: server-resolved header material name (COALESCE) for backend-read display.
    material_name_resolved: order.header.materialName ?? null,
    milling_type_id: optionalNumber(order.header.millingTypeId),
    edge_type_id: optionalNumber(order.header.edgeTypeId),
    film_id: optionalNumber(order.header.filmId),

    link_cutting_file: order.header.linkCuttingFile ?? null,
    link_cutting_image_file: order.header.linkCuttingImageFile ?? null,
    link_cad_file: order.header.linkCadFile ?? null,
    link_pdf_file: order.header.linkPdfFile ?? null,

    notes: order.header.notes ?? null,
    ref_key_1c: order.header.refKey1c ?? null,
    created_at: order.header.createdAt ?? undefined,
    updated_at: order.header.updatedAt ?? undefined,
    created_by: optionalNumber(order.header.createdBy) ?? undefined,
    edited_by: optionalNumber(order.header.editedBy) ?? undefined,
    version: order.version,
  };

  const dowelingLinks = mapDowelingLinksFromDto(order.dowelingLinks ?? [], order.header.orderId);
  const firstLink = dowelingLinks[0];

  header.doweling_order_id = firstLink?.doweling_order?.doweling_order_id ?? null;
  header.doweling_order_name = firstLink?.doweling_order?.doweling_order_name ?? null;
  header.doweling_links = dowelingLinks;
  header.primary_project = order.primaryProject;
  header.projects = order.projects ?? [];

  return {
    header,
    details: mapDetailsFromDto(order.details ?? [], order.header.orderId),
    payments: mapPaymentsFromDto(order.payments ?? [], order.header.orderId),
    workshops: mapWorkshopsFromDto(order.workshops ?? [], order.header.orderId),
    requirements: mapRequirementsFromDto(order.requirements ?? [], order.header.orderId),
    dowelingLinks,

    deletedDetails: [],
    deletedPayments: [],
    deletedWorkshops: [],
    deletedRequirements: [],
    deletedDowelingLinks: [],

    isDirty: false,
    version: order.version,
  };
}

export function mapOrderListItemToLegacyRow(item: OrderListItemDto): LegacyOrderListRow {
  return {
    order_id: item.orderId,
    order_name: item.orderName,
    client_id: item.clientId,
    client_name: item.clientName ?? null,
    order_date: item.orderDate,
    planned_completion_date: item.plannedCompletionDate ?? null,
    completion_date: item.completionDate ?? null,
    issue_date: item.issueDate ?? null,
    payment_date: item.paymentDate ?? null,
    priority: normalizeNumber(item.priority, 100),
    order_status_id: item.orderStatusId,
    order_status_name: item.orderStatusName ?? null,
    payment_status_id: item.paymentStatusId ?? undefined,
    payment_status_name: item.paymentStatusName ?? null,
    production_status_id: item.productionStatusId ?? null,
    production_status_name: item.productionStatusName ?? null,
    total_amount: item.totalAmount ?? null,
    final_amount: item.finalAmount ?? null,
    paid_amount: item.paidAmount ?? undefined,
    discount: item.discount ?? 0,
    surcharge: item.surcharge ?? 0,
    parts_count: item.partsCount ?? undefined,
    total_area: item.totalArea ?? undefined,
    manager_id: item.managerId ?? null,
    notes: item.notes ?? null,
    material_ids: item.materialIds ?? [],
    // SP3/R8: for header-only orders (no details) materialNames is empty; fall back to
    // the header material name so the orders list shows a non-blank material column.
    material_names:
      (item.materialNames ?? []).length > 0
        ? (item.materialNames ?? [])
        : item.headerMaterialName
          ? [item.headerMaterialName]
          : [],
    sheet_material_type_ids:
      (item.sheetMaterialTypeIds ?? []).length > 0
        ? (item.sheetMaterialTypeIds ?? [])
        : item.headerSheetMaterialTypeId != null
          ? [item.headerSheetMaterialTypeId]
          : [],
    material_name:
      (item.materialNames ?? []).length > 0
        ? (item.materialNames ?? []).join(', ')
        : (item.headerMaterialName ?? null),
    milling_type_id: item.millingTypeId ?? null,
    milling_type_name: item.millingTypeName ?? null,
    doweling_order_id: item.dowelingOrderId ?? null,
    doweling_order_name: item.dowelingOrderName ?? null,
    design_engineer_id: item.designEngineerId ?? null,
    passed_production_status_codes: item.passedProductionStatusCodes ?? [],
    primary_project: item.primaryProject ?? null,
    projects: item.projects ?? [],
    created_by: item.createdBy ?? undefined,
    edited_by: item.editedBy ?? undefined,
    updated_at: item.updatedAt,
    version: item.version,
  };
}

export function normalizeDateOnly(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.includes('T') ? trimmed.slice(0, 10) : trimmed;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }

  if (isDateLike(value)) {
    const formatted = value.format('YYYY-MM-DD');
    return formatted ? formatted : null;
  }

  return null;
}

export function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const stringValue = String(value).trim();
  return stringValue.length > 0 ? stringValue : null;
}

export function normalizeNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

export function requiredNumber(value: unknown, field: string): number {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Invalid number: ${field}`);
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`Invalid number: ${field}`);
  }

  return numberValue;
}

export function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  }
  return Boolean(value);
}

export function toClientKey(tempId?: number | string | null): string | undefined {
  if (tempId === null || tempId === undefined || tempId === '') return undefined;
  return String(tempId);
}

export function stripFrontendOnlyFields<T extends object>(value: T): Partial<T> {
  const stripped = { ...value } as Record<string, unknown>;
  for (const key of FRONTEND_ONLY_FIELDS) {
    delete stripped[key];
  }
  return stripped as Partial<T>;
}

function normalizeDetails(details: OrderDetail[]): SaveOrderDetailDto[] {
  return details
    .map((detail, index) => ({ detail, index }))
    .filter(({ detail }) => !isNewEmptyDetail(detail))
    .sort((left, right) => {
      const byDetailNumber =
        normalizeNumber(left.detail.detail_number, 0) -
        normalizeNumber(right.detail.detail_number, 0);
      return byDetailNumber === 0 ? left.index - right.index : byDetailNumber;
    })
    .map(({ detail }, index) => ({
      id: detail.detail_id,
      clientKey: toClientKey(detail.temp_id),

      detailNumber: index + 1,
      detailName: normalizeOptionalString(detail.detail_name),

      height: requiredNumber(detail.height, 'detail.height'),
      width: requiredNumber(detail.width, 'detail.width'),
      quantity: requiredNumber(detail.quantity, 'detail.quantity'),

      // Variant B: every order detail is sheet-bearing; materialId is always null.
      // The else-branch is a defensive guard for pre-034 legacy orders (unreachable
      // once migration 034 is applied and all details have sheet_material_type_id).
      materialId: isSheetDetail(detail)
        ? null
        : requiredNumber(detail.material_id, 'detail.material_id'),
      sheetMaterialTypeId: optionalNumber(detail.sheet_material_type_id),
      millingTypeId: requiredNumber(detail.milling_type_id, 'detail.milling_type_id'),
      edgeTypeId: requiredNumber(detail.edge_type_id, 'detail.edge_type_id'),
      filmId: optionalNumber(detail.film_id),

      millingCostPerSqm: optionalNumber(detail.milling_cost_per_sqm),
      detailCost: requiredNumber(detail.detail_cost, 'detail.detail_cost'),

      note: normalizeOptionalString(detail.note),
      priority: normalizeNumber(detail.priority, 100),
      productionStatusId: optionalNumber(detail.production_status_id),
      jointOrderId: optionalNumber(detail.joint_order_id),
      basisProject: normalizeOptionalString(detail.basis_project),
      basisData: normalizeOptionalString(detail.basis_data),

      linkCuttingFile: normalizeOptionalString(detail.link_cutting_file),
      linkCuttingImageFile: normalizeOptionalString(detail.link_cutting_image_file),
      linkCadFile: normalizeOptionalString(detail.link_cad_file),
      linkPdfFile: normalizeOptionalString(detail.link_pdf_file),

      refKey1c: normalizeOptionalString(detail.ref_key_1c),
    }));
}

function normalizePayments(payments: Payment[]): SaveOrderPaymentDto[] {
  return payments.filter((payment) => !isNewEmptyPayment(payment)).map((payment) => ({
    id: payment.payment_id,
    clientKey: toClientKey(payment.temp_id),
    typePaidId: requiredNumber(payment.type_paid_id, 'payment.type_paid_id'),
    amount: requiredNumber(payment.amount, 'payment.amount'),
    paymentDate: requiredDateOnly(payment.payment_date, 'payment.payment_date'),
    notes: normalizeOptionalString(payment.notes),
    refKey1c: normalizeOptionalString(payment.ref_key_1c),
  }));
}

function normalizeWorkshops(workshops: OrderWorkshop[]): SaveOrderWorkshopDto[] {
  return workshops.map((workshop) => ({
    id: workshop.order_workshop_id,
    clientKey: toClientKey(workshop.temp_id),
    workshopId: requiredNumber(workshop.workshop_id, 'workshop.workshop_id'),
    productionStatusId: requiredNumber(
      workshop.production_status_id,
      'workshop.production_status_id',
    ),
    receivedDate: normalizeDateOnly(workshop.received_date),
    startedDate: normalizeDateOnly(workshop.started_date),
    completedDate: normalizeDateOnly(workshop.completed_date),
    plannedCompletionDate: normalizeDateOnly(workshop.planned_completion_date),
    sequenceOrder: optionalNumber(workshop.sequence_order),
    responsibleEmployeeId: optionalNumber(workshop.responsible_employee_id),
    notes: normalizeOptionalString(workshop.notes),
    refKey1c: normalizeOptionalString(workshop.ref_key_1c),
  }));
}

function normalizeRequirements(
  requirements: OrderResourceRequirement[],
): SaveOrderRequirementDto[] {
  return requirements.map((requirement) => ({
    id: requirement.requirement_id,
    clientKey: toClientKey(requirement.temp_id),
    resourceType: requiredString(requirement.resource_type, 'requirement.resource_type'),
    materialId: optionalNumber(requirement.material_id),
    filmId: optionalNumber(requirement.film_id),
    edgeTypeId: optionalNumber(requirement.edge_type_id),
    requiredQuantity: requiredNumber(
      requirement.required_quantity,
      'requirement.required_quantity',
    ),
    unitId: requiredNumber(requirement.unit_id, 'requirement.unit_id'),
    wastePercentage: optionalNumber(requirement.waste_percentage),
    finalQuantity: optionalNumber(requirement.final_quantity),
    requirementStatusId: requiredNumber(
      requirement.requirement_status_id,
      'requirement.requirement_status_id',
    ),
    supplierId: optionalNumber(requirement.supplier_id),
    purchasePrice: optionalNumber(requirement.purchase_price),
    requisitionId: optionalNumber(requirement.requisition_id),
    warehouseId: optionalNumber(requirement.warehouse_id),
    reservedAt: normalizeOptionalIsoDateTime(requirement.reserved_at),
    consumedAt: normalizeOptionalIsoDateTime(requirement.consumed_at),
    notes: normalizeOptionalString(requirement.notes),
    calculationDetails: normalizeOptionalString(requirement.calculation_details),
    refKey1c: normalizeOptionalString(requirement.ref_key_1c),
  }));
}

function normalizeDowelingLinks(links: OrderDowelingLink[]): SaveOrderDowelingLinkDto[] {
  return links.map((link) => ({
    id: link.order_doweling_link_id,
    clientKey: toClientKey(link.temp_id),
    dowelingOrderId: requiredNumber(link.doweling_order_id, 'link.doweling_order_id'),
    designEngineerId: optionalNumber(link.doweling_order?.design_engineer_id),
    refKey1c: normalizeOptionalString(link.ref_key_1c),
  }));
}

function mapDetailsFromDto(details: OrderDetailDto[], orderId: number): OrderDetail[] {
  return details.map((detail) => ({
    detail_id: detail.id,
    temp_id: tempIdFromClientKey(detail.clientKey, detail.id),
    order_id: detail.orderId ?? orderId,
    detail_number: detail.detailNumber,
    detail_name: detail.detailName ?? null,
    height: detail.height,
    width: detail.width,
    quantity: detail.quantity,
    area: detail.area ?? calculateArea(detail.height, detail.width, detail.quantity),
    material_id: detail.materialId,
    sheet_material_type_id: detail.sheetMaterialTypeId ?? null,
    // SP3: carry the server-resolved COALESCE(sheet, material) name so backend-read
    // surfaces (show/edit via __backendOrder) display the sheet name, not "—".
    material_name_resolved: detail.materialName ?? null,
    milling_type_id: detail.millingTypeId,
    edge_type_id: detail.edgeTypeId,
    film_id: detail.filmId ?? null,
    milling_cost_per_sqm: detail.millingCostPerSqm ?? null,
    detail_cost: detail.detailCost,
    note: detail.note ?? null,
    priority: normalizeNumber(detail.priority, 100),
    production_status_id: detail.productionStatusId ?? null,
    joint_order_id: detail.jointOrderId ?? null,
    basis_project: detail.basisProject ?? null,
    basis_data: detail.basisData ?? null,
    link_cutting_file: detail.linkCuttingFile ?? null,
    link_cutting_image_file: detail.linkCuttingImageFile ?? null,
    link_cad_file: detail.linkCadFile ?? null,
    link_pdf_file: detail.linkPdfFile ?? null,
    ref_key_1c: detail.refKey1c ?? null,
  }));
}

function mapPaymentsFromDto(payments: PaymentDto[], orderId: number): Payment[] {
  return payments.map((payment) => ({
    payment_id: payment.id,
    temp_id: tempIdFromClientKey(payment.clientKey, payment.id),
    order_id: payment.orderId ?? orderId,
    type_paid_id: payment.typePaidId,
    amount: payment.amount,
    payment_date: payment.paymentDate,
    notes: payment.notes ?? null,
    ref_key_1c: payment.refKey1c ?? null,
  }));
}

function mapWorkshopsFromDto(workshops: OrderWorkshopDto[], orderId: number): OrderWorkshop[] {
  return workshops.map((workshop) => ({
    order_workshop_id: workshop.id,
    temp_id: tempIdFromClientKey(workshop.clientKey, workshop.id),
    order_id: workshop.orderId ?? orderId,
    workshop_id: workshop.workshopId,
    production_status_id: workshop.productionStatusId,
    received_date: workshop.receivedDate ?? null,
    started_date: workshop.startedDate ?? null,
    completed_date: workshop.completedDate ?? null,
    planned_completion_date: workshop.plannedCompletionDate ?? null,
    sequence_order: workshop.sequenceOrder ?? null,
    responsible_employee_id: workshop.responsibleEmployeeId ?? null,
    notes: workshop.notes ?? null,
    ref_key_1c: workshop.refKey1c ?? null,
  }));
}

function mapRequirementsFromDto(
  requirements: OrderResourceRequirementDto[],
  orderId: number,
): OrderResourceRequirement[] {
  return requirements.map((requirement) => ({
    requirement_id: requirement.id,
    temp_id: tempIdFromClientKey(requirement.clientKey, requirement.id),
    order_id: requirement.orderId ?? orderId,
    resource_type: requirement.resourceType,
    material_id: requirement.materialId ?? null,
    film_id: requirement.filmId ?? null,
    edge_type_id: requirement.edgeTypeId ?? null,
    required_quantity: requirement.requiredQuantity,
    unit_id: requirement.unitId,
    waste_percentage: requirement.wastePercentage ?? null,
    final_quantity: requirement.finalQuantity ?? null,
    requirement_status_id: requirement.requirementStatusId,
    supplier_id: requirement.supplierId ?? null,
    purchase_price: requirement.purchasePrice ?? null,
    requisition_id: requirement.requisitionId ?? null,
    warehouse_id: requirement.warehouseId ?? null,
    reserved_at: requirement.reservedAt ?? null,
    consumed_at: requirement.consumedAt ?? null,
    notes: requirement.notes ?? null,
    calculation_details: requirement.calculationDetails ?? null,
    ref_key_1c: requirement.refKey1c ?? null,
  }));
}

function mapDowelingLinksFromDto(
  links: OrderDowelingLinkDto[],
  orderId: number,
): OrderDowelingLink[] {
  return links.map((link) => {
    const dowelingOrderId = link.dowelingOrder?.id ?? link.dowelingOrderId;
    const designEngineerId =
      link.dowelingOrder?.designEngineerId ?? link.designEngineerId ?? null;

    return {
      order_doweling_link_id: link.id,
      temp_id: tempIdFromClientKey(link.clientKey, link.id),
      order_id: link.orderId ?? orderId,
      doweling_order_id: dowelingOrderId,
      doweling_order: {
        doweling_order_id: dowelingOrderId,
        doweling_order_name: link.dowelingOrder?.name ?? '',
        design_engineer_id: designEngineerId,
        design_engineer:
          link.dowelingOrder?.designEngineerName ?? link.designEngineerName ?? null,
      },
      ref_key_1c: link.refKey1c ?? null,
    };
  });
}

function normalizeDeletedIds(ids?: number[]): number[] {
  const normalized = (ids ?? [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  return Array.from(new Set(normalized));
}

function isSheetDetail(detail: OrderDetail): boolean {
  const sheetId = optionalNumber(detail.sheet_material_type_id);
  return sheetId !== null && sheetId > 0;
}

function isNewEmptyDetail(detail: OrderDetail): boolean {
  return (
    !detail.detail_id &&
    isZeroish(detail.height) &&
    isZeroish(detail.width) &&
    isZeroish(detail.area)
  );
}

function isNewEmptyPayment(payment: Payment): boolean {
  return !payment.payment_id && !optionalNumber(payment.amount);
}

function isZeroish(value: unknown): boolean {
  const numberValue = optionalNumber(value);
  return numberValue === null || numberValue === 0;
}

function requiredString(value: unknown, field: string): string {
  const stringValue = normalizeOptionalString(value);
  if (!stringValue) {
    throw new Error(`Invalid string: ${field}`);
  }
  return stringValue;
}

function requiredDateOnly(value: unknown, field: string): DateOnlyString {
  const dateValue = normalizeDateOnly(value);
  if (!dateValue) {
    throw new Error(`Invalid date: ${field}`);
  }
  return dateValue;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const numberValue = optionalNumber(value);
  if (numberValue === null || !Number.isInteger(numberValue) || numberValue < 0) {
    return undefined;
  }
  return numberValue;
}

function normalizeOptionalIsoDateTime(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }
  return normalizeOptionalString(value);
}

function tempIdFromClientKey(clientKey: string | null | undefined, fallbackId: number): number {
  if (!clientKey) return fallbackId;
  const numberValue = Number(clientKey);
  return Number.isSafeInteger(numberValue) ? numberValue : fallbackId;
}

function calculateArea(height: number, width: number, quantity: number): number {
  return Math.ceil((height * width * quantity) / 10000) / 100;
}

function isDateLike(value: unknown): value is DateLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'format' in value &&
    typeof (value as { format?: unknown }).format === 'function'
  );
}
