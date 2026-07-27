import type {
  NormalizedSaveOrderDetailDto,
  NormalizedSaveOrderDowelingLinkDto,
  NormalizedSaveOrderDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  NormalizedSaveOrderRequirementDto,
  NormalizedSaveOrderWorkshopDto,
  SaveOrderDeletedDto,
  SaveOrderDetailDto,
  SaveOrderDowelingLinkDto,
  SaveOrderDto,
  SaveOrderHeaderDto,
  SaveOrderPaymentDto,
  SaveOrderRequirementDto,
  SaveOrderWorkshopDto,
} from '../dto/save-order.dto';
import { OrderValidationError, type OrderFieldError } from '../errors/order.errors';

type RawRecord = Record<string, unknown>;

const NUMERIC_STRING_RE = /^-?(?:\d+|\d+\.\d+)$/;

export function normalizeSaveOrderDto(input: SaveOrderDto): NormalizedSaveOrderDto {
  const errors: OrderFieldError[] = [];
  const raw = input as unknown as RawRecord;

  const details = normalizeRequiredArray<SaveOrderDetailDto>(raw.details, 'details', errors);
  const payments = normalizeRequiredArray<SaveOrderPaymentDto>(raw.payments, 'payments', errors);
  const workshops = normalizeRequiredArray<SaveOrderWorkshopDto>(raw.workshops, 'workshops', errors);
  const requirements = normalizeRequiredArray<SaveOrderRequirementDto>(
    raw.requirements,
    'requirements',
    errors,
  );
  const dowelingLinks = normalizeRequiredArray<SaveOrderDowelingLinkDto>(
    raw.dowelingLinks,
    'dowelingLinks',
    errors,
  );

  if (!raw.header || typeof raw.header !== 'object' || Array.isArray(raw.header)) {
    errors.push({ field: 'header', message: 'header is required' });
  }

  if (!raw.deleted || typeof raw.deleted !== 'object' || Array.isArray(raw.deleted)) {
    errors.push({ field: 'deleted', message: 'deleted is required' });
  }

  if (errors.length > 0) {
    throw new OrderValidationError(errors);
  }

  return {
    header: normalizeHeader(raw.header as SaveOrderHeaderDto),
    details: details.filter((detail) => !isBlankNewDetail(detail)).map(normalizeDetail),
    payments: payments.filter((payment) => !isBlankNewPayment(payment)).map(normalizePayment),
    workshops: workshops.map(normalizeWorkshop),
    requirements: requirements.map(normalizeRequirement),
    dowelingLinks: dowelingLinks.map(normalizeDowelingLink),
    deleted: normalizeDeleted(raw.deleted as SaveOrderDeletedDto),
    version: optionalInteger(raw.version, 'version') ?? undefined,
    idempotencyKey: normalizeOptionalString(raw.idempotencyKey) ?? undefined,
  };
}

export function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeDateOnly(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return String(value).trim();
}

