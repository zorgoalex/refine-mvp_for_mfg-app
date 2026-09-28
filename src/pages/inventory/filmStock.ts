import type { OrderFilmStockDto, StockDocumentDto, StockDocumentLineDto } from '../../api/types/inventoryApi.types';

export type FilmStockBadge = { kind: 'stock' | 'none'; label: string; quantity: number | null };
export function filmStockBadge(stock: number | null | undefined): FilmStockBadge {
  return stock !== null && stock !== undefined && stock > 0
    ? { kind: 'stock', label: `склад ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(stock)} м`, quantity: stock }
    : { kind: 'none', label: 'нет на складе', quantity: stock ?? null };
}
export function filmStockAvailability(status: OrderFilmStockDto['items'][number]['status'] | null | undefined): string {
  switch (status) {
    case 'enough': return 'Хватает';
    case 'short': return 'Не хватает';
    case 'none': return 'Нет на складе';
    case 'unknown_demand': return 'Потребность не рассчитана';
    default: return 'Нет данных';
  }
}
export function unresolvedLineIds(document: StockDocumentDto): Set<number> {
  return new Set(document.unresolved.map((item) => item.lineId));
}
export function inventoryQueryString(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params).filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
}
export type ParsedStockRow = { rowNo: number; name: string; supplier: string | null; quantity: string | null };
export type ParsedStockSheet = { name: string; hasName: boolean; hasSupplier: boolean; rows: ParsedStockRow[] };
const filmHeader = /^(пленка|плёнка|наименование|название|декор)$/i;
const supplierHeader = /^(поставщик|производитель)$/i;
const quantityHeader = /^(количество|кол-во|остаток|пог|метр)/i;
const normalizeHeader = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ');

export function parseStockRows(rows: unknown[][], sheetName = 'Лист1'): ParsedStockSheet {
  const headerIndex = rows.findIndex((row) => row.some((cell) => filmHeader.test(normalizeHeader(cell))) && row.some((cell) => supplierHeader.test(normalizeHeader(cell))));
  if (headerIndex < 0) return { name: sheetName, hasName: false, hasSupplier: false, rows: [] };
  const headers = rows[headerIndex].map(normalizeHeader);
  const nameIndex = headers.findIndex((header) => filmHeader.test(header));
  const supplierIndex = headers.findIndex((header) => supplierHeader.test(header));
  const quantityIndex = headers.findIndex((header) => quantityHeader.test(header));
  const parsed: ParsedStockRow[] = [];
  rows.slice(headerIndex + 1).forEach((row, index) => {
    const name = String(row[nameIndex] ?? '').trim();
    if (!name || /^итого(?:\s|$)/i.test(name)) return;
    const supplier = String(row[supplierIndex] ?? '').trim() || null;
    const rawQuantity = quantityIndex < 0 ? null : String(row[quantityIndex] ?? '').trim() || null;
    parsed.push({ rowNo: headerIndex + index + 2, name, supplier, quantity: rawQuantity });
  });
  return { name: sheetName, hasName: true, hasSupplier: true, rows: parsed };
}

export function decodeStockCsv(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1251').decode(bytes); }
}
export function parseStockCsv(bytes: Uint8Array, sheetName = 'CSV'): ParsedStockSheet {
  const text = decodeStockCsv(bytes).replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const separators = [';', ',', '\t'];
  const delimiter = separators.sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = text.split(/\r?\n/).map((line) => {
    const cells: string[] = []; let value = ''; let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === delimiter && !quoted) { cells.push(value); value = ''; }
      else value += char;
    }
    cells.push(value); return cells;
  });
  return parseStockRows(rows, sheetName);
}
export function selectDefaultStockSheet(sheets: ParsedStockSheet[]): ParsedStockSheet | undefined {
  return sheets.find((sheet) => sheet.hasName && sheet.hasSupplier) ?? sheets[0];
}
export function inventoryLineDisplay(line: StockDocumentLineDto): string {
  return [line.filmName ?? line.rawName ?? 'Плёнка не выбрана', line.rawSupplier].filter(Boolean).join(' · ');
}
