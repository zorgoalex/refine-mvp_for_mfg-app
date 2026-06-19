import type { DatabaseService } from '../../../database/database.service';
import type { ClientRow, CrmSourcePort, OrderRow } from '../application/crm-sync.types';

/**
 * Pool-only ERP source read adapter for CRM sync.
 * All four methods use db.query (the pool) — never a transaction client.
 * This is intentional: reads run OUTSIDE any persistence tx (brief §3).
 */
export class PgCrmSourceRepository implements CrmSourcePort {
  constructor(private readonly db: DatabaseService) {}

  async getClientById(id: string): Promise<ClientRow | null> {
    const { rows } = await this.db.query(
      `SELECT client_id, client_name, notes, is_active FROM clients WHERE client_id = $1`,
      [id],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      clientId: String(r.client_id),
      clientName: r.client_name,
      notes: r.notes ?? null,
      isActive: Boolean(r.is_active),
    };
  }

  async getOrderById(id: string): Promise<OrderRow | null> {
    const { rows } = await this.db.query(
      `SELECT o.order_id, o.order_name, o.client_id, o.total_amount, o.final_amount, o.paid_amount,
              o.order_date, o.completion_date, o.delete_flag, os.order_status_name, ps.payment_status_name
         FROM orders o
         LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
         LEFT JOIN payment_statuses ps ON ps.payment_status_id = o.payment_status_id
        WHERE o.order_id = $1`,
      [id],
    );
    if (!rows.length) return null;
    const r = rows[0];
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    const dat = (v: unknown): string | null => (v == null ? null : String(v));
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
    };
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
      `SELECT order_id FROM orders WHERE order_id > $1 ORDER BY order_id ASC LIMIT $2`,
      [afterId, limit],
    );
    return rows.map((r) => String(r.order_id));
  }
}
