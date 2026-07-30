/**
 * Генерация имени файла для экспорта заказа в Excel
 */

interface GenerateFileNameParams {
  orderId: number;
  orderName: string;
  orderDate: string | Date;
  clientName?: string;
  variant?: 'standard' | 'without-prices';
}

/**
 * Генерация имени файла для экспорта заказа
 * Формат: заказ-Ф<ГГ>-<ID>-<название>-<клиент>.xlsx
 * Пример: заказ-Ф25-10111-1662-Мурат-Ахметов.xlsx
 */
export const generateOrderFileName = ({
  orderId,
  orderName,
  orderDate,
  clientName,
  variant = 'standard',
}: GenerateFileNameParams): string => {
  // Получить две последние цифры года
  const date = typeof orderDate === 'string' ? new Date(orderDate) : orderDate;
  const year = date.getFullYear();
  const yearLastTwoDigits = String(year).slice(-2);

  // Очистить название и имя клиента от недопустимых символов
  const sanitizedOrderName = sanitizeFileName(orderName);
  const sanitizedClientName = clientName ? sanitizeFileName(clientName) : 'Без_имени';

  // Формат: заказ-Ф<ГГ>-<ID>-<название>-<клиент>.xlsx
  const variantSuffix = variant === 'without-prices' ? '-без-цен' : '';
  return `заказ-Ф${yearLastTwoDigits}-${orderId}-${sanitizedOrderName}-${sanitizedClientName}${variantSuffix}.xlsx`;
};

/**
 * Очистка строки от недопустимых символов для имени файла
 * Заменяет пробелы на дефисы, удаляет спецсимволы
 */
const sanitizeFileName = (str: string): string => {
  // Заменить пробелы на дефисы
  let sanitized = str.trim().replace(/\s+/g, '-');

  // Удалить недопустимые символы для Windows/Unix файловых систем
  // Недопустимые: / \ : * ? " < > |
  sanitized = sanitized.replace(/[/\\:*?"<>|]/g, '');

  // Удалить множественные дефисы
  sanitized = sanitized.replace(/-+/g, '-');

  // Убрать дефисы в начале и конце
  sanitized = sanitized.replace(/^-+|-+$/g, '');

  return sanitized;
};
