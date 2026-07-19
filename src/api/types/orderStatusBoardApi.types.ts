export type OrderStatusBoardType = 'order' | 'production';

export interface OrderStatusBoardQuery {
  board: OrderStatusBoardType;
  column?: string;
  cursor?: string;
  limit?: number;
  search?: string;
  onlyMyOrders?: boolean;
  overdueOnly?: boolean;
  plannedFrom?: string;
  plannedTo?: string;
}

export interface OrderStatusBoardStatus {
  id: number | null;
  code: string | null;
  name: string;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
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

