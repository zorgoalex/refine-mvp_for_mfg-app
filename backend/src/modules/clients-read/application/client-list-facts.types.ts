/** Facts shown next to a client in the operational «Клиенты» list. */
export interface ClientListFactsDto {
  clientId: number;
  /** Primary phone, or the first one when none is marked primary; `null` — no phones. */
  primaryPhone: string | null;
  phonesCount: number;
  /**
   * Orders of the client the user is allowed to see (their order visibility scope);
   * `null` when the user may not see orders at all.
   */
  orders: { count: number; last: { orderId: number; orderName: string; orderDate: string | null } | null } | null;
}

export interface ClientListFactsResponseDto {
  data: ClientListFactsDto[];
}

/** Which orders are counted: the shared client order read scope (the rule of the orders list and the order card). */
export type { ClientOrderReadScope as ClientOrdersScope } from '../../party-contacts/client-order-read-scope';

/** At most this many clients per request (one page of the list). */
export const CLIENT_LIST_FACTS_MAX_IDS = 100;
