import type { DatabaseClient } from '../../../database/database.types';
import {
  RECEIVABLE_BUCKETS,
  type PaymentsAnalyticsSummaryDto,
  type PaymentsAnalyticsSummaryQuery,
  type PaymentsDashboardDto,
  type PaymentsDashboardQuery,
  type ReceivableBucket,
} from '../application/payments-analytics.types';

/** Order statuses that mean the order has been handed to the client: «Выдан», «Завершен». */
export const ISSUED_ORDER_STATUS_CODES = ['legacy_7', 'legacy_8'] as const;
/** Orders older than this are not counted as receivables (their payments were not entered historically). */
export const RECEIVABLE_MAX_AGE_DAYS = 365;

/** One filter → one SQL condition over `payments_view`; columns are fixed here, values go as parameters. */
type Condition = { sql: (placeholder: string) => string; value: unknown };

const contains = (column: string, value: string): Condition => ({
  // `%` and `_` in the search text are literal characters, not wildcards
  sql: (p) => `${column}::text ILIKE '%' || ${p} || '%' ESCAPE '\\'`,
  value: value.replace(/[\\%_]/g, (char) => `\\${char}`),
});
const compare = (column: string, operator: '=' | '>=' | '<=', cast: 'text' | 'date' | 'numeric', value: unknown): Condition => ({
  sql: (p) => `${column} ${operator} ${p}::${cast}`,
  value,
});

/** The list's filters as SQL conditions (the same fields the «+Платежи» screen filters by). */
export function paymentsAnalyticsConditions(query: PaymentsAnalyticsSummaryQuery): Condition[] {
  const conditions: Condition[] = [
    compare('payment_date', '>=', 'date', query.dateFrom),
    compare('payment_date', '<=', 'date', query.dateTo),
  ];
  const push = (value: unknown, build: (present: never) => Condition) => {
    if (value !== undefined && value !== null && value !== '') conditions.push(build(value as never));
  };
  push(query.orderName, (v: string) => contains('order_name', v));
  push(query.clientName, (v: string) => contains('client_name', v));
  push(query.notes, (v: string) => contains('notes', v));
  push(query.typePaidName, (v) => compare('type_paid_name', '=', 'text', v));
  push(query.orderStatusName, (v) => compare('order_status_name', '=', 'text', v));
  push(query.paymentStatusName, (v) => compare('payment_status_name', '=', 'text', v));
  push(query.productionStatusName, (v) => compare('production_status_name', '=', 'text', v));
  push(query.orderDateFrom, (v) => compare('order_date', '>=', 'date', v));
  push(query.orderDateTo, (v) => compare('order_date', '<=', 'date', v));
  push(query.amountMin, (v) => compare('amount', '>=', 'numeric', v));
  push(query.amountMax, (v) => compare('amount', '<=', 'numeric', v));
  push(query.orderAmountMin, (v) => compare('order_effective_final_amount', '>=', 'numeric', v));
  push(query.orderAmountMax, (v) => compare('order_effective_final_amount', '<=', 'numeric', v));
  push(query.totalPaymentsMin, (v) => compare('total_payments_for_order', '>=', 'numeric', v));
  push(query.totalPaymentsMax, (v) => compare('total_payments_for_order', '<=', 'numeric', v));
  push(query.orderBalanceMin, (v) => compare('order_balance_total', '>=', 'numeric', v));
  push(query.orderBalanceMax, (v) => compare('order_balance_total', '<=', 'numeric', v));
  return conditions;
}

interface SummaryRow {
  kind: 'total' | 'type' | 'day';
  label: string | null;
  payments: string | number;
  amount: string | null;
}

/**
 * Read model of the payments analytics summary: totals of the period, by payment type and by day,
 * over the same `payments_view` rows the analytics list shows. Read-only.
 */
export class PgPaymentsAnalyticsRepository {
  constructor(private readonly database: DatabaseClient) {}

  async summary(query: PaymentsAnalyticsSummaryQuery): Promise<PaymentsAnalyticsSummaryDto> {
    const conditions = paymentsAnalyticsConditions(query);
    const where = conditions.map((condition, index) => condition.sql(`$${index + 1}`)).join(' AND ');
    const result = await this.database.query<SummaryRow>(
      `WITH scoped AS (
         SELECT amount, type_paid_name, payment_date FROM payments_view WHERE ${where}
       )
       SELECT 'total' AS kind, NULL::text AS label, count(*) AS payments, coalesce(sum(amount), 0)::numeric(14,2)::text AS amount
         FROM scoped
       UNION ALL
       SELECT 'type', type_paid_name::text, count(*), coalesce(sum(amount), 0)::numeric(14,2)::text
         FROM scoped GROUP BY type_paid_name
       UNION ALL
       SELECT 'day', to_char(payment_date, 'YYYY-MM-DD'), count(*), coalesce(sum(amount), 0)::numeric(14,2)::text
         FROM scoped GROUP BY payment_date`,
      conditions.map((condition) => condition.value),
    );
    const rows = result.rows;
    const total = rows.find((row) => row.kind === 'total');
    const amountOf = (row: SummaryRow) => row.amount ?? '0.00';
    return {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      count: Number(total?.payments ?? 0),
      amount: total ? amountOf(total) : '0.00',
      byType: rows
        .filter((row) => row.kind === 'type')
        .map((row) => ({ typePaidName: row.label, count: Number(row.payments), amount: amountOf(row) }))
        .sort((left, right) => Number(right.amount) - Number(left.amount) || String(left.typePaidName).localeCompare(String(right.typePaidName))),
      byDay: rows
        .filter((row) => row.kind === 'day' && row.label !== null)
        .map((row) => ({ paymentDate: row.label as string, count: Number(row.payments), amount: amountOf(row) }))
        .sort((left, right) => right.paymentDate.localeCompare(left.paymentDate)),
    };
  }

