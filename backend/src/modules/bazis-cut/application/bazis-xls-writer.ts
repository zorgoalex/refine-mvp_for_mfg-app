import * as XLSX from 'xlsx';
import { ApiError } from '../../../common/errors/api-error';
import type { BazisCutDetailFields, BazisCutSetDetailDto } from '../dto/bazis-cut.dto';

export const BAZIS_CUT_SHEET_NAME = 'Детали для раскроя';

export const BAZIS_CUT_HEADERS = [
  'Кроить', 'Тип материала', 'Материал', 'Артикул материала', 'Толщина',
  'Заказ', 'Изделие', 'Позиция', 'Наименования', 'Длина готовая', 'Ширина готовая',
  'Длина распиловочная', 'Ширина распиловочная', 'Кол-во', 'Ориентация', 'Паз',
  'L1 - Наим.', 'L1 - Обозн.', 'L1 - Толщина', 'L2 - Наим.', 'L2 - Обозн.',
  'L2 - Толщина', 'W1 - Наим.', 'W1 - Обозн.', 'W1 - Толщина', 'W2 - Наим.',
  'W2 - Обозн.', 'W2 - Толщина', 'Приоритет', 'Комментарий',
  '%Пользовательское свойство', '%Склейка', '%Фрезировка', '%Маршрут', '%Пленка',
] as const;

export function buildBazisCutXls(details: readonly BazisCutSetDetailDto[]): Buffer {
  if (details.length === 0) {
    throw new ApiError(422, 'BAZIS_CUT_SET_EMPTY', 'Нельзя экспортировать пустой набор');
  }
  if (details.length > 65_535) {
    throw new ApiError(422, 'BAZIS_CUT_SET_TOO_LARGE', 'Набор превышает лимит BIFF8');
  }

  const rows: unknown[][] = [
    [...BAZIS_CUT_HEADERS],
    ...details.map(bazisCutFieldsToRow),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: false });
  worksheet['!cols'] = BAZIS_CUT_HEADERS.map((header, index) => ({
    wch: Math.min(42, Math.max(header.length + 2, index >= 5 && index <= 10 ? 16 : 12)),
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, BAZIS_CUT_SHEET_NAME);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }) as Buffer;
}

export function bazisCutFieldsToRow(
  detail: BazisCutDetailFields & { sourceBazisOrderNo?: string; sourceBazisProductName?: string },
): unknown[] {
  return [
      detail.cutEnabled ? 'Да' : 'Нет', detail.materialType, safeText(detail.materialName),
      safeText(detail.materialArticle), detail.thicknessMm, safeText(detail.sourceBazisOrderNo ?? ''),
      safeText(detail.sourceBazisProductName ?? ''), exportPosition(detail),
      safeText(detail.partName), detail.finishedLengthMm, detail.finishedWidthMm,
      detail.cutLengthMm, detail.cutWidthMm, detail.quantity, safeText(detail.orientation),
      safeText(detail.groove), safeText(detail.l1Name), safeText(detail.l1Designation),
      detail.l1ThicknessMm, safeText(detail.l2Name), safeText(detail.l2Designation),
      detail.l2ThicknessMm, safeText(detail.w1Name), safeText(detail.w1Designation),
      detail.w1ThicknessMm, safeText(detail.w2Name), safeText(detail.w2Designation),
      detail.w2ThicknessMm, detail.priority, safeText(detail.comment),
      safeText(detail.customProperty), safeText(detail.glue), safeText(detail.milling),
      safeText(detail.route), safeText(detail.film),
    ];
}

function exportPosition(
  detail: BazisCutDetailFields & { sourceBazisOrderNo?: string; sourceBazisProductName?: string },
): string {
  const prefix = `${detail.sourceBazisOrderNo?.trim() ?? ''}${detail.sourceBazisProductName?.trim() ?? ''}`;
  return prefix ? `${prefix}.${detail.position.trim()}` : detail.position.trim();
}

function safeText(value: string): string {
  // aoa_to_sheet stores primitive strings as string cells. The explicit cast
  // also documents that operator text must never become an Excel formula.
  return String(value ?? '');
}
