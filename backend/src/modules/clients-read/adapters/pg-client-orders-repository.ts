import type { DatabaseClient } from '../../../database/database.types';
import { appendOrderReadVisibilitySql } from '../../../permissions/policies/order-read-scope-sql';
import type { ClientOrderReadScope } from '../application/client-list-facts.types';

/** Only real orders (see the facts repository): CRM requests and drafts are not orders. */
const ORDER_ROWS = `o.order_kind = 'production_order'`;

export interface ClientOrderRow {
  order_id: string | number;
  order_name: string;
  full_number: string | null;
  order_date: string | null;
  order_status_name: string | null;
  production_status_name: string | null;
  payment_status_name: string | null;
  final_amount: string | number | null;
  paid_amount: string | number | null;
}

export interface ClientOrdersPage {
  rows: ClientOrderRow[];
  total: number;
  finalAmount: number;
  paidAmount: number;
}

/**
 * Orders of one client for the client card, newest first. The visibility of the user is part of the query
 * itself — rows, the count and the sums all use the same predicate (the shared order read visibility of the
 * orders list and the order card), so a user limited to his own orders («own» = creator or manager) never gets
 * another manager's order or its money, whatever the request says. Read-only.
 */
export class PgClientOrdersRepository {
  constructor(private readonly database: DatabaseClient) {}

  async clientExists(clientId: number): Promise<boolean> {
    return (await this.database.query('SELECT 1 FROM clients WHERE client_id = $1', [clientId])).rows.length > 0;
  }

  async list(clientId: number, scope: Exclude<ClientOrderReadScope, { kind: 'none' }>, page: number, pageSize: number): Promise<ClientOrdersPage> {
    const params: unknown[] = [clientId];
    const visible = appendOrderReadVisibilitySql(params, scope.viewer);
    const where = `o.client_id = $1 AND o.delete_flag = false AND ${ORDER_ROWS} AND ${visible}`;
    const limit = params.push(pageSize);
    const offset = params.push((page - 1) * pageSize);
    // One statement, one snapshot: the count, the sums and the page always describe the same set of orders.
    const result = (await this.database.query<ClientOrderRow & { total: string | number; sum_final: string | number; sum_paid: string | number }>(
      `WITH visible AS (
         SELECT o.order_id, o.order_name, o.project_id, o.order_date, o.order_status_id, o.production_status_id,
                o.payment_status_id, o.final_amount, o.paid_amount
           FROM orders o WHERE ${where}
       ), totals AS (
         SELECT count(*) AS total, COALESCE(sum(final_amount), 0) AS sum_final, COALESCE(sum(paid_amount), 0) AS sum_paid FROM visible
       )
       SELECT totals.total, totals.sum_final, totals.sum_paid, page_rows.*
         FROM totals
         LEFT JOIN LATERAL (
           SELECT v.order_id, v.order_name::text AS order_name,
                  CASE WHEN mp.code IS NULL THEN NULL ELSE mp.code || '-' || v.order_name END AS full_number,
                  to_char(v.order_date, 'YYYY-MM-DD') AS order_date,
                  os.order_status_name, prod_s.production_status_name, pay_s.payment_status_name,
                  v.final_amount, v.paid_amount, v.order_date AS sort_date
             FROM visible v
             LEFT JOIN projects mp ON mp.project_id = v.project_id
             LEFT JOIN order_statuses os ON os.order_status_id = v.order_status_id
             LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = v.production_status_id
             LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = v.payment_status_id
            ORDER BY v.order_date DESC NULLS LAST, v.order_id DESC
            LIMIT $${limit} OFFSET $${offset}
         ) page_rows ON true
        ORDER BY page_rows.sort_date DESC NULLS LAST, page_rows.order_id DESC NULLS LAST`, params)).rows;
    const first = result[0];
    const rows = result.filter((row) => row.order_id !== null);
    return { rows, total: Number(first?.total ?? 0), finalAmount: Number(first?.sum_final ?? 0), paidAmount: Number(first?.sum_paid ?? 0) };
  }
}
