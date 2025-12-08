/**
 * Генерация Excel файла заказа на основе шаблона
 */

import ExcelJS from 'exceljs';
import { formatDate } from '../printFormat';
import { ExcelGenerationError } from './excelErrorHandler';

// Типы для заказа и деталей
interface OrderDetail {
  detail_id: number;
  length: number | null;
  width: number | null;
  quantity: number;
  area?: number | null;
  milling_cost_per_sqm?: number | null;
  detail_cost?: number | null;
  notes?: string | null;
  milling_type?: { milling_type_name: string } | null;
  edge_type?: { edge_type_name: string } | null;
  film?: { film_name: string } | null;
  material?: { material_name: string } | null;
}

interface Order {
  order_id: number;
  order_name: string;
  order_date: string | Date;
  total_amount?: number | null;
  final_amount?: number | null;
  paid_amount?: number | null;
  client?: { client_name: string } | null;
  // Данные для экспорта (присадка и конструктор)
  _exportData?: {
    prisadkaName?: string;
    prisadkaDesignerName?: string;
  };
}

export interface GenerateOrderExcelParams {
  order: Order;
  details: OrderDetail[];
  client?: { client_name: string } | null;
  clientPhone?: string | null;
}

/**
 * Генерация Excel буфера заказа на основе шаблона
 *
 * Базовая функция, которая возвращает ArrayBuffer для дальнейшей обработки
 * (создание Blob, конвертация в base64, и т.д.)
 *
 * ⚠️ ВАЖНО: Ячейки с формулами НЕ заполняются программно!
 * Формулы: A12-A51 (№), E12-E51 (площадь), J12-J51 (сумма детали),
 *          K8 (общая площадь), M8 (кол-во деталей), J2 (общая сумма), K4 (остаток)
 */
