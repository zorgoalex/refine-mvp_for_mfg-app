import type { CurrentUser } from '../../../permissions/current-user';

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

/**
 * Which ERP orders of a client are read: none, or the ones the viewer may read — all of them or only the viewer's
 * own (creator or manager). The SQL of the rule is the shared order read visibility, built from `viewer` by the
 * repositories.
 */
export type ClientOrderReadScope = { kind: 'all'; viewer: CurrentUser } | { kind: 'own'; viewer: CurrentUser } | { kind: 'none' };

/** At most this many clients per request (one page of the list). */
export const CLIENT_LIST_FACTS_MAX_IDS = 100;
