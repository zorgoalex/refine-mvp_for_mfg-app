export interface OrderCardModel {
  id: number;
  title: string;
  client: string;
  dates: string;
  statusTag: string;
  paymentTag: string;
  productionTag: string;
  amountLine: string;
  priority: boolean;
}

export interface BuildOrderCardModelOptions {
  showFinancials?: boolean;
}

const fmtDate = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const [y, m, d] = v.slice(0, 10).split('-');
  if (!y || !m || !d) return null;
  return `${d}.${m}.${y}`;
};

export const formatMoney = (v: unknown): string => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  // Normalize ru-RU locale spaces (U+202F NARROW NO-BREAK SPACE, U+00A0) to regular space
  return `${Math.round(n).toLocaleString('ru-RU').replace(/[   ]/g, ' ')} ₸`;
};

export function buildOrderCardModel(
  row: Record<string, unknown>,
  { showFinancials = true }: BuildOrderCardModelOptions = {},
): OrderCardModel {
  const id = Number(row.order_id) || 0;
  const start = fmtDate(row.order_date);
  const end = fmtDate(row.issue_date) ?? fmtDate(row.planned_completion_date);
  return {
    id,
    title: typeof row.order_name === 'string' && row.order_name ? row.order_name : `Заказ ${id}`,
    client: typeof row.client_name === 'string' && row.client_name ? row.client_name : '—',
    dates: start || end ? `${start ?? '…'} → ${end ?? '…'}` : '—',
    statusTag: typeof row.order_status_name === 'string' ? row.order_status_name : '',
    paymentTag: showFinancials && typeof row.payment_status_name === 'string' ? row.payment_status_name : '',
    productionTag: typeof row.production_status_name === 'string' ? row.production_status_name : '',
    amountLine: showFinancials
      ? `${formatMoney(row.final_amount)} · оплачено ${formatMoney(row.paid_amount)}`
      : '',
    // Бизнес-семантика ERP: срочный = priority задан и <= 50 (OrderShowHeader.tsx:272-277).
    priority: Number(row.priority) > 0 && Number(row.priority) <= 50,
  };
}
