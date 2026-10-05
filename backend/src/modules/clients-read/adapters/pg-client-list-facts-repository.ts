import type { DatabaseClient } from '../../../database/database.types';
import type { ClientListFactsDto, ClientOrdersScope } from '../application/client-list-facts.types';

/**
 * Only real orders: CRM requests and drafts live in the same table but are not orders — the order
 * card does not open them (see the order read repository), so they are neither counted nor linked.
 */
const ORDER_ROWS = `o.order_kind = 'production_order'`;

interface FactsRow {
  client_id: string | number;
  primary_phone: string | null;
  phones_count: string | number;
  orders_count: string | number | null;
  last_order_id: string | number | null;
  last_order_name: string | null;
  last_order_date: string | null;
}

/** Read model for the «Клиенты» list: phone, number of orders and the last order of each client. Read-only. */
export class PgClientListFactsRepository {
  constructor(private readonly database: DatabaseClient) {}

  async facts(clientIds: readonly number[], scope: ClientOrdersScope): Promise<ClientListFactsDto[]> {
    if (clientIds.length === 0) return [];
    const params: unknown[] = [clientIds];
    // Orders are limited to what the user may see: the same rule as the orders list («own» = creator or manager).
    let visible = 'TRUE';
    if (scope.kind === 'own') {
      params.push(scope.userId);
      visible = `(o.created_by = $2 OR o.manager_id = $2)`;
    }
    const ordersJoin = scope.kind === 'none'
      ? ''
      : `LEFT JOIN LATERAL (
           SELECT count(*) AS orders_count FROM orders o
           WHERE o.client_id = c.client_id AND o.delete_flag = false AND ${ORDER_ROWS} AND ${visible}
         ) cnt ON TRUE
         LEFT JOIN LATERAL (
           SELECT o.order_id, o.order_name::text AS order_name, to_char(o.order_date, 'YYYY-MM-DD') AS order_date
           FROM orders o
           WHERE o.client_id = c.client_id AND o.delete_flag = false AND ${ORDER_ROWS} AND ${visible}
           ORDER BY o.order_date DESC NULLS LAST, o.order_id DESC
           LIMIT 1
         ) last_order ON TRUE`;
    const ordersColumns = scope.kind === 'none'
      ? 'NULL::bigint AS orders_count, NULL::bigint AS last_order_id, NULL::text AS last_order_name, NULL::text AS last_order_date'
      : 'cnt.orders_count, last_order.order_id AS last_order_id, last_order.order_name AS last_order_name, last_order.order_date AS last_order_date';
    const result = await this.database.query<FactsRow>(
      `SELECT c.client_id, ph.primary_phone, coalesce(ph.phones_count, 0) AS phones_count, ${ordersColumns}
       FROM clients c
       LEFT JOIN LATERAL (
         SELECT (array_agg(cp.phone_number::text ORDER BY COALESCE(cp.is_primary, false) DESC, cp.phone_id))[1] AS primary_phone,
                count(*) AS phones_count
         FROM client_phones cp WHERE cp.client_id = c.client_id
       ) ph ON TRUE
       ${ordersJoin}
       WHERE c.client_id = ANY($1::bigint[])
       ORDER BY c.client_id`,
      params,
    );
    return result.rows.map((row) => ({
      clientId: Number(row.client_id),
      primaryPhone: row.primary_phone,
      phonesCount: Number(row.phones_count),
      orders: scope.kind === 'none'
        ? null
        : {
          count: Number(row.orders_count ?? 0),
          last: row.last_order_id === null || row.last_order_id === undefined
            ? null
            : { orderId: Number(row.last_order_id), orderName: row.last_order_name ?? String(row.last_order_id), orderDate: row.last_order_date },
        },
    }));
  }
}
