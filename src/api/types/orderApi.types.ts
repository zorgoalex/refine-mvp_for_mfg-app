export type DateOnlyString = string;
export type IsoDateTimeString = string;

import type { EntityGroupLink } from './groupApi.types';

export interface SaveOrderDto {
  header: SaveOrderHeaderDto;
  details: SaveOrderDetailDto[];
  payments: SaveOrderPaymentDto[];
  workshops: SaveOrderWorkshopDto[];
  requirements: SaveOrderRequirementDto[];
  dowelingLinks: SaveOrderDowelingLinkDto[];
  deleted: DeletedOrderChildrenDto;
  version?: number;
}

export interface SaveOrderResponse {
  order: OrderDto;
}

export interface OrderResponse {
  order: OrderDto;
}

export interface OrderListResponse {
  data: OrderListItemDto[];
  pagination: Pagination;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type OrderSortBy =
  | 'orderId'
  | 'orderName'
  | 'orderDate'
  | 'plannedCompletionDate'
  | 'completionDate'
  | 'issueDate'
  | 'clientName'
  | 'orderStatusName'
  | 'paymentStatusName'
  | 'productionStatusName'
  | 'finalAmount'
  | 'paidAmount'
  | 'debtAmount'
  | 'updatedAt';

export type SortOrder = 'asc' | 'desc';

export interface OrderListQuery {
  page?: number;
  pageSize?: number;
  sortBy?: OrderSortBy;
  sortOrder?: SortOrder;
  search?: string;
  clientId?: number;
  orderStatusId?: number;
  paymentStatusId?: number;
  productionStatusId?: number;
  dateFrom?: DateOnlyString;
  dateTo?: DateOnlyString;
  onlyMyOrders?: boolean;
  groupIds?: string[];
  groupMode?: 'any' | 'all' | 'primary' | 'none';
}

export interface ChangeOrderStatusRequest {
  orderStatusId: number;
  productionStatusId?: number | null;
  version: number;
}

export interface DeleteOrderRequest {
  version: number;
  idempotencyKey?: string;
}

export interface DeleteOrderResponse {
  success: true;
  orderId: number;
  auditId?: string;
  requestId: string;
}

export interface ExportOrderRequest {
  format?: 'xlsx';
  fileName?: string | null;
}

export interface ExportOrderResponse {
  success: boolean;
  fileName: string;
  folder?: string | null;
  xlsxUrl?: string | null;
  externalId?: string | null;
}

export interface ImportOrderSnapshotResponse {
  success: true;
  status: 'created' | 'updated' | 'noop';
  orderId: number;
  orderName: string;
  payloadHash: string;
  importRunId: string | null;
  summary: {
    details: number;
    payments: number;
    workshops: number;
    requirements: number;
    dowelingLinks: number;
    productionStatusEvents: number;
    clientPhones: number;
    deadlineInstances: number;
    deadlineEvents: number;
  };
}

export interface ImportOrderSnapshotBatchResponse {
  success: true;
  total: number;
  imported: number;
  failed: number;
  results: Array<
    | ({ fileName: string } & ImportOrderSnapshotResponse)
    | { fileName: string; success: false; errorCode: string; message: string }
  >;
}

export interface IdNameLookup {
  id: number;
  name: string;
}

export interface MaterialLookup extends IdNameLookup {
  unitId: number | null;
}

export interface MillingTypeLookup extends IdNameLookup {
  costPerSqm: number | null;
}

// SP3: present only when the caller has sheet_materials.view (service-masked).
// Variant B: isCuttable=false = header-only material; DETAIL picker must exclude these.
export interface SheetMaterialTypeLookup extends IdNameLookup {
  widthMm: number | null;
  heightMm: number | null;
  isActive: boolean;
  isCuttable: boolean;
}

export interface StatusLookup extends IdNameLookup {
  code?: string | null;
  color?: string | null;
}

export interface EmployeeLookup {
  id: number;
  fullName: string;
}

export interface UnitLookup {
  id: number;
  code: string;
  name: string;
  symbol?: string;
}

export interface OrderFormDataResponse {
  clients: IdNameLookup[];
  materials: MaterialLookup[];
  millingTypes: MillingTypeLookup[];
  edgeTypes: IdNameLookup[];
  films: IdNameLookup[];
  orderStatuses: StatusLookup[];
  paymentStatuses: StatusLookup[];
  paymentTypes: IdNameLookup[];
  productionStatuses: StatusLookup[];
  workshops: IdNameLookup[];
  employees: EmployeeLookup[];
  units: UnitLookup[];
  // SP3: optional — omitted when the caller lacks sheet_materials.view.
  sheetMaterialTypes?: SheetMaterialTypeLookup[];
}

export interface SaveOrderHeaderDto {
  orderName: string;
  clientId: number;
  orderDate: DateOnlyString;
  priority: number;

