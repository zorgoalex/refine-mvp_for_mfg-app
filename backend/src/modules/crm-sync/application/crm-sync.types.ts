export type ClientPersonType = 'individual' | 'legal';

export interface ClientPhoneRow {
  phoneNumber: string;
  phoneType: 'mobile' | 'work' | 'home' | 'fax';
  isPrimary: boolean;
}

export interface ClientRow {
  clientId: string;
  clientName: string;
  personType: ClientPersonType;
  notes: string | null;
  isActive: boolean;
  phones: ClientPhoneRow[];
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

export interface PaymentRow {
  paymentId: string;
  orderId: string;
  typePaidId: string;
  typePaidName: string | null;
  amount: number;
  paymentDate: string;
  notes: string | null;
}

export interface CrmSourcePort {
  getClientById(id: string): Promise<ClientRow | null>;
  getOrderById(id: string): Promise<OrderRow | null>;
  getPaymentsByOrderId(orderId: string): Promise<PaymentRow[]>;
  hasOrdersForClient(clientId: string): Promise<boolean>;
  listClientIds(afterId: string, limit: number): Promise<string[]>;
  listOrderIds(afterId: string, limit: number): Promise<string[]>;
}

export interface MappingRow {
  entityType: string;
  erpId: string;
  bitrixObject: string;
  bitrixId: string | null;
  parentErpId: string | null;
  status: string;
  lastHash: string | null;
}

export interface PaymentCreateGuardRow {
  erpPaymentId: string;
  erpOrderId: string;
  bitrixDealId: string;
  beforeIds: string[];
}
