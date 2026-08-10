export type OrderStatusBoardType = 'order' | 'production';
export type OrderStatusBoardSortBy =
  | 'priority'
  | 'orderNumber'
  | 'plannedDate'
  | 'updatedAt';
export type OrderStatusBoardSortOrder = 'asc' | 'desc';

export interface OrderStatusBoardQuery {
  board: OrderStatusBoardType;
  column?: string;
  cursor?: string;
  limit?: number;
  search?: string;
  onlyMyOrders?: boolean;
  overdueOnly?: boolean;
  includeDone?: boolean;
  plannedFrom?: string;
  plannedTo?: string;
  orderIds?: number[];
  sortBy?: OrderStatusBoardSortBy;
  sortOrder?: OrderStatusBoardSortOrder;
}

export interface OrderStatusBoardStatus {
  id: number | null;
  code: string | null;
  name: string;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface OrderStatusBoardCardDetail {
  detailId: number;
  detailNumber: number | null;
  quantity: number;
  bazisCutQuantity: number;
}

export interface OrderStatusBoardCard {
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
  details: OrderStatusBoardCardDetail[];
  managerId: number | null;
  managerName: string | null;
  updatedAt: string;
  version: number;
  canChangeOrderStatus: boolean;
  canChangeProductionStatus: boolean;
}

export interface OrderStatusBoardColumn {
  key: string;
  status: OrderStatusBoardStatus;
  total: number;
  cards: OrderStatusBoardCard[];
  nextCursor: string | null;
}

export interface OrderStatusBoardResponse {
  board: OrderStatusBoardType;
  generatedAt: string;
  filterKey: string;
  financialsVisible: boolean;
  columns: OrderStatusBoardColumn[];
}