export const buildOrderExcelBuffer = async ({
  order,
  details,
  client,
  clientPhone,
}: GenerateOrderExcelParams): Promise<ArrayBuffer> => {
  try {
    // 1. Загрузить шаблон
    const templateUrl = '/templates/order_template.xlsx';
    const response = await fetch(templateUrl);

    if (!response.ok) {
      throw new ExcelGenerationError(
        'Не удалось загрузить шаблон Excel',
        new Error(`HTTP ${response.status}`)
      );
    }

    const arrayBuffer = await response.arrayBuffer();

    // 2. Создать workbook из шаблона
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);

    // 3. Получить первый лист
    const worksheet = workbook.getWorksheet(1);

    if (!worksheet) {
      throw new ExcelGenerationError('Лист не найден в шаблоне');
    }

    // 4. Заполнить шапку (ТОЛЬКО данные, НЕ формулы!)
    const orderDate =
      typeof order.order_date === 'string' ? new Date(order.order_date) : order.order_date;
    const yearLastTwoDigits = String(orderDate.getFullYear()).slice(-2);

    worksheet.getCell('A1').value = yearLastTwoDigits; // Последние 2 цифры года (25)
    worksheet.getCell('C1').value = order.order_name; // Название заказа (Заказ)
    worksheet.getCell('D2').value = order._exportData?.prisadkaName || ''; // Номер присадки
    worksheet.getCell('E2').value = client?.client_name || order.client?.client_name || 'Не указан'; // Заказчик
    worksheet.getCell('C8').value = formatDate(order.order_date); // Дата заказа (07.01.2025)
    // Конструктор присадки (с префиксом "конструктор ")
    const designEngineer = order._exportData?.prisadkaDesignerName;
    worksheet.getCell('F8').value = designEngineer ? `конструктор ${designEngineer}` : '';
    worksheet.getCell('H8').value = clientPhone || ''; // Телефон клиента

    // 4.1. Заполнить дополнительные поля (defaults для деталей)
    // Заполняем только если значение одинаково для ВСЕХ деталей (умная агрегация)

    // Функция для получения общего значения (если одинаково для всех деталей)
    const getCommonValue = (getValue: (detail: OrderDetail) => string | undefined | null): string => {
      if (details.length === 0) return '';

      const values = details.map(getValue).filter(v => v); // Убрать null/undefined
      if (values.length === 0) return '';

      const firstValue = values[0];
      const allSame = values.every(v => v === firstValue);

      return allSame ? firstValue : '';
    };

    // Умная агрегация: показываем только если одинаково для всех деталей
    worksheet.getCell('A5').value = getCommonValue(d => d.milling_type?.milling_type_name); // Фрезеровка
    worksheet.getCell('D5').value = getCommonValue(d => d.edge_type?.edge_type_name); // Обкат
    worksheet.getCell('F5').value = getCommonValue(d => d.film?.film_name); // Пленка
    worksheet.getCell('H5').value = getCommonValue(d => d.material?.material_name); // Материал

    // ⚠️ НЕ заполняем ячейки с формулами:
    // - J2 (общая сумма) - рассчитывается формулой
    // - K8 (общая площадь) - рассчитывается формулой
    // - M8 (кол-во деталей) - рассчитывается формулой
    // - K4 (остаток оплаты) - рассчитывается формулой

    // 5. Заполнить детали (начиная со строки 12)
    details.forEach((detail, index) => {
      const rowNumber = 12 + index;
      const row = worksheet.getRow(rowNumber);

      // Заполняем ТОЛЬКО данные (7 колонок), НЕ формулы!
      // row.getCell(1) - A: № → НЕ заполнять (формула автонумерации)
      row.getCell(2).value = detail.length || null; // B: Высота (мм)
      row.getCell(3).value = detail.width || null; // C: Ширина (мм)
      row.getCell(4).value = detail.quantity; // D: Кол-во
      // row.getCell(5) - E: Площадь → НЕ заполнять (формула: B×C/1000000)
      row.getCell(6).value = detail.milling_type?.milling_type_name || ''; // F: Тип фрезеровки ⚠️
      row.getCell(7).value = detail.edge_type?.edge_type_name || ''; // G: Обкат/кромка
      row.getCell(8).value = detail.notes || ''; // H: Примечание
      row.getCell(9).value = detail.milling_cost_per_sqm || null; // I: Цена за кв.м.
      // row.getCell(10) - J: Сумма → НЕ заполнять (формула: D×I×E)
      row.getCell(11).value = detail.film?.film_name || ''; // K: Пленка

      // Применить стиль строки (копировать из шаблона)
      row.commit();
    });

    // 6. Очистить пустые строки (если деталей меньше 40)
    // Очищаем только ДАННЫЕ, формулы Excel сохраняются (A, E, J)
    for (let i = details.length; i < 40; i++) {
      const rowNumber = 12 + i;
      const row = worksheet.getRow(rowNumber);

      // Очистить данные (формулы в A, E, J останутся)
      // row.getCell(1) - A: № → НЕ очищаем (формула)
      row.getCell(2).value = null; // B: Высота
      row.getCell(3).value = null; // C: Ширина
      row.getCell(4).value = null; // D: Кол-во
      // row.getCell(5) - E: Площадь → НЕ очищаем (формула)
      row.getCell(6).value = null; // F: Тип фрезеровки
      row.getCell(7).value = null; // G: Обкат
      row.getCell(8).value = null; // H: Примечание
      row.getCell(9).value = null; // I: Цена
      // row.getCell(10) - J: Сумма → НЕ очищаем (формула)
      row.getCell(11).value = null; // K: Пленка

      row.commit();
    }

    // 7. Сгенерировать и вернуть ArrayBuffer
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  } catch (error) {
    console.error('Ошибка генерации Excel:', error);
    if (error instanceof ExcelGenerationError) {
      throw error;
    }
    throw new ExcelGenerationError(
      'Ошибка при генерации Excel файла',
      error instanceof Error ? error : undefined
    );
  }
};

/**
 * Генерация Excel Blob заказа на основе шаблона
 *
 * Обертка над buildOrderExcelBuffer для обратной совместимости
 */
export const generateOrderExcel = async (
  params: GenerateOrderExcelParams
): Promise<Blob> => {
  const buffer = await buildOrderExcelBuffer(params);
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  return blob;
};

/**
 * Скачать Excel файл
 */
export const downloadOrderExcel = async (
  params: GenerateOrderExcelParams,
  fileName: string = 'order.xlsx'
) => {
  try {
    const blob = await generateOrderExcel(params);

    // Создать ссылку для скачивания
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;

    document.body.appendChild(link);
    link.click();

    // Очистить
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Ошибка скачивания Excel:', error);
    throw error;
  }
};
