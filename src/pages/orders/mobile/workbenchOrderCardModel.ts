/** Строки карточки заказа NewLine на телефоне (мокап 22). Срок и тона — те же, что в списке NewLine. */
import { orderDeadlineHint, type WorkbenchTone } from '../orderListWorkbench';

export interface WorkbenchCardLine {
  text: string;
  tone: WorkbenchTone;
}

const shortDate = (value: unknown): string | null => {
  const parts = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  return parts ? `${parts[3]}.${parts[2]}` : null;
};

/** «до 08.10 · через 7 дн.» · «до 08.10 · просрочено 2 дн.» · «до 08.10 · выдан»; null без срока. */
export function workbenchDeadlineLine(row: Record<string, unknown>, now: Date = new Date()): WorkbenchCardLine | null {
  const date = shortDate(row.planned_completion_date);
  const hint = orderDeadlineHint(row, now);
  if (!date || !hint) return null;
  return { text: `до ${date} · ${hint.text}`, tone: hint.tone };
}

const money = (value: number): string =>
  `${Math.round(value).toLocaleString('ru-RU').replace(/[  ]/g, ' ')} ₸`;

/** «оплачен» · «не оплачен» · «остаток 12 000 ₸» по суммам заказа; null без доступа к финансам. */
export function workbenchPaymentLine(row: Record<string, unknown>, showFinancials: boolean): WorkbenchCardLine | null {
  if (!showFinancials) return null;
  const total = Number(row.final_amount);
  const paid = Number(row.paid_amount) || 0;
  if (!Number.isFinite(total) || total <= 0) return null;
  if (paid >= total) return { text: 'оплачен', tone: 'ready' };
  if (paid <= 0) return { text: 'не оплачен', tone: 'danger' };
  return { text: `остаток ${money(total - paid)}`, tone: 'warning' };
}

export function workbenchTotalLine(row: Record<string, unknown>, showFinancials: boolean): string | null {
  if (!showFinancials) return null;
  const total = Number(row.final_amount);
  return Number.isFinite(total) ? money(total) : null;
}
