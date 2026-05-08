import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDowelingLinkDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  NormalizedSaveOrderRequirementDto,
  NormalizedSaveOrderWorkshopDto,
  OrderTotalsDto,
} from './save-order.dto';

export interface OrderDto {
  header: OrderHeaderDto;
  details: OrderDetailDto[];
  payments: OrderPaymentDto[];
  workshops: OrderWorkshopDto[];
  requirements: OrderRequirementDto[];
  dowelingLinks: OrderDowelingLinkDto[];
  totals: Pick<
    OrderTotalsDto,
    'totalAmount' | 'finalAmount' | 'paidAmount' | 'debtAmount' | 'partsCount' | 'totalArea'
  >;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrderResponseDto {
  order: OrderDto;
}

export interface OrderListResponseDto {
  data: OrderListItemDto[];
  pagination: PaginationDto;
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
  materialIds: number[];
  materialNames: string[];
  millingTypeId: number | null;
  millingTypeName: string | null;
  dowelingOrderId: number | null;
  dowelingOrderName: string | null;
  designEngineerId: number | null;
  passedProductionStatusCodes: string[];
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
  version: number;
};

export type OrderDetailDto = CalculatedOrderDetailDto & {
  id: number;
  orderId: number;
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
