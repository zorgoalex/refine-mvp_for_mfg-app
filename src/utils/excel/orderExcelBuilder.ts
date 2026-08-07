/**
 * Генерация Excel файла заказа на основе шаблона
 */

import { formatDate } from '../printFormat';
import { ExcelGenerationError } from './excelErrorHandler';

const DETAIL_START_ROW = 12;
const DETAIL_TEMPLATE_LAST_ROW = 66;
const DETAIL_INSERT_BEFORE_ROW = 67;
const DETAIL_TEMPLATE_CAPACITY = DETAIL_TEMPLATE_LAST_ROW - DETAIL_START_ROW + 1;
const PRINT_AREA_TRAILING_ROWS = 16;
const FOOTER_TEMPLATE_START_ROW = 67;
const FOOTER_TEMPLATE_END_ROW = 72;
const FOOTER_TEMPLATE_COLUMN_COUNT = 17;

const FOOTER_MERGES = [
  { top: 68, left: 1, bottom: 69, right: 8 },
  { top: 70, left: 1, bottom: 70, right: 9 },
  { top: 71, left: 1, bottom: 72, right: 8 },
];

// Типы для заказа, деталей и платежей
export interface OrderExcelDetail {
  detail_id: number;
  length: number | null;
  width: number | null;
  quantity: number;
  area?: number | null;
  milling_cost_per_sqm?: number | null;
  detail_cost?: number | null;
  notes?: string | null;
  doweling?: boolean;
  milling_type?: { milling_type_name: string } | null;
  edge_type?: { edge_type_name: string } | null;
  film?: { film_name: string } | null;
  material?: { material_name: string } | null;
}

export interface OrderExcelBlankRow {
  kind: 'blank';
}

export type OrderExcelDetailRow = OrderExcelDetail | OrderExcelBlankRow;

interface OrderPayment {
  payment_id: number;
  payment_date: string | Date | null;
  amount: number | null;
  payment_type?: { payment_type_name: string } | null;
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
  details: OrderExcelDetailRow[];
  payments?: OrderPayment[];
  client?: { client_name: string } | null;
  clientPhone?: string | null;
  pricingMode?: 'full' | 'omit';
}

const cloneStyle = (style: any) => JSON.parse(JSON.stringify(style ?? {}));
const cloneValue = (value: any) => (
  value && typeof value === 'object'
    ? JSON.parse(JSON.stringify(value))
    : value
);

const isBlankDetailRow = (detail: OrderExcelDetailRow): detail is OrderExcelBlankRow => (
  'kind' in detail && detail.kind === 'blank'
);

export function formatOrderExcelDetailNote(
  notes: string | null | undefined,
  doweling: boolean | undefined,
): string {
  const original = notes ?? '';
  if (doweling !== true) return original;

  const normalized = original.replace(/\r\n?/g, '\n').trim();
  if (normalized.toLocaleLowerCase('ru-RU').includes('присадка')) return normalized;
  return normalized ? `Присадка\n${normalized}` : 'Присадка';
}

function address(row: number, column: number) {
  let columnName = '';
  let columnNumber = column;

  while (columnNumber > 0) {
    const remainder = (columnNumber - 1) % 26;
    columnName = String.fromCharCode(65 + remainder) + columnName;
    columnNumber = Math.floor((columnNumber - 1) / 26);
  }

  return `${columnName}${row}`;
}

function mergeAddress(merge: { top: number; left: number; bottom: number; right: number }, rowOffset = 0) {
  return `${address(merge.top + rowOffset, merge.left)}:${address(merge.bottom + rowOffset, merge.right)}`;
}

function safeUnmergeCells(worksheet: any, range: string) {
  try {
    worksheet.unMergeCells(range);
  } catch {
    // ExcelJS throws when the range is not currently merged.
  }
}

function captureFooterTemplate(worksheet: any) {
  const rows = [];

  for (let rowNumber = FOOTER_TEMPLATE_START_ROW; rowNumber <= FOOTER_TEMPLATE_END_ROW; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const cells = [];

    for (let column = 1; column <= FOOTER_TEMPLATE_COLUMN_COUNT; column += 1) {
      const cell = row.getCell(column);
      cells.push({
        value: cloneValue(cell.value),
        style: cloneStyle(cell.style),
      });
    }

    rows.push({
      height: row.height,
      cells,
    });
  }

  return rows;
}

