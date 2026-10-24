import type { DatabaseClient } from '../../../database/database.types';
import {
  ACTIVE_DAYS,
  CLIENT_FREQUENCY_BUCKETS,
  CLIENT_RECENCY_SEGMENTS,
  SLEEPING_DAYS,
  type ClientAnalyticsCardDto,
  type ClientFrequencyBucket,
  type ClientPersonType,
  type ClientRecencySegment,
  type ClientsDashboardDto,
  type ClientsDashboardQuery,
} from '../application/clients-analytics.types';

/** Order statuses that mean the order has been handed to the client: «Выдан», «Завершен». */
const HANDED_OVER_STATUS_CODES = ['legacy_7', 'legacy_8'] as const;

/** A real order: not deleted, not a CRM request or a draft. */
const REAL_ORDER = `o.delete_flag = false AND o.order_kind = 'production_order'`;
const AMOUNT = 'COALESCE(o.final_amount, o.total_amount, 0)';
const PAID = 'COALESCE(o.paid_amount, 0)';
const money = (expression: string) => `coalesce(${expression}, 0)::numeric(14,2)::text`;
const count = (value: unknown) => Number(value ?? 0);

/** Read models of the clients analytics: the dashboard and the card of one client. Read-only. */
export class PgClientsAnalyticsRepository {
  constructor(private readonly database: DatabaseClient) {}