  /**
   * Dashboard of a period: payments by day and by type, refunds, and the receivables of issued orders
   * (as of today, not of the period). Deleted payments and orders are left out.
   */
  async dashboard(query: PaymentsDashboardQuery): Promise<PaymentsDashboardDto> {
    const period = [query.dateFrom, query.dateTo];
    const payments = `FROM payments p JOIN orders o ON o.order_id = p.order_id
       WHERE p.delete_flag = false AND o.delete_flag = false
         AND p.payment_date >= $1::date AND p.payment_date <= $2::date`;
    const debt = 'COALESCE(o.final_amount, o.total_amount, 0) - COALESCE(o.paid_amount, 0)';
    // An order handed to the client: status «Выдан» or «Завершен». The dates of issue and completion are
    // not filled in the data, so the age of a debt is counted from the order date, and orders older than
    // a year are left out: in the historical data their payments were never entered.
    const issued = `o.delete_flag = false AND o.order_kind = 'production_order' AND ${debt} > 0
           AND o.order_date >= CURRENT_DATE - ${RECEIVABLE_MAX_AGE_DAYS}
           AND o.order_status_id IN (SELECT order_status_id FROM order_statuses WHERE order_status_code = ANY($1::text[]))`;
    const receivable = `FROM orders o WHERE ${issued}`;
    const issuedCodes = [[...ISSUED_ORDER_STATUS_CODES]];
    const money = (expression: string) => `coalesce(${expression}, 0)::numeric(14,2)::text`;
    const [totals, days, types, ages, debtors] = await Promise.all([
      this.database.query<{ received_count: string; received_amount: string; refund_count: string; refund_amount: string }>(
        `SELECT count(*) FILTER (WHERE p.amount >= 0) AS received_count,
                ${money('sum(p.amount) FILTER (WHERE p.amount >= 0)')} AS received_amount,
                count(*) FILTER (WHERE p.amount < 0) AS refund_count,
                ${money('sum(p.amount) FILTER (WHERE p.amount < 0)')} AS refund_amount
         ${payments}`,
        period,
      ),
      this.database.query<{ day: string; payments: string; amount: string }>(
        `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, count(x.amount) AS payments, ${money('sum(x.amount)')} AS amount
         FROM generate_series($1::date, $2::date, interval '1 day') AS d(day)
         LEFT JOIN (SELECT p.payment_date, p.amount ${payments} AND p.amount >= 0) x ON x.payment_date = d.day::date
         GROUP BY d.day ORDER BY d.day`,
        period,
      ),
      this.database.query<{ label: string | null; payments: string; amount: string }>(
        `SELECT pt.type_paid_name::text AS label, count(*) AS payments, ${money('sum(p.amount)')} AS amount
         FROM payments p JOIN orders o ON o.order_id = p.order_id
         LEFT JOIN payment_types pt ON pt.type_paid_id = p.type_paid_id
         WHERE p.delete_flag = false AND o.delete_flag = false AND p.amount >= 0
           AND p.payment_date >= $1::date AND p.payment_date <= $2::date
         GROUP BY pt.type_paid_name ORDER BY sum(p.amount) DESC, pt.type_paid_name`,
        period,
      ),
      this.database.query<{ bucket: ReceivableBucket; orders: string; amount: string }>(
        `SELECT CASE WHEN CURRENT_DATE - o.order_date <= 7 THEN '0-7'
                     WHEN CURRENT_DATE - o.order_date <= 30 THEN '8-30'
                     WHEN CURRENT_DATE - o.order_date <= 60 THEN '31-60'
                     ELSE '61+' END AS bucket,
                count(*) AS orders, ${money(`sum(${debt})`)} AS amount
         ${receivable} GROUP BY 1`,
        issuedCodes,
      ),
      this.database.query<{ client_id: string | number; client_name: string; orders: string; amount: string; oldest: string }>(
        `SELECT c.client_id, c.client_name::text AS client_name, count(*) AS orders,
                ${money(`sum(${debt})`)} AS amount, to_char(min(o.order_date), 'YYYY-MM-DD') AS oldest
         FROM orders o JOIN clients c ON c.client_id = o.client_id
         WHERE ${issued}
         GROUP BY c.client_id, c.client_name ORDER BY sum(${debt}) DESC, c.client_id LIMIT 10`,
        issuedCodes,
      ),
    ]);
    const total = totals.rows[0];
    const byAge = RECEIVABLE_BUCKETS.map((bucket) => {
      const row = ages.rows.find((candidate) => candidate.bucket === bucket);
      return { bucket, orders: Number(row?.orders ?? 0), amount: row?.amount ?? '0.00' };
    });
    return {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      received: { count: Number(total?.received_count ?? 0), amount: total?.received_amount ?? '0.00' },
      refunds: { count: Number(total?.refund_count ?? 0), amount: total?.refund_amount ?? '0.00' },
      byDay: days.rows.map((row) => ({ paymentDate: row.day, count: Number(row.payments), amount: row.amount })),
      byType: types.rows.map((row) => ({ typePaidName: row.label, count: Number(row.payments), amount: row.amount })),
      receivables: {
        orders: byAge.reduce((sum, bucket) => sum + bucket.orders, 0),
        amount: byAge.reduce((sum, bucket) => sum + Number(bucket.amount), 0).toFixed(2),
        byAge,
        topDebtors: debtors.rows.map((row) => ({
          clientId: Number(row.client_id),
          clientName: row.client_name,
          orders: Number(row.orders),
          amount: row.amount,
          oldestOrderDate: row.oldest,
        })),
      },
    };
  }
}