function normalizeHeader(header: SaveOrderHeaderDto): NormalizedSaveOrderHeaderDto {
  const raw = header as unknown as RawRecord;

  return {
    orderId: optionalInteger(raw.orderId, 'header.orderId') ?? undefined,
    projectId: optionalInteger(raw.projectId, 'header.projectId'),
    orderName: requiredString(raw.orderName),
    clientId: requiredNumber(raw.clientId, 'header.clientId'),
    orderDate: normalizeDateOnly(raw.orderDate) ?? '',
    priority: optionalNumber(raw.priority, 'header.priority') ?? 100,
    managerId: optionalInteger(raw.managerId, 'header.managerId'),
    orderStatusId: requiredNumber(raw.orderStatusId, 'header.orderStatusId'),
    paymentStatusId: optionalInteger(raw.paymentStatusId, 'header.paymentStatusId'),
    productionStatusId: optionalInteger(raw.productionStatusId, 'header.productionStatusId'),
    productionStatusFromDetailsEnabled: optionalBoolean(
      raw.productionStatusFromDetailsEnabled,
      true,
    ),
    plannedCompletionDate: normalizeDateOnly(raw.plannedCompletionDate),
    completionDate: normalizeDateOnly(raw.completionDate),
    issueDate: normalizeDateOnly(raw.issueDate),
    paymentDate: normalizeDateOnly(raw.paymentDate),
    discount: optionalNumber(raw.discount, 'header.discount') ?? 0,
    surcharge: optionalNumber(raw.surcharge, 'header.surcharge') ?? 0,
    linkCuttingFile: normalizeOptionalString(raw.linkCuttingFile),
    linkCuttingImageFile: normalizeOptionalString(raw.linkCuttingImageFile),
    linkCadFile: normalizeOptionalString(raw.linkCadFile),
    linkPdfFile: normalizeOptionalString(raw.linkPdfFile),
    notes: normalizeOptionalString(raw.notes),
    refKey1c: normalizeOptionalString(raw.refKey1c),
    // VARIANT B: header material_id is sunset. Preserve the raw value so that
    // validateSaveOrderDto can REJECT a non-null incoming materialId (422).
    // Nulling happens at the PERSISTENCE layer (pg-order-transaction-manager /
    // pg-order-snapshot), NOT here — forcing null here would make the validation
    // check at order-validation.ts:68 dead code and silently accept stale payloads.
    materialId: optionalInteger(raw.materialId, 'header.materialId'),
    sheetMaterialTypeId: optionalInteger(raw.sheetMaterialTypeId, 'header.sheetMaterialTypeId'),
    millingTypeId: optionalInteger(raw.millingTypeId, 'header.millingTypeId'),
    edgeTypeId: optionalInteger(raw.edgeTypeId, 'header.edgeTypeId'),
    filmId: optionalInteger(raw.filmId, 'header.filmId'),
  };
}

function normalizeDetail(detail: SaveOrderDetailDto): NormalizedSaveOrderDetailDto {
  const raw = detail as unknown as RawRecord;

  return {
    id: optionalInteger(raw.id, 'details[].id') ?? undefined,
    clientKey: normalizeClientKey(raw),
    detailNumber: optionalInteger(raw.detailNumber, 'details[].detailNumber') ?? undefined,
    detailName: normalizeOptionalString(raw.detailName),
    height: requiredNumber(raw.height, 'details[].height'),
    width: requiredNumber(raw.width, 'details[].width'),
    quantity: requiredNumber(raw.quantity, 'details[].quantity'),
    // VARIANT B: material_id is always NULL for sheet-bearing details (migration 034).
    // Accept null/absent from client; never coerce to 0.
    materialId: optionalInteger(raw.materialId, 'details[].materialId'),
    sheetMaterialTypeId: optionalInteger(raw.sheetMaterialTypeId, 'details[].sheetMaterialTypeId'),
    millingTypeId: requiredNumber(raw.millingTypeId, 'details[].millingTypeId'),
    edgeTypeId: requiredNumber(raw.edgeTypeId, 'details[].edgeTypeId'),
    filmId: optionalInteger(raw.filmId, 'details[].filmId'),
    area: optionalNumber(raw.area, 'details[].area'),
    millingCostPerSqm: optionalNumber(raw.millingCostPerSqm, 'details[].millingCostPerSqm'),
    detailCost: optionalNumber(raw.detailCost, 'details[].detailCost'),
    priority: optionalNumber(raw.priority, 'details[].priority') ?? 100,
    productionStatusId: optionalInteger(raw.productionStatusId, 'details[].productionStatusId'),
    jointOrderId: optionalInteger(raw.jointOrderId, 'details[].jointOrderId'),
    note: normalizeOptionalString(raw.note),
    basisProject: normalizeOptionalString(raw.basisProject),
    basisProduct: normalizeOptionalString(raw.basisProduct),
    basisData: normalizeOptionalString(raw.basisData),
    basisDesignation: normalizeOptionalString(raw.basisDesignation),
    doweling: optionalBoolean(raw.doweling, false),
    linkCuttingFile: normalizeOptionalString(raw.linkCuttingFile),
    linkCuttingImageFile: normalizeOptionalString(raw.linkCuttingImageFile),
    linkCadFile: normalizeOptionalString(raw.linkCadFile),
    linkPdfFile: normalizeOptionalString(raw.linkPdfFile),
    refKey1c: normalizeOptionalString(raw.refKey1c),
  };
}