  async dashboard(query: ClientsDashboardQuery): Promise<ClientsDashboardDto> {
    // $1/$2 — the period, $3 — the person type or NULL for everyone
    const params = [query.dateFrom, query.dateTo, query.personType ?? null];
    const typeIs = (placeholder: string) => `(${placeholder}::text IS NULL OR c.person_type = ${placeholder}::text)`;
    const ofType = typeIs('$3');
    const inPeriod = `o.order_date >= $1::date AND o.order_date <= $2::date`;
    // lifetime figures of every client of the chosen type
    const lifetimeOf = (placeholder: string) => `SELECT c.client_id, c.client_name::text AS client_name,
        count(o.order_id) AS orders, coalesce(sum(${AMOUNT}), 0) AS amount, max(o.order_date) AS last_order_date
      FROM clients c LEFT JOIN orders o ON o.client_id = c.client_id AND ${REAL_ORDER}
      WHERE ${typeIs(placeholder)} GROUP BY c.client_id, c.client_name`;
    // the lifetime figures do not depend on the period: these statements take the person type alone ($1)
    const lifetime = lifetimeOf('$1');
    const typeOnly = [query.personType ?? null];

    const [totals, days, recency, frequency, types, top, reactivate] = await Promise.all([
      this.database.query<Record<string, string>>(
        `WITH scoped AS (
           SELECT o.client_id, ${AMOUNT} AS amount, ${PAID} AS paid
           FROM orders o JOIN clients c ON c.client_id = o.client_id
           WHERE ${REAL_ORDER} AND ${inPeriod} AND ${ofType}
         ), buyers AS (SELECT DISTINCT client_id FROM scoped)
         SELECT (SELECT count(*) FROM clients c WHERE ${ofType}) AS clients,
                (SELECT count(*) FROM clients c WHERE ${ofType} AND c.created_at::date >= $1::date AND c.created_at::date <= $2::date) AS new_clients,
                (SELECT count(*) FROM buyers) AS buyers,
                (SELECT count(*) FROM buyers b WHERE (SELECT count(*) FROM orders o WHERE o.client_id = b.client_id AND ${REAL_ORDER}) >= 2) AS repeat_buyers,
                (SELECT count(*) FROM scoped) AS orders,
                (SELECT ${money('sum(amount)')} FROM scoped) AS amount,
                (SELECT ${money('sum(paid)')} FROM scoped) AS paid`,
        params,
      ),
      this.database.query<{ day: string; new_clients: string; orders: string; amount: string }>(
        `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                (SELECT count(*) FROM clients c WHERE ${ofType} AND c.created_at::date = d.day::date) AS new_clients,
                count(x.amount) AS orders, ${money('sum(x.amount)')} AS amount
         FROM generate_series($1::date, $2::date, interval '1 day') AS d(day)
         LEFT JOIN (
           SELECT o.order_date, ${AMOUNT} AS amount FROM orders o JOIN clients c ON c.client_id = o.client_id
           WHERE ${REAL_ORDER} AND ${inPeriod} AND ${ofType}
         ) x ON x.order_date = d.day::date
         GROUP BY d.day ORDER BY d.day`,
        params,
      ),
      this.database.query<{ segment: ClientRecencySegment; clients: string; amount: string }>(
        `SELECT CASE WHEN l.last_order_date IS NULL THEN 'no_orders'
                     WHEN CURRENT_DATE - l.last_order_date <= ${ACTIVE_DAYS} THEN 'active'
                     WHEN CURRENT_DATE - l.last_order_date <= ${SLEEPING_DAYS} THEN 'sleeping'
                     ELSE 'lost' END AS segment,
                count(*) AS clients, ${money('sum(l.amount)')} AS amount
         FROM (${lifetime}) l GROUP BY 1`,
        typeOnly,
      ),
      this.database.query<{ bucket: ClientFrequencyBucket; clients: string; amount: string }>(
        `SELECT CASE WHEN l.orders = 1 THEN '1' WHEN l.orders <= 3 THEN '2-3' WHEN l.orders <= 9 THEN '4-9' ELSE '10+' END AS bucket,
                count(*) AS clients, ${money('sum(l.amount)')} AS amount
         FROM (${lifetime}) l WHERE l.orders > 0 GROUP BY 1`,
        typeOnly,
      ),
      this.database.query<{ person_type: ClientPersonType; buyers: string; orders: string; amount: string }>(
        `SELECT c.person_type, count(DISTINCT o.client_id) AS buyers, count(*) AS orders, ${money(`sum(${AMOUNT})`)} AS amount
         FROM orders o JOIN clients c ON c.client_id = o.client_id
         WHERE ${REAL_ORDER} AND ${inPeriod} AND ${ofType}
         GROUP BY c.person_type ORDER BY c.person_type`,
        params,
      ),
      this.database.query<{ client_id: string; client_name: string; orders: string; amount: string; paid: string; last_order_date: string }>(
        `SELECT c.client_id, c.client_name::text AS client_name, count(*) AS orders,
                ${money(`sum(${AMOUNT})`)} AS amount, ${money(`sum(${PAID})`)} AS paid,
                to_char(max(o.order_date), 'YYYY-MM-DD') AS last_order_date
         FROM orders o JOIN clients c ON c.client_id = o.client_id
         WHERE ${REAL_ORDER} AND ${inPeriod} AND ${ofType}
         GROUP BY c.client_id, c.client_name
         ORDER BY sum(${AMOUNT}) DESC, c.client_id LIMIT 10`,
        params,
      ),
      this.database.query<{ client_id: string; client_name: string; phone: string | null; orders: string; amount: string; last_order_date: string; days_since: string }>(
        `SELECT l.client_id, l.client_name, l.orders, ${money('l.amount')} AS amount,
                to_char(l.last_order_date, 'YYYY-MM-DD') AS last_order_date, (CURRENT_DATE - l.last_order_date) AS days_since,
                (SELECT (array_agg(cp.phone_number::text ORDER BY COALESCE(cp.is_primary, false) DESC, cp.phone_id))[1]
                   FROM client_phones cp WHERE cp.client_id = l.client_id) AS phone
         FROM (${lifetime}) l
         WHERE l.last_order_date IS NOT NULL
           AND CURRENT_DATE - l.last_order_date > ${ACTIVE_DAYS} AND CURRENT_DATE - l.last_order_date <= ${SLEEPING_DAYS}
         ORDER BY l.amount DESC, l.client_id LIMIT 10`,
        typeOnly,
      ),
    ]);

    const total = totals.rows[0] ?? {};
    return {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      personType: query.personType ?? null,
      totals: {
        clients: count(total.clients),
        newClients: count(total.new_clients),
        buyers: count(total.buyers),
        repeatBuyers: count(total.repeat_buyers),
        orders: count(total.orders),
        amount: total.amount ?? '0.00',
        paid: total.paid ?? '0.00',
      },
      byDay: days.rows.map((row) => ({ date: row.day, newClients: count(row.new_clients), orders: count(row.orders), amount: row.amount })),
      byRecency: CLIENT_RECENCY_SEGMENTS.map((segment) => {
        const row = recency.rows.find((candidate) => candidate.segment === segment);
        return { segment, clients: count(row?.clients), amount: row?.amount ?? '0.00' };
      }),
      byFrequency: CLIENT_FREQUENCY_BUCKETS.map((bucket) => {
        const row = frequency.rows.find((candidate) => candidate.bucket === bucket);
        return { bucket, clients: count(row?.clients), amount: row?.amount ?? '0.00' };
      }),
      byPersonType: types.rows.map((row) => ({ personType: row.person_type, buyers: count(row.buyers), orders: count(row.orders), amount: row.amount })),
      topClients: top.rows.map((row) => ({
        clientId: Number(row.client_id), clientName: row.client_name, orders: count(row.orders),
        amount: row.amount, paid: row.paid, lastOrderDate: row.last_order_date,
      })),
      toReactivate: reactivate.rows.map((row) => ({
        clientId: Number(row.client_id), clientName: row.client_name, phone: row.phone, orders: count(row.orders),
        amount: row.amount, lastOrderDate: row.last_order_date, daysSince: count(row.days_since),
      })),
    };
  }

