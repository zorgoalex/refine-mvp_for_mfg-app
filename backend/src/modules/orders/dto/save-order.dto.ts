export const STANDARD_PAYMENT_STATUS_IDS = {
  NOT_PAID: 1,
  PARTIALLY_PAID: 2,
  PAID: 3,
} as const;

export type OrderSaveMode = 'create' | 'update';

export interface SaveOrderDto {
  header: SaveOrderHeaderDto;
  details: SaveOrderDetailDto[];
  hdfDetails?: SaveOrderHdfDetailDto[];
  payments: SaveOrderPaymentDto[];
  workshops: SaveOrderWorkshopDto[];
  requirements: SaveOrderRequirementDto[];
  dowelingLinks: SaveOrderDowelingLinkDto[];
  deleted: SaveOrderDeletedDto;
  /** Transient command intent. Never persisted or copied into order details. */
  bazisImportCandidateClientKeys?: string[];
  version?: number;
  idempotencyKey?: string;
}

export interface SaveOrderHeaderDto {
  orderId?: number;
  projectId?: number | null;
  orderName: string;
  clientId: number;
  orderDate: string;
  priority?: number;
  managerId?: number | null;
  orderStatusId: number;
  paymentStatusId?: number | null;
  productionStatusId?: number | null;
  productionStatusFromDetailsEnabled?: boolean;
  plannedCompletionDate?: string | null;
  completionDate?: string | null;
  issueDate?: string | null;
  paymentDate?: string | null;
  discount?: number | null;
  surcharge?: number | null;
  linkCuttingFile?: string | null;
  linkCuttingImageFile?: string | null;
  linkCadFile?: string | null;
  linkPdfFile?: string | null;
  notes?: string | null;
  refKey1c?: string | null;
  materialId?: number | null;
  sheetMaterialTypeId?: number | null;
  millingTypeId?: number | null;
  edgeTypeId?: number | null;
  filmId?: number | null;
  hdfMinThresholdMm?: number | null;
}

export interface SaveOrderDetailDto {
  id?: number;
  clientKey?: string;
  detailNumber?: number;
  detailName?: string | null;
  height: number;
  width: number;
  quantity: number;
  /** @deprecated Variant B: always NULL for sheet-bearing rows (post-034). Use sheetMaterialTypeId. */
  materialId: number | null;
  sheetMaterialTypeId?: number | null;
  millingTypeId: number;
  hdfParameterOverrideMm?: number | null;
  edgeTypeId: number;
  filmId?: number | null;
  area?: number | null;
  millingCostPerSqm?: number | null;
  detailCost?: number | null;
  priority?: number;
  productionStatusId?: number | null;
  jointOrderId?: number | null;
  note?: string | null;
  basisProject?: string | null;
  basisProduct?: string | null;
  basisData?: string | null;
  basisDesignation?: string | null;
  doweling?: boolean | null;
  linkCuttingFile?: string | null;
  linkCuttingImageFile?: string | null;
  linkCadFile?: string | null;
  linkPdfFile?: string | null;
  refKey1c?: string | null;
}

export interface SaveOrderHdfDetailDto {
  id: number;
  version: number;
  productionStatusId?: number | null;
}

export interface SaveOrderPaymentDto {
  id?: number;
  clientKey?: string;
  typePaidId: number;
  amount: number;
  paymentDate: string;
  notes?: string | null;
  refKey1c?: string | null;
}

export interface SaveOrderWorkshopDto {
  id?: number;
  clientKey?: string;
  workshopId: number;
  productionStatusId: number;
  receivedDate?: string | null;
  startedDate?: string | null;
  completedDate?: string | null;
  plannedCompletionDate?: string | null;
  sequenceOrder?: number | null;
  responsibleEmployeeId?: number | null;
  notes?: string | null;
  refKey1c?: string | null;
}

export type OrderResourceType = 'material' | 'film' | 'edge';

