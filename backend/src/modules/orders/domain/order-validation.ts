import type {
  NormalizedSaveOrderDetailDto,
  NormalizedSaveOrderDto,
  NormalizedSaveOrderRequirementDto,
  NormalizedSaveOrderWorkshopDto,
  OrderSaveMode,
} from '../dto/save-order.dto';
import { OrderValidationError, type OrderFieldError } from '../errors/order.errors';

export interface ValidateSaveOrderOptions {
  mode: OrderSaveMode;
  pathOrderId?: number;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T/;
const RESOURCE_TYPES = new Set(['material', 'film', 'edge']);

export function validateSaveOrderDto(
  order: NormalizedSaveOrderDto,
  options: ValidateSaveOrderOptions,
): void {
  const errors: OrderFieldError[] = [];

  validateHeader(order, options, errors);
  validateDetails(order.details, order.deleted.detailIds, errors);
  validatePayments(order, errors);
  validateWorkshops(order.workshops, order.deleted.workshopIds, errors);
  validateRequirements(order.requirements, order.deleted.requirementIds, errors);
  validateDowelingLinks(order, errors);
  validateBazisImportCandidates(order, errors);
  validateCreateDeletedPolicy(order, options.mode, errors);

  if (errors.length > 0) {
    throw new OrderValidationError(errors);
  }
}

function validateBazisImportCandidates(
  order: NormalizedSaveOrderDto,
  errors: OrderFieldError[],
): void {
  const seen = new Set<string>();
  const detailsByClientKey = new Map<string, NormalizedSaveOrderDetailDto[]>();
  order.details.forEach((detail) => {
    if (!detail.clientKey) return;
    const matches = detailsByClientKey.get(detail.clientKey) ?? [];
    matches.push(detail);
    detailsByClientKey.set(detail.clientKey, matches);
  });

  order.bazisImportCandidateClientKeys.forEach((clientKey, index) => {
    const field = `bazisImportCandidateClientKeys[${index}]`;
    if (!clientKey) {
      errors.push({ field, message: 'candidate client key is required' });
      return;
    }
    if (seen.has(clientKey)) {
      errors.push({ field, message: 'candidate client key must be unique' });
    }
    seen.add(clientKey);

    const matches = detailsByClientKey.get(clientKey) ?? [];
    if (matches.length !== 1) {
      errors.push({ field, message: 'candidate client key must identify exactly one detail' });
      return;
    }
    if (matches[0].id !== undefined) {
      errors.push({ field, message: 'only newly imported details may be candidates' });
    }
  });
}

function validateHeader(
  order: NormalizedSaveOrderDto,
  options: ValidateSaveOrderOptions,
  errors: OrderFieldError[],
): void {
  const { header } = order;

  if (options.mode === 'create' && header.orderId !== undefined) {
    errors.push({ field: 'header.orderId', message: 'orderId must be absent on create' });
  }

  if (options.mode === 'update') {
    requireNonNegativeInteger(order.version, 'version', errors);

    if (options.pathOrderId !== undefined && header.orderId !== undefined && header.orderId !== options.pathOrderId) {
      errors.push({ field: 'header.orderId', message: 'orderId must match path order id' });
    }
  }

  if (header.orderName.length === 0) {
    errors.push({ field: 'header.orderName', message: 'orderName is required' });
  }

  requirePositiveIntegerIfPresent(header.projectId, 'header.projectId', errors);
  requirePositiveInteger(header.clientId, 'header.clientId', errors);
  validateDateOnly(header.orderDate, 'header.orderDate', errors);
  requirePositiveInteger(header.orderStatusId, 'header.orderStatusId', errors);
  requirePositiveIntegerIfPresent(header.paymentStatusId, 'header.paymentStatusId', errors);
  requirePositiveIntegerIfPresent(header.productionStatusId, 'header.productionStatusId', errors);
  requirePositiveIntegerIfPresent(header.managerId, 'header.managerId', errors);
  // VARIANT B: header material_id is sunset — must be null/absent.
  // Any non-null value (including 0) is rejected; the 0-sentinel is not a valid bypass.
  if (header.materialId != null) {
    errors.push({ field: 'header.materialId', message: 'material_id is not allowed on the header; use sheet_material_type_id' });
  }
  requirePositiveIntegerIfPresent(header.sheetMaterialTypeId, 'header.sheetMaterialTypeId', errors);
  requirePositiveIntegerIfPresent(header.millingTypeId, 'header.millingTypeId', errors);
  requirePositiveIntegerIfPresent(header.edgeTypeId, 'header.edgeTypeId', errors);
  requirePositiveIntegerIfPresent(header.filmId, 'header.filmId', errors);
  validateOptionalDateOnly(
    header.plannedCompletionDate ?? null,
    'header.plannedCompletionDate',
    errors,
  );
  validateOptionalDateOnly(header.completionDate ?? null, 'header.completionDate', errors);
  validateOptionalDateOnly(header.issueDate ?? null, 'header.issueDate', errors);
  validateOptionalDateOnly(header.paymentDate ?? null, 'header.paymentDate', errors);
  requireNonNegative(header.discount, 'header.discount', errors);
  requireNonNegative(header.surcharge, 'header.surcharge', errors);

  if (header.discount > 0 && header.surcharge > 0) {
    errors.push({
      field: 'header.surcharge',
      message: 'discount and surcharge cannot both be greater than zero before DB constraint changes',
      code: 'DISCOUNT_SURCHARGE_MUTUALLY_EXCLUSIVE',
    });
  }
}

function validateDetails(
  details: NormalizedSaveOrderDetailDto[],
  deletedIds: number[],
  errors: OrderFieldError[],
): void {
  validateIds(details, deletedIds, 'details', 'deleted.detailIds', errors);

  details.forEach((detail, index) => {
    requirePositiveIntegerIfPresent(detail.id, `details[${index}].id`, errors);
    requirePositive(detail.height, `details[${index}].height`, errors);
    requirePositive(detail.width, `details[${index}].width`, errors);
    requirePositiveInteger(detail.quantity, `details[${index}].quantity`, errors);
    // VARIANT B: every order detail references its material via sheet_material_type_id.
    // material_id must be omitted/null; sheet id is required and positive.
    // Any non-null materialId (including 0) is rejected; the 0-sentinel is not a valid bypass.
    requirePositiveInteger(detail.sheetMaterialTypeId, `details[${index}].sheetMaterialTypeId`, errors);
    if (detail.materialId != null) {
      errors.push({ field: `details[${index}].materialId`, message: 'material_id is not allowed; use sheet_material_type_id' });
    }
    requirePositiveInteger(detail.millingTypeId, `details[${index}].millingTypeId`, errors);
    requirePositiveInteger(detail.edgeTypeId, `details[${index}].edgeTypeId`, errors);
    requirePositiveIntegerIfPresent(detail.filmId, `details[${index}].filmId`, errors);
    requirePositiveIntegerIfPresent(
      detail.productionStatusId,
      `details[${index}].productionStatusId`,
      errors,
    );
    requirePositiveIntegerIfPresent(detail.jointOrderId, `details[${index}].jointOrderId`, errors);
    requireNonNegativeIfPresent(
      detail.millingCostPerSqm,
      `details[${index}].millingCostPerSqm`,
      errors,
    );
    requireNonNegativeIfPresent(detail.detailCost, `details[${index}].detailCost`, errors);
    requireNonNegative(detail.priority, `details[${index}].priority`, errors);
  });
}

function validatePayments(order: NormalizedSaveOrderDto, errors: OrderFieldError[]): void {
  validateIds(order.payments, order.deleted.paymentIds, 'payments', 'deleted.paymentIds', errors);

  order.payments.forEach((payment, index) => {
    requirePositiveIntegerIfPresent(payment.id, `payments[${index}].id`, errors);
    requirePositiveInteger(payment.typePaidId, `payments[${index}].typePaidId`, errors);
    requirePositive(payment.amount, `payments[${index}].amount`, errors);
    validateDateOnly(payment.paymentDate, `payments[${index}].paymentDate`, errors);
  });
}

function validateWorkshops(
  workshops: NormalizedSaveOrderWorkshopDto[],
  deletedIds: number[],
  errors: OrderFieldError[],
): void {
  validateIds(workshops, deletedIds, 'workshops', 'deleted.workshopIds', errors);
  validateDuplicateKey(
    workshops,
    (workshop) => `${workshop.workshopId}:${workshop.productionStatusId}`,
    'workshops',
    'workshop/prod status pair must be unique',
    errors,
  );

  workshops.forEach((workshop, index) => {
    requirePositiveIntegerIfPresent(workshop.id, `workshops[${index}].id`, errors);
    requirePositiveInteger(workshop.workshopId, `workshops[${index}].workshopId`, errors);
    requirePositiveInteger(
      workshop.productionStatusId,
      `workshops[${index}].productionStatusId`,
      errors,
    );
    requirePositiveIntegerIfPresent(
      workshop.responsibleEmployeeId,
      `workshops[${index}].responsibleEmployeeId`,
      errors,
    );
    requireNonNegativeIfPresent(workshop.sequenceOrder, `workshops[${index}].sequenceOrder`, errors);
    validateOptionalDateOnly(workshop.receivedDate, `workshops[${index}].receivedDate`, errors);
    validateOptionalDateOnly(workshop.startedDate, `workshops[${index}].startedDate`, errors);
    validateOptionalDateOnly(workshop.completedDate, `workshops[${index}].completedDate`, errors);
    validateOptionalDateOnly(
      workshop.plannedCompletionDate,
      `workshops[${index}].plannedCompletionDate`,
      errors,
    );
  });
}

function validateRequirements(
  requirements: NormalizedSaveOrderRequirementDto[],
  deletedIds: number[],
  errors: OrderFieldError[],
): void {
  validateIds(requirements, deletedIds, 'requirements', 'deleted.requirementIds', errors);
  validateDuplicateKey(requirements, requirementResourceKey, 'requirements', 'resource must be unique', errors);

  requirements.forEach((requirement, index) => {
    const fieldPrefix = `requirements[${index}]`;

    requirePositiveIntegerIfPresent(requirement.id, `${fieldPrefix}.id`, errors);

    if (!RESOURCE_TYPES.has(requirement.resourceType)) {
      errors.push({ field: `${fieldPrefix}.resourceType`, message: 'unsupported resource type' });
    }

    requirePositive(requirement.requiredQuantity, `${fieldPrefix}.requiredQuantity`, errors);
    requirePositiveInteger(requirement.unitId, `${fieldPrefix}.unitId`, errors);
    requirePositiveInteger(requirement.requirementStatusId, `${fieldPrefix}.requirementStatusId`, errors);
    requireNonNegativeIfPresent(requirement.wastePercentage, `${fieldPrefix}.wastePercentage`, errors);
    requireNonNegativeIfPresent(requirement.finalQuantity, `${fieldPrefix}.finalQuantity`, errors);
    requireNonNegativeIfPresent(requirement.purchasePrice, `${fieldPrefix}.purchasePrice`, errors);
    requirePositiveIntegerIfPresent(requirement.supplierId, `${fieldPrefix}.supplierId`, errors);
    requirePositiveIntegerIfPresent(requirement.requisitionId, `${fieldPrefix}.requisitionId`, errors);
    requirePositiveIntegerIfPresent(requirement.warehouseId, `${fieldPrefix}.warehouseId`, errors);
    validateOptionalDateTime(requirement.reservedAt, `${fieldPrefix}.reservedAt`, errors);
    validateOptionalDateTime(requirement.consumedAt, `${fieldPrefix}.consumedAt`, errors);

    if (requirement.resourceType === 'material') {
      requirePositiveInteger(requirement.materialId, `${fieldPrefix}.materialId`, errors);
    }

    if (requirement.resourceType === 'film') {
      requirePositiveInteger(requirement.filmId, `${fieldPrefix}.filmId`, errors);
    }

    if (requirement.resourceType === 'edge') {
      requirePositiveInteger(requirement.edgeTypeId, `${fieldPrefix}.edgeTypeId`, errors);
    }

    if (requirement.finalQuantity !== null && requirement.finalQuantity < requirement.requiredQuantity) {
      errors.push({
        field: `${fieldPrefix}.finalQuantity`,
        message: 'finalQuantity cannot be less than requiredQuantity',
      });
    }
  });
}

function validateDowelingLinks(order: NormalizedSaveOrderDto, errors: OrderFieldError[]): void {
  validateIds(
    order.dowelingLinks,
    order.deleted.dowelingLinkIds,
    'dowelingLinks',
    'deleted.dowelingLinkIds',
    errors,
  );
  validateDuplicateKey(
    order.dowelingLinks,
    (link) => String(link.dowelingOrderId),
    'dowelingLinks',
    'dowelingOrderId must be unique',
    errors,
  );

  order.dowelingLinks.forEach((link, index) => {
    requirePositiveIntegerIfPresent(link.id, `dowelingLinks[${index}].id`, errors);
    requirePositiveInteger(link.dowelingOrderId, `dowelingLinks[${index}].dowelingOrderId`, errors);
    requirePositiveIntegerIfPresent(
      link.designEngineerId,
      `dowelingLinks[${index}].designEngineerId`,
      errors,
    );
  });
}

function validateCreateDeletedPolicy(
  order: NormalizedSaveOrderDto,
  mode: OrderSaveMode,
  errors: OrderFieldError[],
): void {
  if (mode !== 'create') {
    return;
  }

  const deletedEntries: Array<[string, number[]]> = [
    ['deleted.detailIds', order.deleted.detailIds],
    ['deleted.paymentIds', order.deleted.paymentIds],
    ['deleted.workshopIds', order.deleted.workshopIds],
    ['deleted.requirementIds', order.deleted.requirementIds],
    ['deleted.dowelingLinkIds', order.deleted.dowelingLinkIds],
  ];

  deletedEntries.forEach(([field, ids]) => {
    if (ids.length > 0) {
      errors.push({ field, message: `${field} must be empty on create` });
    }
  });
}

function validateIds(
  activeRows: Array<{ id?: number }>,
  deletedIds: number[],
  activeField: string,
  deletedField: string,
  errors: OrderFieldError[],
): void {
  const activeIds = new Map<number, number>();
  const deletedSet = new Set<number>();

  activeRows.forEach((row, index) => {
    if (row.id === undefined) {
      return;
    }

    if (activeIds.has(row.id)) {
      errors.push({ field: `${activeField}[${index}].id`, message: 'duplicate active id' });
    }

    activeIds.set(row.id, index);
  });

  deletedIds.forEach((id, index) => {
    requirePositiveInteger(id, `${deletedField}[${index}]`, errors);

    if (deletedSet.has(id)) {
      errors.push({ field: `${deletedField}[${index}]`, message: 'duplicate deleted id' });
    }

    deletedSet.add(id);

    if (activeIds.has(id)) {
      errors.push({
        field: `${deletedField}[${index}]`,
        message: 'id cannot be active and deleted at the same time',
      });
    }
  });
}

function validateDuplicateKey<T>(
  rows: T[],
  getKey: (row: T) => string | null,
  field: string,
  message: string,
  errors: OrderFieldError[],
): void {
  const seen = new Map<string, number>();

  rows.forEach((row, index) => {
    const key = getKey(row);

    if (key === null) {
      return;
    }

    if (seen.has(key)) {
      errors.push({ field: `${field}[${index}]`, message });
    }

    seen.set(key, index);
  });
}

function requirementResourceKey(requirement: NormalizedSaveOrderRequirementDto): string | null {
  if (requirement.resourceType === 'material' && requirement.materialId !== null) {
    return `material:${requirement.materialId}`;
  }

  if (requirement.resourceType === 'film' && requirement.filmId !== null) {
    return `film:${requirement.filmId}`;
  }

  if (requirement.resourceType === 'edge' && requirement.edgeTypeId !== null) {
    return `edge:${requirement.edgeTypeId}`;
  }

  return null;
}

function validateDateOnly(value: string, field: string, errors: OrderFieldError[]): void {
  const match = DATE_ONLY_RE.exec(value);

  if (!match) {
    errors.push({ field, message: `${field} must be YYYY-MM-DD` });
    return;
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const isValidDate =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day);

  if (!isValidDate) {
    errors.push({ field, message: `${field} must be a valid calendar date` });
  }
}

function validateOptionalDateOnly(
  value: string | null,
  field: string,
  errors: OrderFieldError[],
): void {
  if (value === null) {
    return;
  }

  validateDateOnly(value, field, errors);
}

function validateOptionalDateTime(
  value: string | null,
  field: string,
  errors: OrderFieldError[],
): void {
  if (value === null) {
    return;
  }

  if (!ISO_DATE_TIME_RE.test(value) || Number.isNaN(Date.parse(value))) {
    errors.push({ field, message: `${field} must be an ISO datetime` });
  }
}

function requirePositiveInteger(
  value: number | null | undefined,
  field: string,
  errors: OrderFieldError[],
): void {
  if (value === null || value === undefined || !Number.isInteger(value) || value <= 0) {
    errors.push({ field, message: `${field} must be a positive integer` });
  }
}

function requireNonNegativeInteger(
  value: number | null | undefined,
  field: string,
  errors: OrderFieldError[],
): void {
  if (value === null || value === undefined || !Number.isInteger(value) || value < 0) {
    errors.push({ field, message: `${field} must be a non-negative integer` });
  }
}

function requirePositiveIntegerIfPresent(
  value: number | null | undefined,
  field: string,
  errors: OrderFieldError[],
): void {
  if (value === null || value === undefined) {
    return;
  }

  requirePositiveInteger(value, field, errors);
}

function requirePositive(value: number | null | undefined, field: string, errors: OrderFieldError[]): void {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    errors.push({ field, message: `${field} must be greater than zero` });
  }
}

function requireNonNegative(
  value: number | null | undefined,
  field: string,
  errors: OrderFieldError[],
): void {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    errors.push({ field, message: `${field} must be greater than or equal to zero` });
  }
}

function requireNonNegativeIfPresent(
  value: number | null | undefined,
  field: string,
  errors: OrderFieldError[],
): void {
  if (value === null || value === undefined) {
    return;
  }

  requireNonNegative(value, field, errors);
}
