/** Мобильная карточка заказа NewLine (мокап 22): строки разделов, только отображение. */

const money = (value: number): string =>
  `${(Math.round(value * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/[  ]/g, ' ')} ₸`;

const shortDate = (value: unknown): string | null => {
  const parts = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  return parts ? `${parts[3]}.${parts[2]}.${parts[1]}` : null;
};

export interface WorkbenchPaymentRow {
  key: string;
  /** «28.09.2026 · Kaspi» */
  label: string;
  amount: string;
  notes: string | null;
}

/** Платежи заказа по дате (сначала новые): дата · способ, сумма; удалённые не показываются. */
export function workbenchPaymentRows(
  payments: readonly Record<string, unknown>[],
  typeNames: ReadonlyMap<number, string>,
): WorkbenchPaymentRow[] {
  return payments
    .filter((payment) => payment.delete_flag !== true)
    .map((payment, index) => ({ payment, index }))
    .sort((left, right) => {
      const l = String(left.payment.payment_date ?? '');
      const r = String(right.payment.payment_date ?? '');
      return r.localeCompare(l) || right.index - left.index;
    })
    .map(({ payment, index }) => {
      const typeId = Number(payment.type_paid_id);
      const typeName = typeNames.get(typeId) ?? (typeof payment.type_paid_name === 'string' ? payment.type_paid_name : null);
      const notes = typeof payment.notes === 'string' && payment.notes.trim() ? payment.notes.trim() : null;
      return {
        key: String(payment.payment_id ?? payment.temp_id ?? `row-${index}`),
        label: [shortDate(payment.payment_date) ?? 'без даты', typeName].filter(Boolean).join(' · '),
        amount: money(Number(payment.amount) || 0),
        notes,
      };
    });
}