function normalizePayment(payment: SaveOrderPaymentDto): NormalizedSaveOrderPaymentDto {
  const raw = payment as unknown as RawRecord;

  return {
    id: optionalInteger(raw.id, 'payments[].id') ?? undefined,
    clientKey: normalizeClientKey(raw),
    typePaidId: requiredNumber(raw.typePaidId, 'payments[].typePaidId'),
    amount: requiredNumber(raw.amount, 'payments[].amount'),
    paymentDate: normalizeDateOnly(raw.paymentDate) ?? '',
    notes: normalizeOptionalString(raw.notes),
    refKey1c: normalizeOptionalString(raw.refKey1c),
  };
}

function normalizeWorkshop(workshop: SaveOrderWorkshopDto): NormalizedSaveOrderWorkshopDto {
  const raw = workshop as unknown as RawRecord;

  return {
    id: optionalInteger(raw.id, 'workshops[].id') ?? undefined,
    clientKey: normalizeClientKey(raw),
    workshopId: requiredNumber(raw.workshopId, 'workshops[].workshopId'),
    productionStatusId: requiredNumber(
      raw.productionStatusId,
      'workshops[].productionStatusId',
    ),
    receivedDate: normalizeDateOnly(raw.receivedDate),
    startedDate: normalizeDateOnly(raw.startedDate),
    completedDate: normalizeDateOnly(raw.completedDate),
    plannedCompletionDate: normalizeDateOnly(raw.plannedCompletionDate),
    sequenceOrder: optionalNumber(raw.sequenceOrder, 'workshops[].sequenceOrder'),
    responsibleEmployeeId: optionalInteger(
      raw.responsibleEmployeeId,
      'workshops[].responsibleEmployeeId',
    ),
    notes: normalizeOptionalString(raw.notes),
    refKey1c: normalizeOptionalString(raw.refKey1c),
  };
}

function normalizeRequirement(requirement: SaveOrderRequirementDto): NormalizedSaveOrderRequirementDto {
  const raw = requirement as unknown as RawRecord;

  return {
    id: optionalInteger(raw.id, 'requirements[].id') ?? undefined,
    clientKey: normalizeClientKey(raw),
    resourceType: requiredString(raw.resourceType),
    materialId: optionalInteger(raw.materialId, 'requirements[].materialId'),
    filmId: optionalInteger(raw.filmId, 'requirements[].filmId'),
    edgeTypeId: optionalInteger(raw.edgeTypeId, 'requirements[].edgeTypeId'),
    requiredQuantity: requiredNumber(raw.requiredQuantity, 'requirements[].requiredQuantity'),
    unitId: requiredNumber(raw.unitId, 'requirements[].unitId'),
    wastePercentage: optionalNumber(raw.wastePercentage, 'requirements[].wastePercentage'),
    finalQuantity: optionalNumber(raw.finalQuantity, 'requirements[].finalQuantity'),
    requirementStatusId: requiredNumber(
      raw.requirementStatusId,
      'requirements[].requirementStatusId',
    ),
    supplierId: optionalInteger(raw.supplierId, 'requirements[].supplierId'),
    purchasePrice: optionalNumber(raw.purchasePrice, 'requirements[].purchasePrice'),
    requisitionId: optionalInteger(raw.requisitionId, 'requirements[].requisitionId'),
    warehouseId: optionalInteger(raw.warehouseId, 'requirements[].warehouseId'),
    reservedAt: normalizeDateOnly(raw.reservedAt),
    consumedAt: normalizeDateOnly(raw.consumedAt),
    notes: normalizeOptionalString(raw.notes),
    calculationDetails: normalizeOptionalString(raw.calculationDetails),
    refKey1c: normalizeOptionalString(raw.refKey1c),
  };
}

