import { DEFAULT_STATUS_COLOR, normalizeStatusColor } from '../../../components/statusColorUtils';

export type OrderCardStatusKind = 'order' | 'payment' | 'production';

export interface OrderCardStatusColorMaps {
  order: ReadonlyMap<number, string>;
  payment: ReadonlyMap<number, string>;
  production: ReadonlyMap<number, string>;
}

export interface OrderCardModel {
  id: number;
  title: string;
  client: string;
  dates: string;
  statusTag: string;
  statusTagColor: string;
  paymentTag: string;
  paymentTagColor: string;
  productionTag: string;
  productionTagColor: string;
  amountLine: string;
  priority: boolean;
}

export interface BuildOrderCardModelOptions {
  showFinancials?: boolean;
  statusColors?: Partial<OrderCardStatusColorMaps>;
}

const LEGACY_STATUS_COLORS: Readonly<Record<string, string>> = {
  magenta: '#EB2F96',
  red: '#F5222D',
  volcano: '#FA541C',
  orange: '#FA8C16',
  gold: '#FAAD14',
  lime: '#A0D911',
  green: '#52C41A',
  cyan: '#13C2C2',
  blue: '#1677FF',
  geekblue: '#2F54EB',
  purple: '#722ED1',
};

export const resolveOrderCardStatusColor = (value: unknown): string => {
  const normalizedHex = normalizeStatusColor(value);
  if (normalizedHex) return normalizedHex;
  if (typeof value !== 'string') return DEFAULT_STATUS_COLOR;
  return LEGACY_STATUS_COLORS[value.trim().toLowerCase()] ?? DEFAULT_STATUS_COLOR;
};

export const buildOrderCardStatusColorMap = (
  rows: readonly Record<string, unknown>[],
  idField: string,
): ReadonlyMap<number, string> => {
  const colors = new Map<number, string>();
  rows.forEach((row) => {
    const id = Number(row[idField]);
    if (!Number.isFinite(id) || id <= 0) return;
    colors.set(id, resolveOrderCardStatusColor(row.color));
  });
  return colors;
};

const relativeLuminance = (color: string): number => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};

export const getOrderCardStatusTextColor = (backgroundColor: string): '#000000' | '#FFFFFF' => {
  const normalizedBackground = resolveOrderCardStatusColor(backgroundColor);
  const luminance = relativeLuminance(normalizedBackground);
  const darkTextContrast = (luminance + 0.05) / 0.05;
  const lightTextContrast = 1.05 / (luminance + 0.05);
  return darkTextContrast >= lightTextContrast ? '#000000' : '#FFFFFF';
};

const colorForStatus = (
  colors: ReadonlyMap<number, string> | undefined,
  id: unknown,
): string => resolveOrderCardStatusColor(colors?.get(Number(id)));

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
  { showFinancials = true, statusColors }: BuildOrderCardModelOptions = {},
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
    statusTagColor: colorForStatus(statusColors?.order, row.order_status_id),
    paymentTag: showFinancials && typeof row.payment_status_name === 'string' ? row.payment_status_name : '',
    paymentTagColor: colorForStatus(statusColors?.payment, row.payment_status_id),
    productionTag: typeof row.production_status_name === 'string' ? row.production_status_name : '',
    productionTagColor: colorForStatus(statusColors?.production, row.production_status_id),
    amountLine: showFinancials
      ? `${formatMoney(row.final_amount)} · оплачено ${formatMoney(row.paid_amount)}`
      : '',
    // Бизнес-семантика ERP: срочный = priority задан и <= 50 (OrderShowHeader.tsx:272-277).
    priority: Number(row.priority) > 0 && Number(row.priority) <= 50,
  };
}
