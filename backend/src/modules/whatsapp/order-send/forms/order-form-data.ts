import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../../database/database.types';

/** Everything any order form needs, read in one transaction. Financial fields are projected out later. */
export interface OrderFormData {
  orderId: number;
  orderName: string;
  orderDate: Date;
  completionDate: Date | null;
  clientId: number | null;
  clientName: string | null;
  /** The selected client phone, as stored (same rule as the Google Drive exporter). */
  clientPhone: string | null;
  managerId: string | null;
  createdBy: string | null;
  totalAmount: number | null;
  discount: number | null;
  finalAmount: number | null;
  paidAmount: number | null;
  prisadkaName: string | null;
  prisadkaDesignerName: string | null;
  headerMaterial: string | null;
  details: OrderFormDetail[];
  payments: OrderFormPayment[];
}

export interface OrderFormDetail {
  detailId: number;
  height: number | null;
  width: number | null;
  quantity: number;
  millingType: string | null;
  edgeType: string | null;
  film: string | null;
  material: string | null;
  note: string | null;
  doweling: boolean;
  millingCostPerSqm: number | null;
  detailCost: number | null;
}

export interface OrderFormPayment { type: string | null; date: Date | null; amount: number | null }

interface HeaderRow extends QueryResultRow {
  order_id: string; order_name: string; order_date: Date; completion_date: Date | null; client_id: string | null; client_name: string | null;
  client_phone: string | null; manager_id: string | null; created_by: string | null; total_amount: string | null; discount: string | null;
  final_amount: string | null; paid_amount: string | null; material_name: string | null;
}

/** Selected client phone: primary, otherwise the smallest — exactly as the order exporter. */
export const CLIENT_PHONE_SQL = `SELECT COALESCE(MAX(cp.phone_number) FILTER (WHERE cp.is_primary = true), MIN(cp.phone_number)) AS client_phone
  FROM client_phones cp WHERE cp.client_id = $1`;

/** Reads the order under FOR SHARE (caller holds a transaction); null when it is not a live production order. */
export async function readOrderFormData(tx: DatabaseClient, orderId: number): Promise<OrderFormData | null> {
  const header = (await tx.query<HeaderRow>(`
    SELECT o.order_id, o.order_name, o.order_date, COALESCE(o.planned_completion_date, o.completion_date) AS completion_date,
      o.client_id, c.client_name, phone.client_phone, o.manager_id, o.created_by,
      o.total_amount, o.discount, o.final_amount, o.paid_amount, hsmt.name AS material_name
    FROM orders o
    LEFT JOIN clients c ON c.client_id = o.client_id
    LEFT JOIN sheet_material_types hsmt ON hsmt.sheet_material_type_id = o.sheet_material_type_id
    LEFT JOIN LATERAL (${CLIENT_PHONE_SQL.replace('$1', 'o.client_id')}) phone ON true
    WHERE o.order_id = $1 AND o.delete_flag = false AND o.deleted_at IS NULL AND o.order_kind = 'production_order'
    FOR SHARE OF o`, [orderId])).rows[0];
  if (!header) return null;
  const details = (await tx.query<QueryResultRow & {
    detail_id: string; height: string | null; width: string | null; quantity: string | null; note: string | null; doweling: boolean | null;
    milling_cost_per_sqm: string | null; detail_cost: string | null; milling_type_name: string | null; edge_type_name: string | null;
    film_name: string | null; material_name: string | null;
  }>(`
    SELECT od.detail_id, od.height, od.width, od.quantity, od.note, od.doweling, od.milling_cost_per_sqm, od.detail_cost,
      mt.milling_type_name, et.edge_type_name, f.film_name, smt.name AS material_name
    FROM order_details od
    LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
    LEFT JOIN edge_types et ON et.edge_type_id = od.edge_type_id
    LEFT JOIN films f ON f.film_id = od.film_id
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
    WHERE od.order_id = $1 AND od.delete_flag = false
    ORDER BY od.detail_number ASC NULLS LAST, od.detail_id ASC`, [orderId])).rows;
  const payments = (await tx.query<QueryResultRow & { type_paid_name: string | null; payment_date: Date | null; amount: string | null }>(`
    SELECT pt.type_paid_name, p.payment_date, p.amount
    FROM payments p LEFT JOIN payment_types pt ON pt.type_paid_id = p.type_paid_id
    WHERE p.order_id = $1 AND p.delete_flag = false
    ORDER BY p.payment_date ASC, p.payment_id ASC`, [orderId])).rows;
  const doweling = (await tx.query<QueryResultRow & { doweling_order_name: string | null; design_engineer_name: string | null }>(`
    SELECT d.doweling_order_name, e.full_name AS design_engineer_name
    FROM doweling_orders d
    LEFT JOIN order_doweling_links odl ON odl.doweling_order_id = d.doweling_order_id
    LEFT JOIN employees e ON e.employee_id = d.design_engineer_id
    WHERE (d.order_id = $1 OR odl.order_id = $1) AND d.delete_flag = false
    ORDER BY d.doweling_order_id DESC LIMIT 1`, [orderId])).rows[0];
  return {
    orderId: Number(header.order_id),
    orderName: header.order_name,
    orderDate: new Date(header.order_date),
    completionDate: header.completion_date ? new Date(header.completion_date) : null,
    clientId: header.client_id === null ? null : Number(header.client_id),
    clientName: header.client_name,
    clientPhone: header.client_phone,
    managerId: header.manager_id === null ? null : String(header.manager_id),
    createdBy: header.created_by === null ? null : String(header.created_by),
    totalAmount: num(header.total_amount),
    discount: num(header.discount),
    finalAmount: num(header.final_amount),
    paidAmount: num(header.paid_amount),
    prisadkaName: doweling?.doweling_order_name ?? null,
    prisadkaDesignerName: doweling?.design_engineer_name ?? null,
    headerMaterial: header.material_name,
    details: details.map((row) => ({
      detailId: Number(row.detail_id),
      height: num(row.height),
      width: num(row.width),
      quantity: num(row.quantity) ?? 1,
      millingType: row.milling_type_name,
      edgeType: row.edge_type_name,
      film: row.film_name,
      material: row.material_name,
      note: row.note,
      doweling: row.doweling === true,
      millingCostPerSqm: num(row.milling_cost_per_sqm),
      detailCost: num(row.detail_cost),
    })),
    payments: payments.map((row) => ({ type: row.type_paid_name, date: row.payment_date ? new Date(row.payment_date) : null, amount: num(row.amount) })),
  };
}

/** The production projection: no prices, sums, discount, payments or balance — whoever asks. */
export function productionProjection(data: OrderFormData): OrderFormData {
  return {
    ...data,
    totalAmount: null, discount: null, finalAmount: null, paidAmount: null, payments: [],
    details: data.details.map((detail) => ({ ...detail, millingCostPerSqm: null, detailCost: null })),
  };
}

function num(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
