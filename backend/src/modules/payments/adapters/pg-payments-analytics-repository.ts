import type { DatabaseClient } from '../../../database/database.types';
import type { PaymentsAnalyticsSummaryDto, PaymentsAnalyticsSummaryQuery } from '../application/payments-analytics.types';

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
}
