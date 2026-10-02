import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildOrderExcelBuffer, type OrderExcelDetailRow } from './shared/excel/orderExcelBuilder';
import type { OrderFormData } from './order-form-data';

const TEMPLATE = 'order-forms/order_template.xlsx';
let template: Promise<Buffer> | null = null;

/** The same template the browser downloads (`public/templates/order_template.xlsx`, copied byte for byte). */
export function loadOrderTemplate(): Promise<Buffer> {
  template ??= (async () => {
    const candidates = [
      resolve(__dirname, '../../../../../assets', TEMPLATE),
      join(process.cwd(), 'assets', TEMPLATE),
      join(process.cwd(), 'backend/assets', TEMPLATE),
    ];
    for (const path of candidates) {
      const bytes = await readFile(path).catch(() => null);
      if (bytes) return bytes;
    }
    throw new Error('order_template.xlsx is missing from backend assets');
  })().catch((error) => { template = null; throw error; });
  return template;
}

/** The order Excel built by the shared builder; `data` is already projected for the form. */
export async function renderOrderExcel(data: OrderFormData, pricingMode: 'full' | 'omit'): Promise<Buffer> {
  const details: OrderExcelDetailRow[] = data.details.map((detail) => ({
    detail_id: detail.detailId,
    length: detail.height,
    width: detail.width,
    quantity: detail.quantity,
    milling_cost_per_sqm: pricingMode === 'omit' ? null : detail.millingCostPerSqm,
    detail_cost: pricingMode === 'omit' ? null : detail.detailCost,
    notes: detail.note,
    doweling: detail.doweling,
    milling_type: detail.millingType ? { milling_type_name: detail.millingType } : null,
    edge_type: detail.edgeType ? { edge_type_name: detail.edgeType } : null,
    film: detail.film ? { film_name: detail.film } : null,
    material: detail.material ? { material_name: detail.material } : null,
  }));
  const buffer = await buildOrderExcelBuffer({
    order: {
      order_id: data.orderId,
      order_name: data.orderName,
      order_date: data.orderDate,
      total_amount: pricingMode === 'omit' ? null : data.totalAmount,
      final_amount: pricingMode === 'omit' ? null : data.finalAmount,
      paid_amount: pricingMode === 'omit' ? null : data.paidAmount,
      client: data.clientName ? { client_name: data.clientName } : null,
      _exportData: { prisadkaName: data.prisadkaName ?? '', prisadkaDesignerName: data.prisadkaDesignerName ?? '' },
    },
    details,
    payments: pricingMode === 'omit' ? [] : data.payments.map((payment, index) => ({
      payment_id: index + 1,
      payment_date: payment.date,
      amount: payment.amount,
      payment_type: payment.type ? { payment_type_name: payment.type } : null,
    })),
    client: data.clientName ? { client_name: data.clientName } : null,
    clientPhone: data.clientPhone,
    pricingMode,
    templateBytes: new Uint8Array(await loadOrderTemplate()),
  });
  return Buffer.from(buffer);
}
