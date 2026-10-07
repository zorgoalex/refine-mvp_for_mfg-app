import type { DatabaseClient } from '../../../database/database.types';
import type { ClientOrdersScope } from '../application/client-list-facts.types';

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
 * itself — rows, the count and the sums all use the same predicate, so a user limited to his own orders
 * («own» = creator or manager, as in the facts of the clients list) never gets another manager's order or its
 * money, whatever the request says. Read-only.
 */
export class PgClientOrdersRepository {
  constructor(private readonly database: DatabaseClient) {}

  async clientExists(clientId: number): Promise<boolean> {
    return (await this.database.query('SELECT 1 FROM clients WHERE client_id = $1', [clientId])).rows.length > 0;
  }

  async list(clientId: number, scope: Exclude<ClientOrdersScope, { kind: 'none' }>, page: number, pageSize: number): Promise<ClientOrdersPage> {
    const params: unknown[] = [clientId];
    const visible = scope.kind === 'own' ? `(o.created_by = $${params.push(scope.userId)} OR o.manager_id = $${params.length})` : 'TRUE';
    const where = `o.client_id = $1 AND o.delete_flag = false AND ${ORDER_ROWS} AND ${visible}`;
    const totals = (await this.database.query<{ total: string | number; final_amount: string | number; paid_amount: string | number }>(
      `SELECT count(*) AS total, COALESCE(sum(o.final_amount), 0) AS final_amount, COALESCE(sum(o.paid_amount), 0) AS paid_amount
         FROM orders o WHERE ${where}`, params)).rows[0];
    const rows = (await this.database.query<ClientOrderRow>(
      `SELECT o.order_id, o.order_name::text AS order_name,
              CASE WHEN mp.code IS NULL THEN NULL ELSE mp.code || '-' || o.order_name END AS full_number,
              to_char(o.order_date, 'YYYY-MM-DD') AS order_date,
              os.order_status_name, prod_s.production_status_name, pay_s.payment_status_name,
              o.final_amount, o.paid_amount
         FROM orders o
         LEFT JOIN projects mp ON mp.project_id = o.project_id
         LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
         LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = o.production_status_id
         LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id
        WHERE ${where}
        ORDER BY o.order_date DESC NULLS LAST, o.order_id DESC
        LIMIT $${params.push(pageSize)} OFFSET $${params.push((page - 1) * pageSize)}`, params)).rows;
    return { rows, total: Number(totals?.total ?? 0), finalAmount: Number(totals?.final_amount ?? 0), paidAmount: Number(totals?.paid_amount ?? 0) };
  }
}
