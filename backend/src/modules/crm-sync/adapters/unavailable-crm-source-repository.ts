import type { ClientRow, CrmSourcePort, OrderRow, PaymentRow } from '../application/crm-sync.types';

/**
 * Fallback CrmSourcePort implementation used when no DATABASE_URL is configured.
 * All methods return empty/null values — no error thrown so the relay can still
 * start (it will be gated off by flags.enabled anyway).
 */
export class UnavailableCrmSourceRepository implements CrmSourcePort {
  getClientById(_id: string): Promise<ClientRow | null> {
    return Promise.resolve(null);
  }

  getOrderById(_id: string): Promise<OrderRow | null> {
    return Promise.resolve(null);
  }

  getPaymentsByOrderId(_orderId: string): Promise<PaymentRow[]> {
    return Promise.resolve([]);
  }

  hasOrdersForClient(_clientId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  listClientIds(_afterId: string, _limit: number): Promise<string[]> {
    return Promise.resolve([]);
  }

  listOrderIds(_afterId: string, _limit: number): Promise<string[]> {
    return Promise.resolve([]);
  }
}