  orderStatusId: number;
  paymentStatusId?: number | null;
  productionStatusId?: number | null;
  productionStatusFromDetailsEnabled?: boolean;

  plannedCompletionDate?: DateOnlyString | null;
  completionDate?: DateOnlyString | null;
  issueDate?: DateOnlyString | null;
  paymentDate?: DateOnlyString | null;

  discount: number;
  surcharge: number;

  managerId?: number | null;

  /** @deprecated Variant B: always null; sheet_material_type_id is the authoritative order-material reference */
  materialId?: number | null;
  sheetMaterialTypeId?: number | null;
  millingTypeId?: number | null;
  edgeTypeId?: number | null;
  filmId?: number | null;

  linkCuttingFile?: string | null;
  linkCuttingImageFile?: string | null;
  linkCadFile?: string | null;
  linkPdfFile?: string | null;

  notes?: string | null;
  refKey1c?: string | null;
}

export interface SaveOrderDetailDto {
  id?: number;
  clientKey?: string;

  detailNumber: number;
  detailName?: string | null;

  height: number;
  width: number;
  quantity: number;

  /** @deprecated Variant B: always null for sheet details; sheetMaterialTypeId is the authoritative order-material reference */
  materialId?: number | null;
  sheetMaterialTypeId?: number | null;
  millingTypeId: number;
  edgeTypeId: number;
  filmId?: number | null;

  millingCostPerSqm?: number | null;
  detailCost: number;

  note?: string | null;
  priority: number;
  productionStatusId?: number | null;
  jointOrderId?: number | null;

  linkCuttingFile?: string | null;
  linkCuttingImageFile?: string | null;
  linkCadFile?: string | null;
  linkPdfFile?: string | null;
  basisProject?: string | null;
  basisData?: string | null;

  refKey1c?: string | null;
}

export interface SaveOrderPaymentDto {
  id?: number;
  clientKey?: string;

  typePaidId: number;
  amount: number;
  paymentDate: DateOnlyString;
  notes?: string | null;
  refKey1c?: string | null;
}

export interface SaveOrderWorkshopDto {
  id?: number;
  clientKey?: string;

  workshopId: number;
  productionStatusId: number;

  receivedDate?: DateOnlyString | null;
  startedDate?: DateOnlyString | null;
  completedDate?: DateOnlyString | null;
  plannedCompletionDate?: DateOnlyString | null;

  sequenceOrder?: number | null;
  responsibleEmployeeId?: number | null;
  notes?: string | null;
  refKey1c?: string | null;
}

export interface SaveOrderRequirementDto {
  id?: number;
  clientKey?: string;

  resourceType: 'material' | 'film' | 'edge' | string;

  materialId?: number | null;
  filmId?: number | null;
  edgeTypeId?: number | null;

  requiredQuantity: number;
  unitId: number;
  wastePercentage?: number | null;
  finalQuantity?: number | null;

