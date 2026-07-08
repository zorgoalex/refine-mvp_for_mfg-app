import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDowelingLinkDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  NormalizedSaveOrderRequirementDto,
  NormalizedSaveOrderWorkshopDto,
  OrderTotalsDto,
} from './save-order.dto';
import type { OrderGroupSummaryDto } from './order-group-link.dto';

export interface OrderDto {
  header: OrderHeaderDto;
  details: OrderDetailDto[];
  payments: OrderPaymentDto[];
  workshops: OrderWorkshopDto[];
  requirements: OrderRequirementDto[];
  dowelingLinks: OrderDowelingLinkDto[];
  primaryGroup: OrderGroupSummaryDto | null;
  groups: OrderGroupSummaryDto[];
  totals: Pick<
    OrderTotalsDto,
    'totalAmount' | 'finalAmount' | 'paidAmount' | 'debtAmount' | 'partsCount' | 'totalArea'
  >;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: number | null;
  editedBy: number | null;
}

export interface OrderResponseDto {
  order: OrderDto;
}

export interface DeleteOrderResponseDto {
  success: true;
  orderId: number;
  auditId?: string;
  requestId: string;
}

export interface OrderListResponseDto {
  data: OrderListItemDto[];
  pagination: PaginationDto;
}

export interface OrderAuditListResponseDto {
  data: OrderAuditEventDto[];
  pagination: PaginationDto;
  requestId: string;
}

export interface OrderAuditEventDto {
  auditId: string;
  entityType: string | null;
  entityId: string | null;
  action: string;
  userId: number | null;
  username: string | null;
  role: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: Record<string, unknown> | null;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface PaginationDto {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface OrderListItemDto {
  orderId: number;
  orderName: string;
  projectId: number;
  projectCode: string;
  fullNumber: string;
  clientId: number;
  clientName: string | null;
  orderDate: string;
  plannedCompletionDate: string | null;
  completionDate: string | null;
  issueDate: string | null;
  paymentDate: string | null;
  orderStatusId: number;
  orderStatusName: string;
  paymentStatusId: number;
  paymentStatusName: string;
  productionStatusId: number | null;
  productionStatusName: string | null;
  priority: number;
  totalAmount: number;
  discount: number;
  surcharge: number;
  finalAmount: number;
  paidAmount: number;
  debtAmount: number;
  partsCount: number;
  totalArea: number;
  managerId: number | null;
  notes: string | null;
  /** @deprecated Variant B: always empty post-034; use sheetMaterialTypeIds. */
  materialIds: number[];
  materialNames: string[];
  filmNames: string[];
  /** Variant B: aggregated sheet material type IDs from order details (authoritative post-034). */
  sheetMaterialTypeIds: number[];
  // SP3: header material-name fallback for header-only/no-details sheet orders (backend-read).
  headerMaterialName: string | null;
  headerSheetMaterialTypeId: number | null;
  millingTypeId: number | null;
  millingTypeName: string | null;
  dowelingOrderId: number | null;
  dowelingOrderName: string | null;
  designEngineerId: number | null;
  passedProductionStatusCodes: string[];
  primaryGroup: OrderGroupSummaryDto | null;
  groups: OrderGroupSummaryDto[];
  createdBy: number | null;
  editedBy: number | null;
  updatedAt: string;
  version: number;
}

export type OrderHeaderDto = NormalizedSaveOrderHeaderDto & {
  orderId: number;
  clientName: string | null;
  paymentStatusId: number;
  totalAmount: number;
  finalAmount: number;
  paidAmount: number;
  partsCount: number;
  totalArea: number;
  createdAt: string;
  updatedAt: string;
  createdBy: number | null;
  editedBy: number | null;
  version: number;
  // SP3: server-resolved COALESCE(sheet,material) name + durable era marker for FE picker gating.
  materialName?: string | null;
  sheetEligible?: boolean;
  // Projects: заполняются в create-ответе (авто-созданный или выбранный корень).
  projectId?: number;
  projectCode?: string;
};

export type OrderDetailDto = CalculatedOrderDetailDto & {
  id: number;
  orderId: number;
  // SP3: server-resolved COALESCE(sheet,material) display name (no sheet_materials.view needed).
  materialName?: string | null;
};

export type OrderPaymentDto = NormalizedSaveOrderPaymentDto & {
  id: number;
  orderId: number;
};

export type OrderWorkshopDto = NormalizedSaveOrderWorkshopDto & {
  id: number;
  orderId: number;
};

export type OrderRequirementDto = NormalizedSaveOrderRequirementDto & {
  id: number;
  orderId: number;
};

export type OrderDowelingLinkDto = NormalizedSaveOrderDowelingLinkDto & {
  id: number;
  orderId: number;
  dowelingOrder: {
    id: number;
    name: string | null;
    designEngineerId: number | null;
  } | null;
};
