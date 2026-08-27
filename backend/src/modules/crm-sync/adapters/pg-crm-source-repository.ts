import type { DatabaseService } from '../../../database/database.service';
import type {
  ClientPhoneRow,
  ClientRow,
  CrmSourcePort,
  OrderRow,
  PaymentRow,
} from '../application/crm-sync.types';

/**
 * Serialize an ERP DATE value to a date-only 'YYYY-MM-DD' string.
 *
 * node-postgres parses a DATE column (OID 1082) into a JS `Date` built at LOCAL
 * midnight, so a naive `String(v)` yields a `Date.prototype.toString()` value
 * ("Fri Jun 19 2026 00:00:00 GMT+0000 (Coordinated Universal Time)") that the
 * CRM mapper expects date-only input; leaking Date.toString() produces invalid
 * Bitrix24 date fields.
 *
 * Because pg constructs the Date from local Y/M/D components, reading the local
 * getters round-trips the stored DATE exactly, independent of the process
 * timezone (using `toISOString()` would shift the day in non-UTC zones).
 * A string input (e.g. a custom type parser) is normalized to its date prefix.
 */
export function toErpDateString(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const year = v.getFullYear();
    const month = String(v.getMonth() + 1).padStart(2, '0');
    const day = String(v.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const s = String(v);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return match ? match[1] : s;
}

/**
 * Pool-only ERP source read adapter for CRM sync.
 * All four methods use db.query (the pool) — never a transaction client.
 * This is intentional: reads run OUTSIDE any persistence tx (brief §3).
 */
export class PgCrmSourceRepository implements CrmSourcePort {
  constructor(private readonly db: DatabaseService) {}

  async getClientById(id: string): Promise<ClientRow | null> {
    const { rows } = await this.db.query(
      `SELECT client_id, client_name, person_type, notes, is_active
         FROM clients
        WHERE client_id = $1`,
      [id],
    );
    if (!rows.length) return null;
    const r = rows[0];
    const phonesResult = await this.db.query(
      `SELECT phone_number, phone_type, is_primary
         FROM client_phones
        WHERE client_id = $1
        ORDER BY is_primary DESC, phone_id ASC`,
      [id],
    );
    return {
      clientId: String(r.client_id),
      clientName: r.client_name,
      personType: r.person_type === 'legal' ? 'legal' : 'individual',
      notes: r.notes ?? null,
      isActive: Boolean(r.is_active),
      phones: phonesResult.rows.map((phone): ClientPhoneRow => ({
        phoneNumber: String(phone.phone_number),
        phoneType: normalizePhoneType(phone.phone_type),
        isPrimary: Boolean(phone.is_primary),
      })),
    };
  }

  async getOrderById(id: string): Promise<OrderRow | null> {
    const { rows } = await this.db.query(
      `SELECT o.order_id, o.order_name, o.client_id, o.total_amount, o.final_amount, o.paid_amount,
              o.order_date, o.completion_date, o.delete_flag, o.order_kind, o.source_system,
              os.order_status_name, ps.payment_status_name
         FROM orders o
         LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
         LEFT JOIN payment_statuses ps ON ps.payment_status_id = o.payment_status_id
        WHERE o.order_id = $1`,
      [id],
    );
    if (!rows.length) return null;
    const r = rows[0];
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    const dat = toErpDateString;
    return {
      orderId: String(r.order_id),
      orderNumber: String(r.order_id),
      orderName: r.order_name,
      clientId: String(r.client_id),
      totalAmount: num(r.total_amount),
      finalAmount: num(r.final_amount),
      paidAmount: num(r.paid_amount),
      orderStatusName: r.order_status_name ?? null,
      paymentStatusName: r.payment_status_name ?? null,
      orderDate: dat(r.order_date),
      completionDate: dat(r.completion_date),
      deleteFlag: Boolean(r.delete_flag),
      orderKind: r.order_kind,
      sourceSystem: r.source_system,
    };
  }

  async getPaymentsByOrderId(orderId: string): Promise<PaymentRow[]> {
    const { rows } = await this.db.query(
      `SELECT p.payment_id, p.order_id, p.type_paid_id, pt.type_paid_name,
              p.amount, p.payment_date, p.notes
         FROM payments p
         LEFT JOIN payment_types pt ON pt.type_paid_id = p.type_paid_id
        WHERE p.order_id = $1 AND p.delete_flag = false
        ORDER BY p.payment_id ASC`,
      [orderId],
    );
    return rows.map((row) => ({
      paymentId: String(row.payment_id),
      orderId: String(row.order_id),
      typePaidId: String(row.type_paid_id),
      typePaidName: row.type_paid_name ?? null,
      amount: Number(row.amount),
      paymentDate: toErpDateString(row.payment_date) ?? '',
      notes: row.notes ?? null,
    }));
  }

  async hasOrdersForClient(clientId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT EXISTS (
         SELECT 1 FROM orders WHERE client_id = $1
       ) AS has_orders`,
      [clientId],
    );
    return Boolean(rows[0]?.has_orders);
  }

  async listClientIds(afterId: string, limit: number): Promise<string[]> {
    const { rows } = await this.db.query(
      `SELECT client_id FROM clients WHERE client_id > $1 ORDER BY client_id ASC LIMIT $2`,
      [afterId, limit],
    );
    return rows.map((r) => String(r.client_id));
  }

  async listOrderIds(afterId: string, limit: number): Promise<string[]> {
    const { rows } = await this.db.query(
      `SELECT order_id FROM orders
        WHERE order_id > $1 AND order_kind = 'production_order'
        ORDER BY order_id ASC LIMIT $2`,
      [afterId, limit],
    );
    return rows.map((r) => String(r.order_id));
  }
}

function normalizePhoneType(value: unknown): ClientPhoneRow['phoneType'] {
  return value === 'work' || value === 'home' || value === 'fax' ? value : 'mobile';
}