  requirementStatusId: number;
  supplierId?: number | null;
  purchasePrice?: number | null;

  requisitionId?: number | null;
  warehouseId?: number | null;

  reservedAt?: IsoDateTimeString | null;
  consumedAt?: IsoDateTimeString | null;

  notes?: string | null;
  calculationDetails?: string | null;
  refKey1c?: string | null;
}

export interface SaveOrderDowelingLinkDto {
  id?: number;
  clientKey?: string;

  dowelingOrderId: number;
  designEngineerId?: number | null;
  refKey1c?: string | null;
}

export interface DeletedOrderChildrenDto {
  detailIds: number[];
  paymentIds: number[];
  workshopIds: number[];
  requirementIds: number[];
  dowelingLinkIds: number[];
}

export interface OrderDto {
  header: OrderHeaderDto;
  details: OrderDetailDto[];
  payments: PaymentDto[];
  workshops: OrderWorkshopDto[];
  requirements: OrderResourceRequirementDto[];
  dowelingLinks: OrderDowelingLinkDto[];
  primaryGroup: EntityGroupLink | null;
  groups: EntityGroupLink[];
  totals: OrderTotalsDto;
  version: number;
}

export interface OrderHeaderDto {
  orderId: number;
  orderName: string;
  clientId: number;
  clientName?: string | null;
  orderDate: DateOnlyString;
  managerId?: number | null;
  priority?: number | null;
  orderStatusId: number;
  orderStatusName?: string | null;
  paymentStatusId?: number | null;
  paymentStatusName?: string | null;
  productionStatusId?: number | null;
  productionStatusName?: string | null;
  productionStatusFromDetailsEnabled?: boolean | null;
  plannedCompletionDate?: DateOnlyString | null;
  completionDate?: DateOnlyString | null;
  issueDate?: DateOnlyString | null;
  paymentDate?: DateOnlyString | null;
  discount?: number | null;
  surcharge?: number | null;
  materialId?: number | null;
  sheetMaterialTypeId?: number | null;
  /** SP3: server-resolved COALESCE(sheet name, material name) for header display. */
  materialName?: string | null;
  millingTypeId?: number | null;
  edgeTypeId?: number | null;
  filmId?: number | null;
  linkCuttingFile?: string | null;
  linkCuttingImageFile?: string | null;
  linkCadFile?: string | null;
  linkPdfFile?: string | null;
  notes?: string | null;
  refKey1c?: string | null;
  createdAt?: IsoDateTimeString | null;
  updatedAt?: IsoDateTimeString | null;
  createdBy?: number | null;
  editedBy?: number | null;
  version?: number;
}

export interface OrderDetailDto {
  id: number;
  clientKey?: string | null;
  orderId?: number | null;
  detailNumber: number;
  detailName?: string | null;
  height: number;
  width: number;
  quantity: number;
  area?: number | null;
  /** Variant B: null for sheet-bearing details post-034 (material_id sunset). */
  materialId: number | null;
  sheetMaterialTypeId?: number | null;
  /** SP3: server-resolved COALESCE(sheet name, material name) for per-detail display. */
  materialName?: string | null;
  millingTypeId: number;
  edgeTypeId: number;
  filmId?: number | null;
  millingCostPerSqm?: number | null;
  detailCost: number;
  priority?: number | null;
  productionStatusId?: number | null;
  jointOrderId?: number | null;
  note?: string | null;
  basisProject?: string | null;
  basisData?: string | null;
  linkCuttingFile?: string | null;
  linkCuttingImageFile?: string | null;
  linkCadFile?: string | null;
  linkPdfFile?: string | null;
  refKey1c?: string | null;
}

export interface PaymentDto {
  id: number;
  clientKey?: string | null;
  orderId?: number | null;
  typePaidId: number;
  typePaidName?: string | null;
  amount: number;
  paymentDate: DateOnlyString;
  notes?: string | null;
  refKey1c?: string | null;
}

export interface OrderWorkshopDto {
  id: number;
  clientKey?: string | null;
  orderId?: number | null;
  workshopId: number;
  workshopName?: string | null;
  productionStatusId: number;
  receivedDate?: DateOnlyString | null;
  startedDate?: DateOnlyString | null;
  completedDate?: DateOnlyString | null;
  plannedCompletionDate?: DateOnlyString | null;
  sequenceOrder?: number | null;
  responsibleEmployeeId?: number | null;
  notes?: string | null;
  refKey1c?: string | null;
}

export interface OrderResourceRequirementDto {
  id: number;
  clientKey?: string | null;
  orderId?: number | null;
  resourceType: 'material' | 'film' | 'edge' | string;
  materialId?: number | null;
  filmId?: number | null;
  edgeTypeId?: number | null;
  requiredQuantity: number;
  unitId: number;
  wastePercentage?: number | null;
  finalQuantity?: number | null;
  requirementStatusId: number;
  supplierId?: number | null;
  purchasePrice?: number | null;
  requisitionId?: number | null;
  warehouseId?: number | null;
  reservedAt?: IsoDateTimeString | null;
  consumedAt?: IsoDateTimeString | null;
  notes?: string | null;
  calculationDetails?: string | null;
  refKey1c?: string | null;
}

export interface OrderDowelingLinkDto {
  id: number;
  clientKey?: string | null;
  orderId?: number | null;
  dowelingOrderId: number;
  designEngineerId?: number | null;
  designEngineerName?: string | null;
  refKey1c?: string | null;
  dowelingOrder?: {
    id?: number | null;
    name?: string | null;
    designEngineerId?: number | null;
    designEngineerName?: string | null;
  } | null;
}

export interface OrderTotalsDto {
  totalAmount: number;
  discount?: number;
  surcharge?: number;
  finalAmount: number;
  paidAmount: number;
  debtAmount: number;
  partsCount: number;
  totalArea: number;
}

export interface OrderListItemDto {
  orderId: number;
  orderName: string;
  clientId: number;
  clientName?: string | null;
  orderDate: DateOnlyString;
  plannedCompletionDate?: DateOnlyString | null;
  completionDate?: DateOnlyString | null;
  issueDate?: DateOnlyString | null;
  paymentDate?: DateOnlyString | null;
  orderStatusId: number;
  orderStatusName?: string | null;
  paymentStatusId?: number | null;
  paymentStatusName?: string | null;
  productionStatusId?: number | null;
  productionStatusName?: string | null;
  totalAmount?: number | null;
  discount?: number | null;
  surcharge?: number | null;
  finalAmount?: number | null;
  paidAmount?: number | null;
  debtAmount?: number | null;
  partsCount?: number | null;
  totalArea?: number | null;
  managerId?: number | null;
  priority?: number | null;
  notes?: string | null;
  /** @deprecated Variant B: always empty post-034; use sheetMaterialTypeIds. */
  materialIds?: number[];
  materialNames?: string[];
  filmNames?: string[];
  /** Variant B: aggregated sheet material type IDs from order details (authoritative post-034). */
  sheetMaterialTypeIds?: number[];
  /** SP3/R8: header material name fallback for header-only orders with no details. */
  headerMaterialName?: string | null;
  /** SP3/R8: header sheet material type id fallback for header-only orders with no details. */
  headerSheetMaterialTypeId?: number | null;
  millingTypeId?: number | null;
  millingTypeName?: string | null;
  dowelingOrderId?: number | null;
  dowelingOrderName?: string | null;
  designEngineerId?: number | null;
  passedProductionStatusCodes?: string[];
  primaryGroup?: EntityGroupLink | null;
  groups?: EntityGroupLink[];
  createdBy?: number | null;
  editedBy?: number | null;
  updatedAt?: IsoDateTimeString;
  version?: number;
}
