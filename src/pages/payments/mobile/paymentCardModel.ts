import { formatMoney } from '../../orders/mobile/orderCardModel';

export interface PaymentCardLookups {
  orderLabelOf: (orderId: unknown) => string;
  orderDeletedOf?: (orderId: unknown) => boolean;
  typeLabelOf: (typeId: unknown) => string;
}

export interface PaymentCardModel {
  id: number;
  orderLabel: string;
  orderDeleted: boolean;
  typeLabel: string;
  amount: string;
  date: string;
  notes: string;
}

const fmtDate = (v: unknown): string => {
  if (typeof v !== 'string' || !v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return y && m && d ? `${d}.${m}.${y}` : '—';
};

export function buildPaymentCardModel(row: Record<string, unknown>, lookups: PaymentCardLookups): PaymentCardModel {
  return {
    id: Number(row.payment_id) || 0,
    orderLabel: lookups.orderLabelOf(row.order_id) || '—',
    orderDeleted: lookups.orderDeletedOf?.(row.order_id) === true,
    typeLabel: lookups.typeLabelOf(row.type_paid_id) || '—',
    amount: formatMoney(row.amount),
    date: fmtDate(row.payment_date),
    notes: typeof row.notes === 'string' ? row.notes : '',
  };
}
