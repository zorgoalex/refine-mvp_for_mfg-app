import type { ParsedSheet, SelectionRange } from '../types/importTypes';

export const ROW_HEIGHT = 26;
export const HEADER_HEIGHT = 52;
export const ROW_HEADER_WIDTH = 40;

export function getScrollFrameScale(timestamp: number, previous: number | null): number {
  return previous === null ? 1 : Math.max(0, Math.min(64, timestamp - previous)) / (1000 / 60);
}

export function getColumnWidths(sheet: ParsedSheet, measure: (text: string) => number, selected: Set<number>): number[] {
  const mergedWidths = new Map<string, number>();
  for (const merge of sheet.merges ?? []) {
    mergedWidths.set(`${merge.startRow}:${merge.startCol}`, merge.endCol - merge.startCol + 1);
  }
  return Array.from({ length: sheet.colCount }, (_, col) => {
    let width = 0;
    for (let row = 0; row < sheet.rowCount; row++) {
      const value = sheet.data[row]?.[col];
      if (value == null || String(value) === '') continue;
      const text = value instanceof Date ? value.toLocaleDateString('ru-RU') : String(value);
      const longest = Math.max(...text.split(/\r?\n/).map(line => measure(line)));
      width = Math.max(width, longest / (mergedWidths.get(`${row}:${col}`) ?? 1) + 14);
    }
    return Math.ceil(Math.max(selected.has(col) ? 64 : width ? 36 : 24, Math.min(width, 280)));
  });
}

export function getGridCell(widths: number[], rows: number, x: number, y: number) {
  let col = 0;
  let edge = ROW_HEADER_WIDTH + (widths[0] ?? 0);
  while (col < widths.length - 1 && x >= edge) edge += widths[++col];
  return { row: Math.max(0, Math.min(rows - 1, Math.floor((y - HEADER_HEIGHT) / ROW_HEIGHT))), col };
}

export function getEdgeVelocity(pointer: number, start: number, end: number): number {
  const zone = Math.min(28, (end - start) / 3);
  if (zone <= 0) return 0;
  if (pointer < start + zone) return -18 * Math.min(1, (start + zone - pointer) / zone);
  if (pointer > end - zone) return 18 * Math.min(1, (pointer - end + zone) / zone);
  return 0;
}

export function moveRange(range: SelectionRange, rows: number, cols: number, rowCount: number, colCount: number): SelectionRange {
  const top = Math.min(range.startRow, range.endRow);
  const bottom = Math.max(range.startRow, range.endRow);
  const left = Math.min(range.startCol, range.endCol);
  const right = Math.max(range.startCol, range.endCol);
  const dy = Math.max(-top, Math.min(rows, rowCount - 1 - bottom));
  const dx = Math.max(-left, Math.min(cols, colCount - 1 - right));
  return { ...range, startRow: top + dy, endRow: bottom + dy, startCol: left + dx, endCol: right + dx };
}
