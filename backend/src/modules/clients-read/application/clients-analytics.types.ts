/** Longest period of the clients dashboard. */
export const CLIENTS_DASHBOARD_MAX_DAYS = 366;

export type ClientPersonType = 'individual' | 'legal';

export interface ClientsDashboardQuery {
  /** Inclusive period (order date / client creation date), at most {@link CLIENTS_DASHBOARD_MAX_DAYS} days. */
  dateFrom: string;
  dateTo: string;
  /** Limit everything to physical persons or to companies. */
  personType?: ClientPersonType;
}

/** How long ago the client ordered last, as of today. */
export const CLIENT_RECENCY_SEGMENTS = ['active', 'sleeping', 'lost', 'no_orders'] as const;
export type ClientRecencySegment = (typeof CLIENT_RECENCY_SEGMENTS)[number];
/** Days since the last order: up to 90 — active, up to 365 — sleeping, more — lost. */
export const ACTIVE_DAYS = 90;
export const SLEEPING_DAYS = 365;

/** Number of orders over the whole history. */
export const CLIENT_FREQUENCY_BUCKETS = ['1', '2-3', '4-9', '10+'] as const;
export type ClientFrequencyBucket = (typeof CLIENT_FREQUENCY_BUCKETS)[number];

/**
 * Dashboard of the clients analytics. Only real orders are counted (not deleted, not CRM requests or
 * drafts); an order amount is coalesce(final_amount, total_amount). Amounts are decimal strings.
 */
export interface ClientsDashboardDto {
  dateFrom: string;
  dateTo: string;
  personType: ClientPersonType | null;
  totals: {
    /** All clients (of the chosen person type). */
    clients: number;
    /** Created in the period. */
    newClients: number;
    /** Ordered in the period. */
    buyers: number;
    /** Of them, with at least two orders over the whole history. */
    repeatBuyers: number;
    /** Orders of the period and their amounts. */
    orders: number;
    amount: string;
    paid: string;
  };
  /** Every day of the period, oldest first. */
  byDay: Array<{ date: string; newClients: number; orders: number; amount: string }>;
  /** All clients by how long ago they ordered last (as of today) with their lifetime revenue. */
  byRecency: Array<{ segment: ClientRecencySegment; clients: number; amount: string }>;
  /** Clients who ordered at least once, by their number of orders over the whole history. */
  byFrequency: Array<{ bucket: ClientFrequencyBucket; clients: number; amount: string }>;
  /** Orders of the period by person type. */
  byPersonType: Array<{ personType: ClientPersonType; buyers: number; orders: number; amount: string }>;
  /** Largest clients of the period, at most ten. */
  topClients: Array<{ clientId: number; clientName: string; orders: number; amount: string; paid: string; lastOrderDate: string }>;
  /** Sleeping clients with the largest lifetime revenue — whom to call back, at most ten. */
  toReactivate: Array<{ clientId: number; clientName: string; phone: string | null; orders: number; amount: string; lastOrderDate: string; daysSince: number }>;
}

/** Everything about one client for the analytics card. Months without orders or payments are zero. */
export interface ClientAnalyticsCardDto {
  client: {
    clientId: number;
    clientName: string;
    personType: ClientPersonType;
    isActive: boolean;
    notes: string | null;
    createdAt: string | null;
    phones: Array<{ phone: string; isPrimary: boolean }>;
  };
  totals: {
    orders: number;
    /** Orders not yet handed to the client. */
    ordersInProgress: number;
    amount: string;
    paid: string;
    /**
     * The client's balance: ordered − paid over all orders, the same figure as `debt_sum` of the analytics
     * list. Positive — the client owes; negative — an overpayment; an overpaid order offsets an unpaid one.
     */
    debt: string;
    discount: string;
    area: string;
    parts: number;
    firstOrderDate: string | null;
    lastOrderDate: string | null;
    daysSinceLastOrder: number | null;
    /** Average number of days between consecutive orders; `null` with fewer than two orders. */
    averageIntervalDays: number | null;
    payments: number;
    lastPaymentDate: string | null;
  };
  /** The last twelve calendar months, oldest first. */
  byMonth: Array<{ month: string; orders: number; amount: string; paid: string }>;
  paymentTypes: Array<{ typePaidName: string | null; count: number; amount: string }>;
  /** The last thirty orders, newest first. */
  orders: Array<{
    orderId: number;
    orderName: string;
    orderDate: string | null;
    statusName: string | null;
    paymentStatusName: string | null;
    amount: string;
    paid: string;
    /** The unpaid rest of this order, never negative. */
    debt: string;
  }>;
  /** The last thirty payments, newest first. */
  payments: Array<{ paymentId: number; paymentDate: string; amount: string; typePaidName: string | null; orderId: number; orderName: string }>;
}