function normalizeDowelingLink(link: SaveOrderDowelingLinkDto): NormalizedSaveOrderDowelingLinkDto {
  const raw = link as unknown as RawRecord;

  return {
    id: optionalInteger(raw.id, 'dowelingLinks[].id') ?? undefined,
    clientKey: normalizeClientKey(raw),
    dowelingOrderId: requiredNumber(raw.dowelingOrderId, 'dowelingLinks[].dowelingOrderId'),
    designEngineerId:
      'designEngineerId' in raw
        ? optionalInteger(raw.designEngineerId, 'dowelingLinks[].designEngineerId')
        : undefined,
    refKey1c: normalizeOptionalString(raw.refKey1c),
  };
}

function normalizeDeleted(deleted: SaveOrderDeletedDto): Required<SaveOrderDeletedDto> {
  const raw = deleted as unknown as RawRecord;

  return {
    detailIds: normalizeIdArray(raw.detailIds),
    paymentIds: normalizeIdArray(raw.paymentIds),
    workshopIds: normalizeIdArray(raw.workshopIds),
    requirementIds: normalizeIdArray(raw.requirementIds),
    dowelingLinkIds: normalizeIdArray(raw.dowelingLinkIds),
  };
}

function normalizeIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => requiredNumber(item, 'deleted[]'));
}

function normalizeRequiredArray<T>(
  value: unknown,
  field: string,
  errors: OrderFieldError[],
): T[] {
  if (!Array.isArray(value)) {
    errors.push({ field, message: `${field} must be an array` });
    return [];
  }

  return value as T[];
}

function normalizeClientKey(raw: RawRecord): string | undefined {
  return (
    normalizeOptionalString(raw.clientKey) ??
    normalizeOptionalString(raw.clientId) ??
    undefined
  );
}

function requiredString(value: unknown): string {
  const normalized = normalizeOptionalString(value);
  return normalized ?? '';
}

function requiredNumber(value: unknown, field: string): number {
  return numberFromUnknown(value, field) ?? 0;
}

function optionalNumber(value: unknown, field: string): number | null {
  return numberFromUnknown(value, field);
}

function optionalInteger(value: unknown, field: string): number | null {
  const normalized = numberFromUnknown(value, field);
  return normalized;
}

function numberFromUnknown(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OrderValidationError([{ field, message: `${field} must be finite` }]);
    }

    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return null;
    }

    if (!NUMERIC_STRING_RE.test(trimmed)) {
      throw new OrderValidationError([{ field, message: `${field} must be a valid number` }]);
    }

    return Number(trimmed);
  }

  throw new OrderValidationError([{ field, message: `${field} must be a valid number` }]);
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }

  return Boolean(value);
}

function isBlankNewDetail(detail: SaveOrderDetailDto): boolean {
  const raw = detail as unknown as RawRecord;

  if (hasValue(raw.id)) {
    return false;
  }

  const meaningfulFields = [
    raw.height,
    raw.width,
    raw.quantity,
    raw.materialId,
    raw.millingTypeId,
    raw.edgeTypeId,
    raw.filmId,
    raw.millingCostPerSqm,
    raw.detailCost,
    raw.detailName,
    raw.note,
    raw.basisProject,
    raw.basisProduct,
    raw.basisData,
    raw.basisDesignation,
    raw.productionStatusId,
    raw.jointOrderId,
    raw.linkCuttingFile,
    raw.linkCuttingImageFile,
    raw.linkCadFile,
    raw.linkPdfFile,
    raw.refKey1c,
  ];

  return meaningfulFields.every(isEmptyOrZero);
}

function isBlankNewPayment(payment: SaveOrderPaymentDto): boolean {
  const raw = payment as unknown as RawRecord;
  return !hasValue(raw.id) && isEmptyOrZero(raw.amount);
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

function isEmptyOrZero(value: unknown): boolean {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (typeof value === 'number') {
    return value === 0;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed === '0';
  }

  return false;
}
