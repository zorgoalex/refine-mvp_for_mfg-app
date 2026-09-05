import type { FieldMapping, ImportRow, ParsedSheet, SelectionRange } from './types/importTypes';
import { getColumnLetter, getColumnIndex } from './types/importTypes';
import { IMPORT_DEFAULTS } from './types/importTypes';
import type { OrderDetail } from '../../../../types/orders';

/** Reuse only pristine UI scaffolding, never saved, edited or populated rows.
 * Unknown nonempty fields fail closed, including links, references and provenance.
 */
export function getExcelImportPlaceholderIds(details: readonly OrderDetail[]): number[] {
  return details.filter(detail => detail.is_placeholder === true
    && detail.detail_id == null && detail.delete_flag !== true
    && Number.isSafeInteger(detail.temp_id) && Number(detail.temp_id) > 0
    && Object.entries(detail).every(([key, value]) => {
      if (['temp_id', 'detail_number', 'is_placeholder', 'order_id'].includes(key)) return true;
      if (key === 'priority' && value === IMPORT_DEFAULTS.priority) return true;
      if (key === 'milling_type_id' && value === IMPORT_DEFAULTS.milling_type_id) return true;
      if (key === 'edge_type_id' && value === IMPORT_DEFAULTS.edge_type_id) return true;
      return value == null || value === '' || value === 0 || value === false;
    }))
    .sort((left, right) => (left.detail_number ?? 0) - (right.detail_number ?? 0))
    .map(detail => detail.temp_id!);
}

const signature = ['№', 'Высота', 'Ширина', 'Кол-во', 'Площадь', 'Тип детали', 'Обкат',
  'Примечание', 'Цена за кв.м.', 'Сумма', 'Пленка'];
const normalize = (value: unknown) => String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[\s.\-]/g, '');
const filled = (value: unknown) => value != null && String(value).trim() !== '';

export interface DetectedOrderExport {
  range: SelectionRange;
  mapping: FieldMapping;
  materialName: string | null;
}

/** Recognize the existing printable export, not a generic dimension table.
 * Prices, calculated cells, payment columns and the footer are never detail input.
 */
export function detectOrderExport(sheet: ParsedSheet): DetectedOrderExport | null {
  for (let row = 0; row < Math.min(sheet.rowCount, 50); row++) {
    for (let col = 0; col <= sheet.colCount - signature.length; col++) {
      if (!signature.every((label, offset) => normalize(sheet.data[row]?.[col + offset]) === normalize(label))) continue;
      let lastRow = -1;
      for (let r = row + 1; r < sheet.rowCount; r++) {
        const values = sheet.data[r] ?? [];
        // Exported detail ordinals are literal positive integers; footer starts with prose.
        if (filled(values[col]) && !Number.isFinite(Number(values[col]))) break;
        if (Number(values[col]) > 0 && [1, 2, 3].some(offset => filled(values[col + offset]))) lastRow = r;
      }
      if (lastRow < 0) return null;
      const letter = (offset: number) => getColumnLetter(col + offset);
      const material = row >= 6 ? sheet.data[row - 6]?.[col + 7] : null;
      return {
        range: { id: `order-export-${row}-${col}`, startRow: row, endRow: lastRow,
          startCol: col, endCol: col + 10, color: 'rgba(24, 144, 255, 0.2)' },
        mapping: { height: letter(1), width: letter(2), quantity: letter(3), milling_type: letter(5),
          edge_type: letter(6), note: letter(7), film: letter(10), material: null, detail_name: null },
        materialName: typeof material === 'string' && material.trim() ? material.trim() : null,
      };
    }
  }
  return null;
}

/** Extract only user-mapped cells. Validation and reference resolution stay in the existing hook. */
export function extractImportRows(sheet: ParsedSheet, ranges: SelectionRange[], mapping: FieldMapping, hasHeaders: boolean): ImportRow[] {
  const detected = detectOrderExport(sheet);
  const usesExportDimensions = detected && ['height', 'width', 'quantity'].every(
    field => mapping[field as keyof FieldMapping] === detected.mapping[field as keyof FieldMapping],
  );
  const rows: ImportRow[] = [];
  const seenRows = new Set<number>();
  for (const range of ranges) {
    const minRow = Math.max(0, Math.min(range.startRow, range.endRow));
    const maxRow = Math.min(sheet.rowCount - 1, Math.max(range.startRow, range.endRow));
    const minCol = Math.min(range.startCol, range.endCol);
    const maxCol = Math.max(range.startCol, range.endCol);
    for (let r = minRow + (hasHeaders ? 1 : 0); r <= maxRow; r++) {
      if (seenRows.has(r)) continue;
      const getValue = (column: string | null) => {
        const c = column ? getColumnIndex(column) : -1;
        return c >= minCol && c <= maxCol ? sheet.data[r]?.[c] ?? null : null;
      };
      const commonMaterial = usesExportDimensions && detected && r > detected.range.startRow && r <= detected.range.endRow
        ? detected.materialName : null;
      const row: ImportRow = {
        sourceRowIndex: r,
        height: getValue(mapping.height) as number | null,
        width: getValue(mapping.width) as number | null,
        quantity: getValue(mapping.quantity) as number | null,
        edgeTypeName: getValue(mapping.edge_type) as string | null,
        filmName: getValue(mapping.film) as string | null,
        materialName: mapping.material ? getValue(mapping.material) as string | null : commonMaterial,
        millingTypeName: getValue(mapping.milling_type) as string | null,
        note: getValue(mapping.note) as string | null,
        detailName: getValue(mapping.detail_name) as string | null,
      };
      // Preserve zero/invalid values so validation can show them, not silently drop them.
      if (![row.height, row.width, row.quantity].some(filled)) continue;
      seenRows.add(r);
      rows.push(row);
    }
  }
  return rows;
}
