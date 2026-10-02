/**
 * Обработка ошибок генерации Excel
 */

export class ExcelGenerationError extends Error {
  constructor(message: string, public originalError?: Error) {
    super(message);
    this.name = 'ExcelGenerationError';
  }
}

/**
 * Обработка ошибок генерации Excel с понятными сообщениями
 */
export const handleExcelError = (error: unknown): string => {
  if (error instanceof ExcelGenerationError) {
    return error.message;
  }

  if (error instanceof Error) {
    // Ошибка загрузки шаблона
    if (error.message.includes('fetch') || error.message.includes('Failed to fetch')) {
      return 'Не удалось загрузить шаблон Excel. Проверьте наличие файла в public/templates/';
    }

    // Ошибка формата шаблона
    if (error.message.includes('Лист не найден') || error.message.includes('worksheet')) {
      return 'Некорректный формат шаблона Excel';
    }

    // Ошибка записи
    if (error.message.includes('write') || error.message.includes('buffer')) {
      return 'Ошибка при формировании Excel файла';
    }

    return `Ошибка генерации Excel: ${error.message}`;
  }

  return 'Неизвестная ошибка при генерации Excel файла';
};
