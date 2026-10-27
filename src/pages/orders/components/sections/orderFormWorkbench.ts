// «NewLine» order form: pure helpers behind the bottom save bar, the finance summary and the deadline row.
import dayjs from 'dayjs';
import { orderCatalogSubtotal } from '../../../../utils/orderCatalogLines';
import { calculateOrderTotalArea } from '../../../../utils/orderArea';
import { businessOrderDetails } from '../../../../utils/orderDetailRows';

export interface OrderFormTotals {
  positions: number;
  parts: number;
  area: number;
  detailsAmount: number;
  catalogAmount: number;
  /** сумма до скидки и наценки */
  totalAmount: number;
  discount: number;
  surcharge: number;
  finalAmount: number;
  paidAmount: number;
  remainingAmount: number;
}

interface TotalsInput {
  header: { total_amount?: unknown; final_amount?: unknown; paid_amount?: unknown; discount?: unknown; surcharge?: unknown };
  details: readonly any[];
  payments: readonly { amount?: number | null }[];
  catalogLines: readonly any[];
}

const amount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Те же правила, что у сводки в шапке формы: сохранённые суммы заказа важнее пересчёта по строкам. */
export function orderFormTotals({ header, details, payments, catalogLines }: TotalsInput): OrderFormTotals {
  const business = businessOrderDetails(details as any);
  const detailsAmount = business.reduce((sum: number, detail: any) => sum + (detail.detail_cost || 0), 0);
  const catalogAmount = orderCatalogSubtotal(catalogLines as any);
  const totalAmount = amount(header.total_amount) || detailsAmount + catalogAmount;
  const finalAmount = amount(header.final_amount) || totalAmount;
  const paidAmount = amount(header.paid_amount) || payments.reduce((sum, payment) => sum + (payment.amount || 0), 0);
  return {
    positions: business.length,
    parts: business.reduce((sum: number, detail: any) => sum + (detail.quantity || 0), 0),
    area: calculateOrderTotalArea(business as any),
    detailsAmount,
    catalogAmount,
    totalAmount,
    discount: amount(header.discount),
    surcharge: amount(header.surcharge),
    finalAmount,
    paidAmount,
    remainingAmount: Math.max(0, finalAmount - paidAmount),
  };
}

export interface QuickDeadlineOption {
  days: number;
  date: string;
  usual: boolean;
}

const QUICK_DEADLINE_DAYS = [7, 10, 14];

/** Быстрые сроки от даты заказа: +7, +10, +14 дней и обычный срок по настройкам, если он известен. */
export function quickDeadlineOptions(orderDate: string | null | undefined, usualDate?: string | null): QuickDeadlineOption[] {
  const base = orderDate ? dayjs(orderDate) : null;
  if (!base || !base.isValid()) return [];
  const days = new Set(QUICK_DEADLINE_DAYS);
  const usual = usualDate ? dayjs(usualDate) : null;
  const usualDays = usual && usual.isValid() ? usual.startOf('day').diff(base.startOf('day'), 'day') : null;
  if (usualDays !== null && usualDays > 0) days.add(usualDays);
  return [...days].sort((left, right) => left - right).map((value) => ({
    days: value,
    date: base.add(value, 'day').format('YYYY-MM-DD'),
    usual: value === usualDays,
  }));
}

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** «вт · через 12 дн.» рядом со сроком. */
export function deadlineRelativeText(date: string | null | undefined, today: string): string {
  const target = date ? dayjs(date) : null;
  if (!target || !target.isValid()) return '';
  const diff = target.startOf('day').diff(dayjs(today).startOf('day'), 'day');
  const when = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : diff > 0 ? `через ${diff} дн.` : `просрочено ${-diff} дн.`;
  return `${WEEKDAYS[target.day()]} · ${when}`;
}

/** Загрузка дня по плану: сколько заказов и какая площадь уже стоят на эту дату. */
export function dayLoadText(date: string, orders: number, area: number, partial: boolean): string {
  const day = dayjs(date).format('DD.MM');
  if (orders === 0) return `На ${day} в плане пока нет заказов`;
  const areaText = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(area);
  const forms: [string, string, string] = ['заказ', 'заказа', 'заказов'];
  const mod10 = orders % 10;
  const mod100 = orders % 100;
  const word = mod10 === 1 && mod100 !== 11 ? forms[0] : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? forms[1] : forms[2];
  return `На ${day} в плане: ${orders} ${word} · ${partial ? 'не меньше ' : ''}${areaText} м²`;
}

/** Видит ли пользователь заказы всех менеджеров — иначе «загрузка дня» была бы только по его заказам. */
export function canSeeDayLoad(
  user: { policyScopes?: { orders?: { view?: string } } | null } | null | undefined,
  flags: { useBackendAuth: boolean; useBackendOrdersRead: boolean },
): boolean {
  return flags.useBackendAuth && flags.useBackendOrdersRead && user?.policyScopes?.orders?.view === 'all';
}