function restoreFooterTemplate(worksheet: any, footerTemplate: ReturnType<typeof captureFooterTemplate>, rowOffset: number) {
  FOOTER_MERGES.forEach((merge) => {
    safeUnmergeCells(worksheet, mergeAddress(merge));
    safeUnmergeCells(worksheet, mergeAddress(merge, rowOffset));
  });

  footerTemplate.forEach((templateRow, rowIndex) => {
    const targetRow = worksheet.getRow(FOOTER_TEMPLATE_START_ROW + rowOffset + rowIndex);
    targetRow.height = templateRow.height;

    templateRow.cells.forEach((templateCell, cellIndex) => {
      const targetCell = targetRow.getCell(cellIndex + 1);
      targetCell.value = cloneValue(templateCell.value);
      targetCell.style = cloneStyle(templateCell.style);
    });
  });

  FOOTER_MERGES.forEach((merge) => {
    worksheet.mergeCells(mergeAddress(merge, rowOffset));
  });
}

function applyDetailRowLayout(
  worksheet: any,
  rowNumber: number,
  pricingMode: GenerateOrderExcelParams['pricingMode'],
) {
  const templateRow = worksheet.getRow(DETAIL_TEMPLATE_LAST_ROW);
  const targetRow = worksheet.getRow(rowNumber);
  targetRow.height = templateRow.height;

  for (let column = 1; column <= 13; column += 1) {
    const sourceCell = templateRow.getCell(column);
    const targetCell = targetRow.getCell(column);
    targetCell.style = cloneStyle(sourceCell.style);
  }

  targetRow.getCell(1).value = null;
  targetRow.getCell(5).value = {
    formula: `ROUND((B${rowNumber}/1000)*(C${rowNumber}/1000)*D${rowNumber},2)`,
  };
  targetRow.getCell(10).value = pricingMode === 'omit'
    ? null
    : { formula: `E${rowNumber}*I${rowNumber}` };
}

function prepareDetailRows(
  worksheet: any,
  detailCount: number,
  pricingMode: GenerateOrderExcelParams['pricingMode'],
) {
  const extraRows = Math.max(0, detailCount - DETAIL_TEMPLATE_CAPACITY);
  const footerTemplate = captureFooterTemplate(worksheet);

  if (extraRows > 0) {
    FOOTER_MERGES.forEach((merge) => safeUnmergeCells(worksheet, mergeAddress(merge)));
    worksheet.spliceRows(
      DETAIL_INSERT_BEFORE_ROW,
      0,
      ...Array.from({ length: extraRows }, () => []),
    );
  }

  const lastDetailRow = DETAIL_START_ROW + Math.max(detailCount, DETAIL_TEMPLATE_CAPACITY) - 1;
  for (let rowNumber = DETAIL_START_ROW; rowNumber <= lastDetailRow; rowNumber += 1) {
    applyDetailRowLayout(worksheet, rowNumber, pricingMode);
  }

  worksheet.getCell('J2').value = pricingMode === 'omit'
    ? null
    : { formula: `SUM(J${DETAIL_START_ROW}:J${lastDetailRow})` };
  worksheet.getCell('K8').value = {
    formula: `ROUND(SUMPRODUCT(B${DETAIL_START_ROW}:B${lastDetailRow},C${DETAIL_START_ROW}:C${lastDetailRow},D${DETAIL_START_ROW}:D${lastDetailRow})/1000000,2)`,
  };
  worksheet.getCell('M8').value = { formula: `SUM(D${DETAIL_START_ROW}:D${lastDetailRow})` };
  worksheet.pageSetup.printArea = `A1:M${lastDetailRow + PRINT_AREA_TRAILING_ROWS}`;
  restoreFooterTemplate(worksheet, footerTemplate, extraRows);

  return lastDetailRow;
}

/**
 * Генерация Excel буфера заказа на основе шаблона
 *
 * Базовая функция, которая возвращает ArrayBuffer для дальнейшей обработки
 * (создание Blob, конвертация в base64, и т.д.)
 *
 * ⚠️ ВАЖНО: Ячейки с формулами НЕ заполняются готовыми значениями.
 * Формулы: A/E/J в строках деталей, K8 (общая площадь),
 *          M8 (кол-во деталей), J2 (общая сумма), K4 (остаток).
 * В режиме pricingMode='omit' финансовые I/J/J2/L2/K4 остаются пустыми.
 * Диапазон деталей расширяется динамически, если позиций больше 55.
 */
