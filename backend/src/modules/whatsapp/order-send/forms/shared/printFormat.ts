/**
 * Утилиты форматирования для печати заказов
 */

/**
 * Форматирование чисел для печати
 * 15800 -> "15 800"
 * 6.44 -> "6,44"
 *
 * @param value - число для форматирования
 * @param decimals - количество знаков после запятой (по умолчанию 0)
 * @returns отформатированная строка
 */
export const formatNumber = (
  value: number | null | undefined,
  decimals: number = 0
): string => {
  if (value === null || value === undefined || isNaN(value)) {
    return '-';
  }

  // Округлить до нужного количества знаков
  const fixed = value.toFixed(decimals);
  const [integer, decimal] = fixed.split('.');

  // Добавить пробелы как разделители тысяч
  const integerWithSpaces = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  // Если есть дробная часть, добавить её с запятой
  if (decimals > 0 && decimal) {
    return `${integerWithSpaces},${decimal}`;
  }

  return integerWithSpaces;
};

/**
 * Форматирование даты для печати
 * 2025-01-07 -> "07.01.2025"
 *
 * @param date - дата (строка ISO или объект Date)
 * @returns дата в формате DD.MM.YYYY
 */
export const formatDate = (
  date: string | Date | null | undefined
): string => {
  if (!date) {
    return '-';
  }

  try {
    const d = typeof date === 'string' ? new Date(date) : date;

    // Проверка на валидность даты
    if (isNaN(d.getTime())) {
      return '-';
    }

    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();

    return `${day}.${month}.${year}`;
  } catch (error) {
    console.error('Ошибка форматирования даты:', error);
    return '-';
  }
};

/**
 * Получить последние две цифры года из даты
 * 2025-01-07 -> "25"
 *
 * @param date - дата (строка ISO или объект Date)
 * @returns две последние цифры года
 */
export const getYearLastTwoDigits = (
  date: string | Date | null | undefined
): string => {
  if (!date) {
    return '-';
  }

  try {
    const d = typeof date === 'string' ? new Date(date) : date;

    // Проверка на валидность даты
    if (isNaN(d.getTime())) {
      return '-';
    }

    const year = d.getFullYear();
    return String(year).slice(-2);
  } catch (error) {
    console.error('Ошибка получения года:', error);
    return '-';
  }
};

/**
 * Форматирование площади в м²
 * 1.66234 -> "1,66"
 *
 * @param area - площадь в м²
 * @returns отформатированная площадь
 */
export const formatArea = (area: number | null | undefined): string => {
  return formatNumber(area, 2);
};

/**
 * Форматирование цены
 * 15800 -> "15 800"
 *
 * @param price - цена
 * @returns отформатированная цена
 */
export const formatPrice = (price: number | null | undefined): string => {
  return formatNumber(price, 0);
};
