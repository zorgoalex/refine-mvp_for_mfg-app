import * as XLSX from 'xlsx';
import { ApiError } from '../../../common/errors/api-error';
import type { BazisCutDetailFields } from '../dto/bazis-cut.dto';
import {
  evaluateExportRow,
  EXPORT_LIMITS,
  validateExportColumns,
} from '../../export-templates/application/export-expression';
import type {
  BazisExportDetail,
  ExportExpression,
  ExportTemplateColumn,
  ExportTemplateSnapshot,
} from '../../export-templates/application/export-template.types';
import { buildBazisCutQrCode } from './bazis-cut-identity';

export const BAZIS_CUT_SHEET_NAME = 'Детали для раскроя';

export const BAZIS_CUT_HEADERS = [
  'Кроить', 'Тип материала', 'Материал', 'Артикул материала', 'Толщина',
  'Заказ', 'Изделие', 'Позиция', 'QR-code', 'Наименования', 'Длина готовая', 'Ширина готовая',
  'Длина распиловочная', 'Ширина распиловочная', 'Кол-во', 'Ориентация', 'Паз',
  'L1 - Наим.', 'L1 - Обозн.', 'L1 - Толщина', 'L2 - Наим.', 'L2 - Обозн.',
  'L2 - Толщина', 'W1 - Наим.', 'W1 - Обозн.', 'W1 - Толщина', 'W2 - Наим.',
  'W2 - Обозн.', 'W2 - Толщина', 'Приоритет', 'Комментарий',
  '%Пользовательское свойство', '%Склейка', '%Фрезировка', '%Маршрут', 'Ванна', '%Пленка',
] as const;

const field = (name: string): ExportExpression => ({ type: 'field', field: name });

export const LEGACY_BAZIS_CUT_COLUMNS: ExportTemplateColumn[] = [
  ['cut', 'Кроить', 'legacy.cutEnabled'], ['materialType', 'Тип материала', 'detail.materialType'],
  ['material', 'Материал', 'detail.materialName'], ['materialArticle', 'Артикул материала', 'detail.materialArticle'],
  ['thickness', 'Толщина', 'detail.thicknessMm'], ['order', 'Заказ', 'legacy.order'],
  ['product', 'Изделие', 'legacy.product'], ['position', 'Позиция', 'legacy.position'],
  ['qr', 'QR-code', 'legacy.qr'], ['name', 'Наименования', 'detail.partName'],
  ['finishedLength', 'Длина готовая', 'detail.finishedLengthMm'], ['finishedWidth', 'Ширина готовая', 'detail.finishedWidthMm'],
  ['cutLength', 'Длина распиловочная', 'detail.cutLengthMm'], ['cutWidth', 'Ширина распиловочная', 'detail.cutWidthMm'],
  ['quantity', 'Кол-во', 'detail.quantity'], ['orientation', 'Ориентация', 'detail.orientation'],
  ['groove', 'Паз', 'detail.groove'], ['l1Name', 'L1 - Наим.', 'detail.l1Name'],
  ['l1Designation', 'L1 - Обозн.', 'detail.l1Designation'], ['l1Thickness', 'L1 - Толщина', 'detail.l1ThicknessMm'],
  ['l2Name', 'L2 - Наим.', 'detail.l2Name'], ['l2Designation', 'L2 - Обозн.', 'detail.l2Designation'],
  ['l2Thickness', 'L2 - Толщина', 'detail.l2ThicknessMm'], ['w1Name', 'W1 - Наим.', 'detail.w1Name'],
  ['w1Designation', 'W1 - Обозн.', 'detail.w1Designation'], ['w1Thickness', 'W1 - Толщина', 'detail.w1ThicknessMm'],
  ['w2Name', 'W2 - Наим.', 'detail.w2Name'], ['w2Designation', 'W2 - Обозн.', 'detail.w2Designation'],
  ['w2Thickness', 'W2 - Толщина', 'detail.w2ThicknessMm'], ['priority', 'Приоритет', 'detail.priority'],
  ['comment', 'Комментарий', 'detail.comment'], ['customProperty', '%Пользовательское свойство', 'detail.customProperty'],
  ['glue', '%Склейка', 'detail.glue'], ['milling', '%Фрезировка', 'detail.milling'],
  ['route', '%Маршрут', 'detail.route'], ['bath', 'Ванна', 'source.sourceBathCutNumber'],
  ['film', '%Пленка', 'detail.film'],
].map(([columnKey, header, fieldName]) => ({ columnKey, header, expression: field(fieldName) }));

