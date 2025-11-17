import {
  format,
  startOfDay,
  addDays,
  isSameDay,
  isWeekend as isWeekendFns,
  parseISO,
} from 'date-fns';
import { ru } from 'date-fns/locale';

/**
 * Генерирует массив дат для календаря
 * @param centerDate - центральная дата (обычно текущая дата)
 * @param daysBack - количество дней назад от centerDate
 * @param daysForward - количество дней вперед от centerDate
 * @returns массив Date объектов
 */
export function generateCalendarDays(
  centerDate: Date,
  daysBack: number,
  daysForward: number
): Date[] {
  const today = startOfDay(centerDate);
  const days: Date[] = [];

  // Генерируем дни от (today - daysBack) до (today + daysForward)
  for (let offset = -daysBack; offset <= daysForward; offset++) {
    const day = addDays(today, offset);
    // ⚠️ Включаем все дни, в том числе воскресенья
    days.push(day);
  }

  return days;
}

/**
 * Форматирует дату в формат DD.MM.YYYY для использования в качестве ключа
 * @param date - дата для форматирования
 * @returns строка в формате DD.MM.YYYY
 */
export function formatDateKey(date: Date | string): string {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return format(dateObj, 'dd.MM.yyyy');
}

/**
 * Форматирует дату для заголовка колонки дня
 * @param date - дата для форматирования
 * @returns строка в формате "12 ноября, пятница"
 */
export function formatDateHeader(date: Date): string {
  return format(date, 'd MMMM, EEEE', { locale: ru });
}

/**
 * Возвращает сокращенное название дня недели
 * @param date - дата
 * @returns строка (Пн, Вт, Ср, Чт, Пт, Сб, Вс)
 */
export function getDayName(date: Date): string {
  const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  return dayNames[date.getDay()];
}

/**
 * Проверяет, является ли дата сегодняшним днем
 * @param date - дата для проверки
 * @returns true если дата совпадает с текущим днем
 */
export function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

/**
 * Проверяет, является ли день выходным (суббота или воскресенье)
 * @param date - дата для проверки
 * @returns true если день выходной
 */
export function isWeekend(date: Date): boolean {
  return isWeekendFns(date);
}

/**
 * Форматирует дату для API запроса (ISO формат YYYY-MM-DD)
 * @param date - дата для форматирования
 * @returns строка в формате YYYY-MM-DD
 */
export function formatDateForApi(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/**
 * Парсит дату из строки в формате DD.MM.YYYY
 * @param dateString - строка даты
 * @returns Date объект или null если парсинг неудачен
 */
export function parseDateFromKey(dateString: string): Date | null {
  try {
    const [day, month, year] = dateString.split('.');
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  } catch (error) {
    console.error('Failed to parse date:', dateString, error);
    return null;
  }
}