export const buildOrderExcelBuffer = async ({
  order,
  details,
  payments = [],
  client,
  clientPhone,
  pricingMode = 'full',
}: GenerateOrderExcelParams): Promise<ArrayBuffer> => {
  try {
    // Lazy-load ExcelJS to keep the initial bundle smaller.
    const { default: ExcelJS } = await import('exceljs');

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
    const getCommonValue = (getValue: (detail: OrderExcelDetail) => string | undefined | null): string => {
      const realDetails = details.filter((detail): detail is OrderExcelDetail => !isBlankDetailRow(detail));
      if (realDetails.length === 0) return '';

      const values = realDetails.map(getValue).filter(v => v); // Убрать null/undefined
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

    // ⚠️ Не подменяем формулы готовыми значениями:
    // - J2 (общая сумма) - рассчитывается формулой
    // - K8 (общая площадь) - рассчитывается формулой
    // - M8 (кол-во деталей) - рассчитывается формулой
    // - K4 (остаток оплаты) - рассчитывается формулой

    // 5. Заполнить детали (начиная со строки 12)
    const lastDetailRow = prepareDetailRows(worksheet, details.length, pricingMode);

    if (pricingMode === 'omit') {
      // L2 and K4 derive discounted total and outstanding balance from J2.
      // Clear them with the total so the price-free export cannot show
      // misleading zero or negative financial values.
      worksheet.getCell('L2').value = null;
      worksheet.getCell('K4').value = null;
    }

    let detailOrdinal = 0;
    details.forEach((detail, index) => {
      const rowNumber = DETAIL_START_ROW + index;
      const row = worksheet.getRow(rowNumber);

      if (isBlankDetailRow(detail)) {
        for (let column = 1; column <= 13; column += 1) {
          row.getCell(column).value = null;
        }
        row.commit();
        return;
      }

      detailOrdinal += 1;
      // Заполняем только данные; формулы ставит prepareDetailRows().
      row.getCell(1).value = detailOrdinal; // A: № без учета пустых строк группировки
      row.getCell(2).value = detail.length || null; // B: Высота (мм)
      row.getCell(3).value = detail.width || null; // C: Ширина (мм)
      row.getCell(4).value = detail.quantity; // D: Кол-во
      row.getCell(6).value = detail.milling_type?.milling_type_name || ''; // F: Тип фрезеровки ⚠️
      row.getCell(7).value = detail.edge_type?.edge_type_name || ''; // G: Обкат/кромка
      const noteCell = row.getCell(8);
      const note = formatOrderExcelDetailNote(detail.notes, detail.doweling);
      noteCell.value = note; // H: Примечание
      noteCell.alignment = { ...noteCell.alignment, wrapText: true };
      const noteLineCount = note === '' ? 1 : note.split('\n').length;
      if (noteLineCount > 1) {
        row.height = Math.max(row.height ?? 13.9, 13.9 * noteLineCount);
      }
      row.getCell(9).value = pricingMode === 'omit'
        ? null
        : detail.milling_cost_per_sqm || null; // I: Цена за кв.м.
      row.getCell(11).value = detail.film?.film_name || ''; // K: Пленка

      // Применить стиль строки (копировать из шаблона)
      row.commit();
    });

    // 6. Очистить пустые строки (если деталей меньше вместимости шаблона)
    // Очищаем только ДАННЫЕ, формулы Excel сохраняются (A, E, J)
    for (let rowNumber = DETAIL_START_ROW + details.length; rowNumber <= lastDetailRow; rowNumber += 1) {
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

    // 7. Заполнить платежи (столбцы O, P, Q начиная со строки 6)
    // O = тип оплаты, P = дата оплаты, Q = сумма оплаты
    // Платежи отсортированы по дате по возрастанию
    payments.forEach((payment, index) => {
      const rowNumber = 6 + index; // Первый платеж на строке 6
      const row = worksheet.getRow(rowNumber);

      // O (15) - Тип оплаты
      row.getCell(15).value = payment.payment_type?.payment_type_name || '';
      // P (16) - Дата оплаты
      row.getCell(16).value = payment.payment_date ? formatDate(payment.payment_date) : '';
      // Q (17) - Сумма оплаты
      row.getCell(17).value = payment.amount || null;

      row.commit();
    });

    // 8. Сгенерировать и вернуть ArrayBuffer
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
