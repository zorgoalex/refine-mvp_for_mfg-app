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
