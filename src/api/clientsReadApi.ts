import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';

export interface ClientListFacts {
  clientId: number;
  primaryPhone: string | null;
  phonesCount: number;
  /** Orders the user may see; `null` — the user may not see orders. */
  orders: { count: number; last: { orderId: number; orderName: string; orderDate: string | null } | null } | null;
}

/** «Клиенты»: телефон, число заказов и последний заказ для клиентов одной страницы списка (backend). */
export const clientsReadApi = {
  async listFacts(clientIds: readonly number[]): Promise<ClientListFacts[]> {
    const ids = [...new Set(clientIds.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100);
    if (ids.length === 0) return [];
    const response = await httpClient.get<{ data: ClientListFacts[] }>(withQuery(apiRoutes.clientsRead.listFacts, { ids: ids.join(',') }));
    return response.data ?? [];
  },
};

export type ClientPersonTypeCode = 'individual' | 'legal';
export type ClientRecencySegment = 'active' | 'sleeping' | 'lost' | 'no_orders';
export type ClientFrequencyBucket = '1' | '2-3' | '4-9' | '10+';

export interface ClientsDashboardResponse {
  dateFrom: string;
  dateTo: string;
  personType: ClientPersonTypeCode | null;
  totals: { clients: number; newClients: number; buyers: number; repeatBuyers: number; orders: number; amount: string; paid: string };
  byDay: Array<{ date: string; newClients: number; orders: number; amount: string }>;
  byRecency: Array<{ segment: ClientRecencySegment; clients: number; amount: string }>;
  byFrequency: Array<{ bucket: ClientFrequencyBucket; clients: number; amount: string }>;
  byPersonType: Array<{ personType: ClientPersonTypeCode; buyers: number; orders: number; amount: string }>;
  topClients: Array<{ clientId: number; clientName: string; orders: number; amount: string; paid: string; lastOrderDate: string }>;
  toReactivate: Array<{ clientId: number; clientName: string; phone: string | null; orders: number; amount: string; lastOrderDate: string; daysSince: number }>;
}

export interface ClientAnalyticsCard {
  client: {
    clientId: number;
    clientName: string;
    personType: ClientPersonTypeCode;
    isActive: boolean;
    notes: string | null;
    createdAt: string | null;
    phones: Array<{ phone: string; isPrimary: boolean }>;
  };
  totals: {
    orders: number;
    ordersInProgress: number;
    amount: string;
    paid: string;
    debt: string;
    discount: string;
    area: string;
    parts: number;
    firstOrderDate: string | null;
    lastOrderDate: string | null;
    daysSinceLastOrder: number | null;
    averageIntervalDays: number | null;
    payments: number;
    lastPaymentDate: string | null;
  };
  byMonth: Array<{ month: string; orders: number; amount: string; paid: string }>;
  paymentTypes: Array<{ typePaidName: string | null; count: number; amount: string }>;
  orders: Array<{ orderId: number; orderName: string; orderDate: string | null; statusName: string | null; paymentStatusName: string | null; amount: string; paid: string; debt: string }>;
  payments: Array<{ paymentId: number; paymentDate: string; amount: string; typePaidName: string | null; orderId: number; orderName: string }>;
}

/** «+Клиенты (аналитика)»: дашборд и карточка клиента считает backend (права проверяются там же). */
export const clientsAnalyticsApi = {
  dashboard(params: { dateFrom: string; dateTo: string; personType?: ClientPersonTypeCode }): Promise<ClientsDashboardResponse> {
    return httpClient.get<ClientsDashboardResponse>(withQuery(apiRoutes.clientsRead.analyticsDashboard, params));
  },

  card(clientId: number): Promise<ClientAnalyticsCard> {
    if (!Number.isInteger(clientId) || clientId <= 0) throw new Error('clientId must be a positive integer');
    return httpClient.get<ClientAnalyticsCard>(apiRoutes.clientsRead.analyticsCard(clientId));
  },
};
