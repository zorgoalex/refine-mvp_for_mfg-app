/**
 * Уведомления закупа по расписанию (план 2026-09-28 §5.7 п.2, п.4): чистая логика — когда пора сводке, тексты БЕЗ
 * идентификаторов заказов, клиентов и материалов (R4-1: только агрегаты; номер и поставщик документа 1С допустимы).
 */

/** Правила-включатели (миграция 228, засеяны выключенными). */
export const PROCUREMENT_NOTIFICATION_RULES = {
  demandChanged: 'procurement-demand-changed',
  digest: 'procurement-deficit-digest',
  unallocated: 'procurement-receipt-unallocated',
} as const;

/** Местное время Asia/Almaty, HH:MM. */
export function almatyTime(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

/** Сводке пора: местное время не раньше времени сводки из настроек (ключ на дату не даёт повторить). */
export function isDigestDue(now: Date, digestTime: string): boolean {
  return almatyTime(now) >= digestTime;
}

const quantity = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** Текст сводки дефицита по рабочему списку получателя; null — сводка пустая и не создаётся. */
export function digestText(
  totals: { uncovered: number; urgent: number; deficitM2: number; deficitLm: number },
  date: string,
): { title: string; message: string } | null {
  if (totals.uncovered <= 0) return null;
  const deficit = [
    totals.deficitM2 > 0 ? `${quantity.format(totals.deficitM2)} м²` : null,
    totals.deficitLm > 0 ? `${quantity.format(totals.deficitLm)} пог. м` : null,
  ].filter(Boolean).join(', ');
  const [year, month, day] = date.split('-');
  return {
    title: `Сводка закупа на ${day}.${month}.${year}`,
    message: `Не покрыто позиций: ${totals.uncovered}, из них срочно: ${totals.urgent}.${deficit ? ` Дефицит: ${deficit}.` : ''} Подробности — в рабочем списке экрана снабжения.`,
  };
}

/** «Старые» нераспределённые приходы в ежедневной сводке — старше стольких дней (план 2026-10-02 §2.2). */
export const UNALLOCATED_OLD_DAYS = 7;
/** Сколько самых старых приходов перечислить в сводке. */
export const UNALLOCATED_OLDEST_SHOWN = 3;

export interface UnallocatedDigestTotals {
  documents: number;
  lines: number;
  /** Из них с датой раньше «сегодня − UNALLOCATED_OLD_DAYS» (строго старше 7 дней, code review R1-2). */
  old: number;
  /** Самые старые (по дате, затем id), не больше UNALLOCATED_OLDEST_SHOWN. */
  oldest: Array<{ number: string; docDate: string; supplierName: string | null }>;
}

const shortDate = (iso: string) => { const [year, month, day] = iso.split('-'); return `${day}.${month}.${year}`; };

/** Итоги нераспределённых приходов по порциям (порядок — дата, id, как отдаёт хранилище). */
export function addUnallocatedPage(
  totals: UnallocatedDigestTotals,
  page: Array<{ number: string; docDate: string; supplierName: string | null; lines: number }>,
  oldBefore: string,
): UnallocatedDigestTotals {
  const next = { ...totals, oldest: [...totals.oldest] };
  for (const row of page) {
    next.documents += 1;
    next.lines += row.lines;
    if (row.docDate < oldBefore) next.old += 1;
    if (next.oldest.length < UNALLOCATED_OLDEST_SHOWN) next.oldest.push({ number: row.number, docDate: row.docDate, supplierName: row.supplierName });
  }
  return next;
}

/** Ежедневная сводка нераспределённых приходов (без заказов); null — нераспределённых нет, сводка не создаётся. */
export function unallocatedDigestText(totals: UnallocatedDigestTotals, date: string): { title: string; message: string } | null {
  if (totals.documents <= 0) return null;
  const oldest = totals.oldest
    .map((row) => `№ ${row.number} от ${shortDate(row.docDate)}${row.supplierName ? ` (${row.supplierName})` : ''}`)
    .join(', ');
  const old = totals.old > 0 ? `, из них старше ${UNALLOCATED_OLD_DAYS} дней — ${totals.old}` : '';
  return {
    title: `Нераспределённые поступления на ${shortDate(date)}`,
    message: `Не распределены поступления 1С: ${totals.documents} (строк — ${totals.lines})${old}. `
      + `${totals.documents > totals.oldest.length ? 'Самые старые' : 'Поступления'}: ${oldest}. Подробности — экран снабжения, «Приходы».`,
  };
}
