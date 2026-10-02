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

/** Текст «приход не распределён»: номер, дата и поставщик документа 1С, число строк — без заказов. */
export function unallocatedText(row: { number: string; docDate: string; supplierName: string | null; lines: number }): { title: string; message: string } {
  const [year, month, day] = row.docDate.split('-');
  const supplier = row.supplierName ? ` (${row.supplierName})` : '';
  return {
    title: 'Поступление не распределено',
    message: `Поступление № ${row.number} от ${day}.${month}.${year}${supplier}: не распределено строк — ${row.lines}.`,
  };
}
