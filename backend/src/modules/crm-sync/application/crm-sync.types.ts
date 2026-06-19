export interface ClientRow {
  clientId: string;
  clientName: string;
  notes: string | null;
  isActive: boolean;
}

export interface OrderRow {
  orderId: string;
  orderNumber: string;
  orderName: string;
  clientId: string;
  totalAmount: number | null;
  finalAmount: number | null;
  paidAmount: number | null;
  orderStatusName: string | null;
  paymentStatusName: string | null;
  orderDate: string | null;
  completionDate: string | null;
  deleteFlag: boolean;
}

export interface CrmSourcePort {
  getClientById(id: string): Promise<ClientRow | null>;
  getOrderById(id: string): Promise<OrderRow | null>;
  listClientIds(afterId: string, limit: number): Promise<string[]>;
  listOrderIds(afterId: string, limit: number): Promise<string[]>;
}

export interface MappingRow {
  entityType: string;
  erpId: string;
  twentyObject: string;
  twentyId: string | null;
  status: string;
  lastHash: string | null;
}