  /** `null` — no such client. */
  async card(clientId: number): Promise<ClientAnalyticsCardDto | null> {
    const id = [clientId];
    const client = await this.database.query<{
      client_id: string; client_name: string; person_type: ClientPersonType; is_active: boolean; notes: string | null; created_at: string | null;
    }>(
      `SELECT c.client_id, c.client_name::text AS client_name, c.person_type, c.is_active, c.notes,
              to_char(c.created_at, 'YYYY-MM-DD') AS created_at
       FROM clients c WHERE c.client_id = $1`,
      id,
    );
    const profile = client.rows[0];
    if (!profile) return null;

    // The client's balance is the same net sum the analytics list shows (clients_analytics_view.debt_sum):
    // an overpaid order offsets an unpaid one, so the card, the list and the «С долгом» set agree.
    // The unpaid rest of ONE order is a different figure and is never negative.
    const balance = `${AMOUNT} - ${PAID}`;
    const orderDebt = `GREATEST(${AMOUNT} - ${PAID}, 0)`;
    const clientOrders = `orders o WHERE o.client_id = $1 AND ${REAL_ORDER}`;
    const clientPayments = `payments p JOIN orders o ON o.order_id = p.order_id
       WHERE o.client_id = $1 AND p.delete_flag = false AND ${REAL_ORDER}`;
    const [phones, totals, payTotals, months, payMonths, types, orders, payments] = await Promise.all([
      this.database.query<{ phone: string; is_primary: boolean | null }>(
        `SELECT cp.phone_number::text AS phone, cp.is_primary FROM client_phones cp
         WHERE cp.client_id = $1 ORDER BY COALESCE(cp.is_primary, false) DESC, cp.phone_id`,
        id,
      ),
      this.database.query<Record<string, string | null>>(
        `SELECT count(*) AS orders,
                count(*) FILTER (WHERE o.order_status_id NOT IN (
                  SELECT order_status_id FROM order_statuses WHERE order_status_code = ANY($2::text[]))) AS in_progress,
                ${money(`sum(${AMOUNT})`)} AS amount, ${money(`sum(${PAID})`)} AS paid, ${money(`sum(${balance})`)} AS debt,
                ${money('sum(COALESCE(o.discount, 0))')} AS discount,
                coalesce(sum(COALESCE(o.total_area, 0)), 0)::numeric(14,2)::text AS area,
                coalesce(sum(COALESCE(o.parts_count, 0)), 0) AS parts,
                to_char(min(o.order_date), 'YYYY-MM-DD') AS first_order_date,
                to_char(max(o.order_date), 'YYYY-MM-DD') AS last_order_date,
                (CURRENT_DATE - max(o.order_date)) AS days_since,
                -- between N dated orders there are N − 1 intervals; two orders of one day are 0 days apart
                CASE WHEN count(o.order_date) > 1
                     THEN round((max(o.order_date) - min(o.order_date))::numeric / (count(o.order_date) - 1)) END AS average_interval
         FROM ${clientOrders}`,
        [clientId, [...HANDED_OVER_STATUS_CODES]],
      ),
      this.database.query<{ payments: string; last_payment_date: string | null }>(
        `SELECT count(*) AS payments, to_char(max(p.payment_date), 'YYYY-MM-DD') AS last_payment_date FROM ${clientPayments}`,
        id,
      ),
      this.database.query<{ month: string; orders: string; amount: string }>(
        `SELECT to_char(m.month, 'YYYY-MM') AS month, count(x.amount) AS orders, ${money('sum(x.amount)')} AS amount
         FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '11 months', date_trunc('month', CURRENT_DATE), interval '1 month') AS m(month)
         LEFT JOIN (SELECT date_trunc('month', o.order_date) AS month, ${AMOUNT} AS amount FROM ${clientOrders}) x ON x.month = m.month
         GROUP BY m.month ORDER BY m.month`,
        id,
      ),
      this.database.query<{ month: string; paid: string }>(
        `SELECT to_char(date_trunc('month', p.payment_date), 'YYYY-MM') AS month, ${money('sum(p.amount)')} AS paid
         FROM ${clientPayments} AND p.payment_date >= date_trunc('month', CURRENT_DATE) - interval '11 months'
         GROUP BY 1`,
        id,
      ),
      this.database.query<{ label: string | null; payments: string; amount: string }>(
        `SELECT pt.type_paid_name::text AS label, count(*) AS payments, ${money('sum(p.amount)')} AS amount
         FROM payments p JOIN orders o ON o.order_id = p.order_id
         LEFT JOIN payment_types pt ON pt.type_paid_id = p.type_paid_id
         WHERE o.client_id = $1 AND p.delete_flag = false AND ${REAL_ORDER}
         GROUP BY pt.type_paid_name ORDER BY sum(p.amount) DESC, pt.type_paid_name`,
        id,
      ),
      this.database.query<{
        order_id: string; order_name: string; order_date: string | null; status_name: string | null; payment_status_name: string | null;
        amount: string; paid: string; debt: string;
      }>(
        `SELECT o.order_id, o.order_name::text AS order_name, to_char(o.order_date, 'YYYY-MM-DD') AS order_date,
                os.order_status_name::text AS status_name, ps.payment_status_name::text AS payment_status_name,
                ${money(AMOUNT)} AS amount, ${money(PAID)} AS paid, ${money(orderDebt)} AS debt
         FROM orders o
         LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
         LEFT JOIN payment_statuses ps ON ps.payment_status_id = o.payment_status_id
         WHERE o.client_id = $1 AND ${REAL_ORDER}
         ORDER BY o.order_date DESC NULLS LAST, o.order_id DESC LIMIT 30`,
        id,
      ),
      this.database.query<{ payment_id: string; payment_date: string; amount: string; label: string | null; order_id: string; order_name: string }>(
        `SELECT p.payment_id, to_char(p.payment_date, 'YYYY-MM-DD') AS payment_date, ${money('p.amount')} AS amount,
                pt.type_paid_name::text AS label, o.order_id, o.order_name::text AS order_name
         FROM payments p JOIN orders o ON o.order_id = p.order_id
         LEFT JOIN payment_types pt ON pt.type_paid_id = p.type_paid_id
         WHERE o.client_id = $1 AND p.delete_flag = false AND ${REAL_ORDER}
         ORDER BY p.payment_date DESC, p.payment_id DESC LIMIT 30`,
        id,
      ),
    ]);

    const total = totals.rows[0] ?? {};
    const paidByMonth = new Map(payMonths.rows.map((row) => [row.month, row.paid]));
    const nullableNumber = (value: string | null | undefined) => (value === null || value === undefined ? null : Number(value));
    return {
      client: {
        clientId: Number(profile.client_id),
        clientName: profile.client_name,
        personType: profile.person_type,
        isActive: profile.is_active === true,
        notes: profile.notes,
        createdAt: profile.created_at,
        phones: phones.rows.map((row) => ({ phone: row.phone, isPrimary: row.is_primary === true })),
      },
      totals: {
        orders: count(total.orders),
        ordersInProgress: count(total.in_progress),
        amount: total.amount ?? '0.00',
        paid: total.paid ?? '0.00',
        debt: total.debt ?? '0.00',
        discount: total.discount ?? '0.00',
        area: total.area ?? '0.00',
        parts: count(total.parts),
        firstOrderDate: total.first_order_date ?? null,
        lastOrderDate: total.last_order_date ?? null,
        daysSinceLastOrder: nullableNumber(total.days_since),
        averageIntervalDays: nullableNumber(total.average_interval),
        payments: count(payTotals.rows[0]?.payments),
        lastPaymentDate: payTotals.rows[0]?.last_payment_date ?? null,
      },
      byMonth: months.rows.map((row) => ({ month: row.month, orders: count(row.orders), amount: row.amount, paid: paidByMonth.get(row.month) ?? '0.00' })),
      paymentTypes: types.rows.map((row) => ({ typePaidName: row.label, count: count(row.payments), amount: row.amount })),
      orders: orders.rows.map((row) => ({
        orderId: Number(row.order_id), orderName: row.order_name, orderDate: row.order_date, statusName: row.status_name,
        paymentStatusName: row.payment_status_name, amount: row.amount, paid: row.paid, debt: row.debt,
      })),
      payments: payments.rows.map((row) => ({
        paymentId: Number(row.payment_id), paymentDate: row.payment_date, amount: row.amount, typePaidName: row.label,
        orderId: Number(row.order_id), orderName: row.order_name,
      })),
    };
  }
}