export interface SaveOrderRequirementDto {
  id?: number;
  clientKey?: string;
  resourceType: OrderResourceType | string;
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
  reservedAt?: string | null;
  consumedAt?: string | null;
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

export interface SaveOrderDeletedDto {
  detailIds?: number[];
  hdfDetailIds?: number[];
  paymentIds?: number[];
  workshopIds?: number[];
  requirementIds?: number[];
  dowelingLinkIds?: number[];
}

export type NormalizedSaveOrderDto = Omit<
  SaveOrderDto,
  'header' | 'details' | 'payments' | 'workshops' | 'requirements' | 'dowelingLinks' | 'deleted' | 'bazisImportCandidateClientKeys'
> & {
  header: NormalizedSaveOrderHeaderDto;
  details: NormalizedSaveOrderDetailDto[];
  hdfDetails: NormalizedSaveOrderHdfDetailDto[];
  payments: NormalizedSaveOrderPaymentDto[];
  workshops: NormalizedSaveOrderWorkshopDto[];
  requirements: NormalizedSaveOrderRequirementDto[];
  dowelingLinks: NormalizedSaveOrderDowelingLinkDto[];
  deleted: Required<SaveOrderDeletedDto>;
  bazisImportCandidateClientKeys: string[];
};

export type NormalizedSaveOrderHeaderDto = Required<
  Pick<
    SaveOrderHeaderDto,
    | 'orderName'
    | 'clientId'
    | 'orderDate'
    | 'priority'
    | 'orderStatusId'
    | 'productionStatusFromDetailsEnabled'
  >
> &
  Omit<
    SaveOrderHeaderDto,
    | 'orderName'
    | 'clientId'
    | 'orderDate'
    | 'priority'
    | 'orderStatusId'
    | 'productionStatusFromDetailsEnabled'
  > & {
    discount: number;
    surcharge: number;
    hdfMinThresholdMm: number | null;
  };

export type NormalizedSaveOrderDetailDto = Omit<
  SaveOrderDetailDto,
  | 'materialId'
  | 'detailName'
  | 'filmId'
  | 'hdfParameterOverrideMm'
  | 'millingCostPerSqm'
  | 'detailCost'
  | 'priority'
  | 'productionStatusId'
  | 'jointOrderId'
  | 'note'
  | 'basisProject'
  | 'basisProduct'
  | 'basisData'
  | 'basisDesignation'
  | 'doweling'
  | 'linkCuttingFile'
  | 'linkCuttingImageFile'
  | 'linkCadFile'
  | 'linkPdfFile'
  | 'refKey1c'
> & {
  // VARIANT B: order_details.material_id is nullable (migration 034); always written as NULL.
  materialId: number | null;
  detailName: string | null;
  filmId: number | null;
  hdfParameterOverrideMm?: number | null;
  millingCostPerSqm: number | null;
  detailCost: number | null;
  priority: number;
  productionStatusId: number | null;
  jointOrderId: number | null;
  note: string | null;
  basisProject?: string | null;
  basisProduct?: string | null;
  basisData?: string | null;
  basisDesignation?: string | null;
  doweling: boolean;
  linkCuttingFile: string | null;
  linkCuttingImageFile: string | null;
  linkCadFile: string | null;
  linkPdfFile: string | null;
  refKey1c: string | null;
};

export type NormalizedSaveOrderHdfDetailDto = Required<
  Pick<SaveOrderHdfDetailDto, 'id' | 'version'>
> & {
  productionStatusId: number | null;
};

export type NormalizedSaveOrderPaymentDto = Omit<
  SaveOrderPaymentDto,
  'notes' | 'refKey1c'
> & {
  notes: string | null;
  refKey1c: string | null;
};

export type NormalizedSaveOrderWorkshopDto = Required<
  Pick<SaveOrderWorkshopDto, 'workshopId' | 'productionStatusId'>
> &
  Omit<SaveOrderWorkshopDto, 'workshopId' | 'productionStatusId'> & {
    receivedDate: string | null;
    startedDate: string | null;
    completedDate: string | null;
    plannedCompletionDate: string | null;
    sequenceOrder: number | null;
    responsibleEmployeeId: number | null;
    notes: string | null;
    refKey1c: string | null;
  };

export type NormalizedSaveOrderRequirementDto = Omit<
  SaveOrderRequirementDto,
  | 'materialId'
  | 'filmId'
  | 'edgeTypeId'
  | 'wastePercentage'
  | 'finalQuantity'
  | 'supplierId'
  | 'purchasePrice'
  | 'requisitionId'
  | 'warehouseId'
  | 'reservedAt'
  | 'consumedAt'
  | 'notes'
  | 'calculationDetails'
  | 'refKey1c'
> & {
  materialId: number | null;
  filmId: number | null;
  edgeTypeId: number | null;
  wastePercentage: number | null;
  finalQuantity: number | null;
  supplierId: number | null;
  purchasePrice: number | null;
  requisitionId: number | null;
  warehouseId: number | null;
  reservedAt: string | null;
  consumedAt: string | null;
  notes: string | null;
  calculationDetails: string | null;
  refKey1c: string | null;
};

export type NormalizedSaveOrderDowelingLinkDto = Omit<
  SaveOrderDowelingLinkDto,
  'designEngineerId' | 'refKey1c'
> & {
  designEngineerId?: number | null;
  refKey1c: string | null;
};

export interface CalculatedOrderDetailDto extends NormalizedSaveOrderDetailDto {
  detailNumber: number;
  area: number;
  detailCost: number;
}

export interface OrderTotalsDto {
  positionsCount: number;
  partsCount: number;
  totalArea: number;
  totalAmount: number;
  discount: number;
  surcharge: number;
  finalAmount: number;
  paidAmount: number;
  debtAmount: number;
  paymentDate: string | null;
  paymentStatusId: number;
}

export interface PreparedOrderSave {
  order: NormalizedSaveOrderDto;
  details: CalculatedOrderDetailDto[];
  totals: OrderTotalsDto;
}