export function buildBazisCutXls(
  details: readonly BazisCutXlsDetail[],
): Buffer {
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

export function buildBazisCutXlsFromTemplate(
  details: readonly BazisExportDetail[],
  template: ExportTemplateSnapshot,
  exportedAt = new Date(),
): Buffer {
  if (details.length === 0) {
    throw new ApiError(422, 'BAZIS_CUT_SET_EMPTY', 'Нельзя экспортировать пустой набор');
  }
  if (details.length > 65_535) {
    throw new ApiError(422, 'BAZIS_CUT_SET_TOO_LARGE', 'Набор превышает лимит BIFF8');
  }
  const nodeCounts = validateExportColumns(template.columns);
  const cellCount = details.length * template.columns.length;
  const evaluatedNodes = details.length * nodeCounts.reduce((sum, count) => sum + count, 0);
  if (cellCount > EXPORT_LIMITS.maxCells || evaluatedNodes > EXPORT_LIMITS.maxEvaluatedNodes) {
    throw budgetError({ cellCount, evaluatedNodes });
  }

  const startedAt = Date.now();
  let stringChars = 0;
  let visitedCells = 0;
  const rows: unknown[][] = [template.columns.map((column) => column.header)];
  details.forEach((detail, detailIndex) => {
    const context = { rowNumber: detailIndex + 1, exportedAt, templateName: template.name };
    let row: unknown[];
    try {
      row = evaluateExportRow(template.columns, detail, context);
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ApiError(error.statusCode, error.code, error.message, {
          ...(error.details ?? {}), rowNumber: detailIndex + 1,
        });
      }
      throw error;
    }
    visitedCells += row.length;
    if (visitedCells >= 256 && Date.now() - startedAt > EXPORT_LIMITS.maxElapsedMs) {
      throw budgetError({ elapsedMs: Date.now() - startedAt });
    }
    row.forEach((value) => {
      if (typeof value !== 'string') return;
      stringChars += value.length;
      if (stringChars > EXPORT_LIMITS.maxStringChars) throw budgetError({ stringChars });
    });
    rows.push(row);
  });

  const worksheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: false });
  worksheet['!cols'] = template.columns.map((column) => ({
    wch: Math.min(42, Math.max(column.header.length + 2, 12)),
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, template.sheetName);
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }) as Buffer;
  if (bytes.length > EXPORT_LIMITS.maxBytes) throw budgetError({ bytes: bytes.length });
  return bytes;
}

export function bazisCutFieldsToRow(
  detail: BazisCutXlsDetail,
): unknown[] {
  const order = detail.xlsOrder?.trim() ?? detail.sourceBazisOrderNo?.trim() ?? '';
  return [
      detail.cutEnabled ? 'Да' : 'Нет', detail.materialType, safeText(detail.materialName),
      safeText(detail.materialArticle), detail.thicknessMm, safeText(order),
      safeText(detail.sourceBazisProductName ?? ''), safeText(detail.position.trim()),
      buildBazisCutQrCode(detail),
      safeText(detail.partName), detail.finishedLengthMm, detail.finishedWidthMm,
      detail.cutLengthMm, detail.cutWidthMm, detail.quantity, safeText(detail.orientation),
      safeText(detail.groove), safeText(detail.l1Name), safeText(detail.l1Designation),
      detail.l1ThicknessMm, safeText(detail.l2Name), safeText(detail.l2Designation),
      detail.l2ThicknessMm, safeText(detail.w1Name), safeText(detail.w1Designation),
      detail.w1ThicknessMm, safeText(detail.w2Name), safeText(detail.w2Designation),
      detail.w2ThicknessMm, detail.priority, safeText(detail.comment),
      safeText(detail.customProperty), safeText(detail.glue), safeText(detail.milling),
      safeText(detail.route), safeText(detail.sourceBathCutNumber ?? ''), safeText(detail.film),
    ];
}

export type BazisCutXlsDetail = BazisCutDetailFields & {
  sourceBazisProjectName?: string;
  sourceBazisOrderNo?: string;
  sourceBazisProductName?: string;
  sourceBathCutNumber?: string;
  /** Direct Basis-project export preserves its project-derived Excel Order. */
  xlsOrder?: string;
};

function safeText(value: string): string {
  // aoa_to_sheet stores primitive strings as string cells. The explicit cast
  // also documents that operator text must never become an Excel formula.
  return String(value ?? '');
}

function budgetError(details: Record<string, unknown>): ApiError {
  return new ApiError(422, 'EXPORT_TEMPLATE_BUDGET_EXCEEDED', 'Export template evaluation budget exceeded', details);
}
