export type OrderStatusBoardType = 'order' | 'production';

export interface OrderStatusBoardStatusDto {
  id: number | null;
  code: string | null;
  name: string;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface OrderStatusBoardCardDto {
  orderId: number;
  orderName: string;
  fullNumber: string;
  clientId: number;
  clientName: string | null;
  priority: number;
  plannedCompletionDate: string | null;
  pastPlannedDate: boolean;
  orderStatusId: number;
  orderStatusName: string;
  orderStatusIssuedOrLater: boolean;
  productionStatusId: number | null;
  productionStatusName: string | null;
  productionStatusFromDetailsEnabled: boolean;
  paymentStatusId: number | null;
  paymentStatusName: string | null;
  finalAmount: number | null;
  paidAmount: number | null;
  debtAmount: number | null;
  partsCount: number;
  totalArea: number;
  managerId: number | null;
  managerName: string | null;
  updatedAt: string;
  version: number;
  canChangeOrderStatus: boolean;
  canChangeProductionStatus: boolean;
}

export interface OrderStatusBoardColumnDto {
  key: string;
  status: OrderStatusBoardStatusDto;
  total: number;
  cards: OrderStatusBoardCardDto[];
  nextCursor: string | null;
}

export interface OrderStatusBoardResponseDto {
  board: OrderStatusBoardType;
  generatedAt: string;
  filterKey: string;
  financialsVisible: boolean;
  columns: OrderStatusBoardColumnDto[];
}
