import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  appendOrderReadVisibilitySql,
  buildOrderReadScopePredicate,
  normalizeActorUserId,
  orderAssignmentExistsSql,
  scopeNeedsActor,
} from '../../../permissions/policies/order-read-scope-sql';
import { policyScopeSetsForUser } from '../../../permissions/policies/scope';

/** Only real orders, as in the «Заказы» tab: CRM requests and drafts are not orders. */
const ORDER_ROWS = `o.order_kind = 'production_order'`;

export interface ClientPaymentRow {
  payment_id: string | number;
  payment_date: string;
  amount: string | number;
  type_paid_name: string | null;
  notes: string | null;
  from_onec: boolean;
  order_id: string | number;
  order_name: string;
  full_number: string | null;
}

export interface ClientPaymentsPage {
  rows: ClientPaymentRow[];
  total: number;
  amount: number;
}

/**
 * The SQL of «the payments of this order may be seen»: the shared order read visibility AND the payment visibility
 * of the user (`payments.view`: all / own / assigned — the SQL twin of PaymentAccessPolicy.canView on the order).
 */
export function appendClientPaymentVisibilitySql(params: unknown[], viewer: CurrentUser, orderAlias = 'o'): string {
  const order = appendOrderReadVisibilitySql(params, viewer, orderAlias);
  const set = policyScopeSetsForUser(viewer).payments.view;
  const actorIndex = scopeNeedsActor(set) ? params.push(normalizeActorUserId(viewer.id)) : null;
  const assigned = actorIndex === null ? 'FALSE' : orderAssignmentExistsSql(orderAlias, actorIndex);
  const payment = buildOrderReadScopePredicate(set, actorIndex, assigned, orderAlias);
  return `(${order}) AND (${payment})`;
}

/**
 * Payments of one client for the client card (payments of its orders), newest first. The visibility of the user is
 * part of the query: rows, the count and the sum use one predicate, so a user limited to his own orders never gets
 * a payment of another manager's order, whatever the request says. Read-only.
 */
export class PgClientPaymentsRepository {
  constructor(private readonly database: DatabaseClient) {}

  async clientExists(clientId: number): Promise<boolean> {
    return (await this.database.query('SELECT 1 FROM clients WHERE client_id = $1', [clientId])).rows.length > 0;
  }

  async list(clientId: number, viewer: CurrentUser, page: number, pageSize: number): Promise<ClientPaymentsPage> {
    const params: unknown[] = [clientId];
    const visible = appendClientPaymentVisibilitySql(params, viewer);
    const where = `o.client_id = $1 AND o.delete_flag = false AND ${ORDER_ROWS} AND p.delete_flag = false AND ${visible}`;
    const limit = params.push(pageSize);
    const offset = params.push((page - 1) * pageSize);
    // One statement, one snapshot: the count, the sum and the page always describe the same set of payments.
    const result = (await this.database.query<ClientPaymentRow & { total: string | number; sum_amount: string | number }>(
      `WITH visible AS (
         SELECT p.payment_id, p.payment_date, p.amount, p.type_paid_id, p.notes, p.ref_key_1c, o.order_id, o.order_name, o.project_id
           FROM payments p JOIN orders o ON o.order_id = p.order_id
          WHERE ${where}
       ), totals AS (
         SELECT count(*) AS total, COALESCE(sum(amount), 0) AS sum_amount FROM visible
       )
       SELECT totals.total, totals.sum_amount, page_rows.*
         FROM totals
         LEFT JOIN LATERAL (
           SELECT v.payment_id, to_char(v.payment_date, 'YYYY-MM-DD') AS payment_date, v.amount,
                  pt.type_paid_name::text AS type_paid_name, v.notes, v.ref_key_1c IS NOT NULL AS from_onec,
                  v.order_id, v.order_name::text AS order_name,
                  CASE WHEN mp.code IS NULL THEN NULL ELSE mp.code || '-' || v.order_name END AS full_number,
                  v.payment_date AS sort_date
             FROM visible v
             LEFT JOIN projects mp ON mp.project_id = v.project_id
             LEFT JOIN payment_types pt ON pt.type_paid_id = v.type_paid_id
            ORDER BY v.payment_date DESC, v.payment_id DESC
            LIMIT $${limit} OFFSET $${offset}
         ) page_rows ON true
        ORDER BY page_rows.sort_date DESC NULLS LAST, page_rows.payment_id DESC NULLS LAST`, params)).rows;
    const first = result[0];
    const rows = result.filter((row) => row.payment_id !== null);
    return { rows, total: Number(first?.total ?? 0), amount: Number(first?.sum_amount ?? 0) };
  }
}
