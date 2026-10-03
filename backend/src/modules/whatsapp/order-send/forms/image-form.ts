import { renderAsync } from '@resvg/resvg-js';
import type { OrderFormData, OrderFormDetail } from './order-form-data';
import { area, common, date, decimal, detailSum, fontPath, money, note, rows, type Row } from './form-layout';

const FAMILY = 'Liberation Sans';
/** Logical width of the sheet; rendered at ZOOM (1000 × 1.4 = 1400 px wide pictures). */
const SHEET = 1000;
const ZOOM = 1.4;
const PAD = 8;
const ROW = 17;
const HEAD = 46;
const GRID = '#9a9a9a';
const LINE = '#000000';
const YELLOW = '#ffff00';
/** Details per picture (the sample sheets fit 66+ lines on one): a longer order is split into several pictures. */
export const IMAGE_DETAILS_PER_PAGE = 70;
export const IMAGE_MAX_PAGES = 20;

export class OrderImageTooLongError extends Error {}

type Align = 'start' | 'middle' | 'end';
interface Column { key: string; title: string; width: number; align: Align; size: number; vertical?: boolean; fill?: string; italic?: boolean }

/** Columns of the order Excel sheet (relative widths taken from the sheet); production drops price and sum. */
const COLUMNS: Column[] = [
  { key: 'no', title: '№', width: 26, align: 'start', size: 10 },
  { key: 'height', title: 'Высота', width: 56, align: 'start', size: 15 },
  { key: 'width', title: 'Ширина', width: 60, align: 'start', size: 15 },
  { key: 'quantity', title: 'Кол-во', width: 28, align: 'start', size: 15, vertical: true },
  { key: 'area', title: 'Площадь', width: 44, align: 'end', size: 10.5, vertical: true },
  { key: 'type', title: 'Тип детали', width: 150, align: 'middle', size: 11 },
  { key: 'edge', title: 'Обкат', width: 30, align: 'middle', size: 10.5, vertical: true },
  { key: 'note', title: 'Примечание', width: 175, align: 'middle', size: 10.5, fill: YELLOW, italic: true },
  { key: 'price', title: 'Цена за кв.м.', width: 62, align: 'end', size: 11 },
  { key: 'sum', title: 'Сумма', width: 92, align: 'end', size: 11 },
  { key: 'film', title: 'Пленка', width: 160, align: 'end', size: 10.5, fill: YELLOW, italic: true },
];

/**
 * Order form as PNG pictures (WhatsApp images) in the look of the order Excel sheet: the sheet head
 * (order, client, totals, common parameters, date, phone, area, count) and the grid of details grouped
 * by film. `financial=false` — «для производства»: no prices, sums, balance or client phone (the data is
 * already projected). Up to 70 details per picture; full pictures share one height, the last one is cut
 * to its content; «стр. k/N» on each when there are several.
 */
export async function renderOrderImages(data: OrderFormData, financial: boolean): Promise<Buffer[]> {
  const regular = fontPath('LiberationSans-Regular.ttf');
  const bold = fontPath('LiberationSans-Bold.ttf');
  if (!regular || !bold) throw new Error('Liberation Sans fonts are missing from backend assets');
  const pages = paginate(rows(data, false));
  if (pages.length > IMAGE_MAX_PAGES) throw new OrderImageTooLongError(`${pages.length} pages`);
  const drawn = pages.map((pageRows, index) => drawPage(data, financial, pageRows, index, pages.length));
  // Full pages share one height (WhatsApp shows pictures of a different shape at a different width);
  // the last page is cut to its content.
  const fullHeight = Math.max(...drawn.slice(0, -1).map((page) => page.height), 0);
  const result: Buffer[] = [];
  for (const [index, page] of drawn.entries()) {
    const height = index === drawn.length - 1 ? page.height : fullHeight;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r(SHEET * ZOOM)}" height="${r(height * ZOOM)}" viewBox="0 0 ${SHEET} ${r(height)}">`
      + `<rect width="${SHEET}" height="${r(height)}" fill="#ffffff"/>${page.body}`
      + (pages.length > 1 ? text(SHEET - PAD, height - 5, `стр. ${page.number}/${pages.length}`, { size: 10, anchor: 'end', fill: '#555555' }) : '')
      + '</svg>';
    // Off the event loop (resvg's thread pool), one page after another.
    const image = await renderAsync(svg, { font: { fontFiles: [regular, bold], defaultFontFamily: FAMILY, loadSystemFonts: false } });
    result.push(Buffer.from(image.asPng()));
  }
  return result;
}

/** The SVG bodies of every page, for tests (what the pictures say, without rasterizing). */
export function drawSvgForTest(data: OrderFormData, financial: boolean): string {
  const pages = paginate(rows(data, false));
  return pages.map((pageRows, index) => drawPage(data, financial, pageRows, index, pages.length).body).join('\n');
}

/** Splits the rows into pages of at most 70 details; a blank group separator never starts or ends a page. */
export function paginate(list: Row[]): Row[][] {
  const pages: Row[][] = [];
  let current: Row[] = [];
  let details = 0;
  for (const row of list) {
    if (row.kind === 'detail' && details === IMAGE_DETAILS_PER_PAGE) {
      pages.push(current);
      current = [];
      details = 0;
    }
    if (row.kind === 'blank' && current.length === 0) continue;
    current.push(row);
    if (row.kind === 'detail') details += 1;
  }
  if (current.length || pages.length === 0) pages.push(current);
  return pages.map((page) => (page.at(-1)?.kind === 'blank' ? page.slice(0, -1) : page));
}

function columnsFor(financial: boolean): Array<Column & { x: number; w: number }> {
  const list = COLUMNS.filter((column) => financial || (column.key !== 'price' && column.key !== 'sum'));
  const total = list.reduce((sum, column) => sum + column.width, 0);
  let x = PAD;
  return list.map((column) => {
    const w = (column.width / total) * (SHEET - PAD * 2);
    const placed = { ...column, x, w };
    x += w;
    return placed;
  });
}

function drawPage(data: OrderFormData, financial: boolean, pageRows: Row[], index: number, total: number) {
  const columns = columnsFor(financial);
  let y = PAD;
  let body = '';
  if (index === 0) {
    const head = header(data, financial, y);
    body += head.body;
    y = head.y;
  } else {
    body += text(PAD + 4, y + 18, `Заказ ${data.orderName}`, { size: 16, bold: true });
    if (data.clientName) body += text(PAD + 12 + width(`Заказ ${data.orderName}`, 16), y + 18, data.clientName, { size: 13 });
    y += 28;
  }
  // Table head (yellow for «Примечание» and «Пленка», vertical text for the narrow columns).
  for (const column of columns) {
    body += cell(column.x, y, column.w, HEAD, column.fill);
    body += column.vertical
      ? vertical(column.x + column.w / 2, y + HEAD / 2, column.title, column.key === 'area' ? 7.5 : 10)
      : centered(column.x, y, column.w, HEAD, column.title, 11.5);
  }
  y += HEAD;
  for (const row of pageRows) {
    const height = row.kind === 'blank' ? ROW : rowHeight(row.detail, columns);
    for (const column of columns) {
      body += cell(column.x, y, column.w, height, undefined, true);
      if (row.kind === 'blank') continue;
      body += cellText(column, columnValue(row, column.key, financial), y, height);
    }
    y += height;
  }
  // The sheet border.
  body += `<rect x="${PAD}" y="${r(PAD)}" width="${SHEET - PAD * 2}" height="${r(y - PAD)}" fill="none" stroke="${LINE}" stroke-width="1.2"/>`;
  return { body, height: Math.ceil(y + PAD + (total > 1 ? 14 : 0)), number: index + 1 };
}

/** The sheet head as in the order Excel template. */
function header(data: OrderFormData, financial: boolean, top: number): { body: string; y: number } {
  const L = PAD;
  const W = SHEET - PAD * 2;
  const x = (fraction: number) => L + W * fraction;
  let body = '';
  // Row 1: year · order · № присадки | Заказчик | общая сумма.
  const r1 = 44;
  body += cell(L, top, x(0.2) - L, r1) + cell(x(0.2), top, x(0.7) - x(0.2), r1) + cell(x(0.7), top, x(1) - x(0.7), r1);
  body += text(L + 3, top + 12, String(data.orderDate.getFullYear()).slice(-2), { size: 9 });
  body += text(L + 26, top + 33, data.orderName, { size: 21, bold: true });
  body += text(x(0.115), top + 11, '№ присадки', { size: 7.5, fill: '#c00000' });
  body += text(x(0.115), top + 33, data.prisadkaName ?? '', { size: 15, bold: true, fill: '#c00000' });
  body += text((x(0.2) + x(0.7)) / 2, top + 13, 'Заказчик', { size: 11.5, bold: true, anchor: 'middle' });
  body += text((x(0.2) + x(0.7)) / 2, top + 35, fitText(data.clientName ?? 'Не указан', x(0.5) - 10, 17), { size: 17, bold: true, anchor: 'middle' });
  body += text((x(0.7) + x(1)) / 2, top + 13, 'общая сумма', { size: 11 , anchor: 'middle' });
  body += text((x(0.7) + x(1)) / 2, top + 35, financial ? kzt(data.totalAmount) : '', { size: 14, bold: true, anchor: 'middle' });
  let y = top + r1;
  // Row 2: фрезеровка / обкат / пленка (labels, then values) | материал | остаток оплаты, срок выполнения.
  const label = 14;
  const r2 = 48;
  const commonCells: Array<[number, number, string, string]> = [
    [0, 0.12, 'фрезеровка', common(data.details, (detail) => detail.millingType)],
    [0.12, 0.21, 'обкат', common(data.details, (detail) => detail.edgeType)],
    [0.21, 0.43, 'пленка', common(data.details, (detail) => detail.film)],
  ];
  for (const [from, to, name, value] of commonCells) {
    body += cell(x(from), y, x(to) - x(from), label) + cell(x(from), y + label, x(to) - x(from), r2 - label);
    body += text((x(from) + x(to)) / 2, y + 11, name, { size: 10.5, anchor: 'middle', italic: true });
    body += text((x(from) + x(to)) / 2, y + label + 22, fitText(value, x(to) - x(from) - 6, 13), { size: 13, bold: true, anchor: 'middle' });
  }
  const material = data.details.length ? common(data.details, (detail) => detail.material) : data.headerMaterial ?? '';
  body += cell(x(0.43), y, x(0.66) - x(0.43), r2);
  body += text((x(0.43) + x(0.66)) / 2, y + r2 / 2 + 6, fitText(material, x(0.23) - 8, 17), { size: 17, bold: true, anchor: 'middle' });
  body += cell(x(0.66), y, x(0.79) - x(0.66), r2 / 2) + cell(x(0.66), y + r2 / 2, x(0.79) - x(0.66), r2 / 2);
  body += text((x(0.66) + x(0.79)) / 2, y + 16, 'остаток оплаты', { size: 9.5, anchor: 'middle', italic: true });
  body += text((x(0.66) + x(0.79)) / 2, y + r2 / 2 + 16, 'срок выполнения', { size: 9.5, anchor: 'middle', italic: true });
  const balance = financial && data.finalAmount !== null ? data.finalAmount - (data.paidAmount ?? 0) : null;
  body += cell(x(0.79), y, x(1) - x(0.79), r2 / 2) + cell(x(0.79), y + r2 / 2, x(1) - x(0.79), r2 / 2);
  body += text((x(0.79) + x(1)) / 2, y + 18, financial ? kzt(balance) : '', { size: 14, bold: true, anchor: 'middle' });
  body += text((x(0.79) + x(1)) / 2, y + r2 / 2 + 17, date(data.completionDate), { size: 12, bold: true, anchor: 'middle' });
  y += r2;
  // Row 3: Дата | date | конструктор | phone | общая площадь | value | кол-во деталей | count.
  const r3 = 32;
  const totalArea = Math.round(data.details.reduce((sum, detail) => sum + (area(detail) ?? 0), 0) * 100) / 100;
  const quantity = data.details.reduce((sum, detail) => sum + detail.quantity, 0);
  const row3: Array<[number, number, string, { size: number; bold?: boolean; italic?: boolean; anchor?: Align }]> = [
    [0, 0.1, 'Дата', { size: 12, bold: true, italic: true }],
    [0.1, 0.25, date(data.orderDate), { size: 12.5, bold: true }],
    [0.25, 0.43, data.prisadkaDesignerName ? `конструктор ${data.prisadkaDesignerName}` : '', { size: 10, bold: true }],
    // The client's phone only on «Изображение заказа»: the production picture goes to workshop chats.
    [0.43, 0.66, financial ? data.clientPhone ?? '' : '', { size: 18, bold: true }],
    [0.66, 0.79, 'общая площадь', { size: 10.5, italic: true }],
    [0.79, 0.88, decimal(totalArea), { size: 13, bold: true }],
    [0.88, 0.95, 'кол-во деталей', { size: 8.5, italic: true }],
    [0.95, 1, String(quantity), { size: 13, bold: true }],
  ];
  for (const [from, to, value, options] of row3) {
    body += cell(x(from), y, x(to) - x(from), r3);
    const lines = wrap(value, x(to) - x(from) - 6, options.size, 2);
    lines.forEach((line, lineIndex) => {
      const baseline = y + r3 / 2 + options.size / 3 + (lineIndex - (lines.length - 1) / 2) * (options.size + 1);
      body += text((x(from) + x(to)) / 2, baseline, line, { ...options, anchor: 'middle' });
    });
  }
  return { body, y: y + r3 + 4 };
}

function rowHeight(detail: OrderFormDetail, columns: Array<Column & { w: number }>): number {
  const noteColumn = columns.find((column) => column.key === 'note');
  const lines = noteColumn ? wrap(note(detail).replace(/\n+/g, ' '), noteColumn.w - 6, noteColumn.size, 2).length : 1;
  return lines > 1 ? ROW * 2 - 2 : ROW;
}

function columnValue(row: Row, key: string, financial: boolean): string {
  if (row.kind === 'blank') return '';
  const detail = row.detail;
  switch (key) {
    case 'no': return String(row.ordinal);
    case 'height': return detail.height === null ? '' : String(detail.height);
    case 'width': return detail.width === null ? '' : String(detail.width);
    case 'quantity': return String(detail.quantity);
    case 'area': return decimal(area(detail));
    case 'type': return detail.millingType ?? '';
    case 'edge': return detail.edgeType ?? '';
    case 'note': return note(detail).replace(/\n+/g, ' ');
    case 'price': return financial ? money(detail.millingCostPerSqm) : '';
    case 'sum': return financial ? money(detailSum(detail)) : '';
    case 'film': return detail.film ?? '';
    default: return '';
  }
}

function cellText(column: Column & { x: number; w: number }, value: string, y: number, height: number): string {
  if (!value) return '';
  const numeric = ['no', 'height', 'width', 'quantity', 'area', 'price', 'sum'].includes(column.key);
  // Numbers are never cut: a long one gets a smaller font instead («1000» in the narrow «№»).
  const size = numeric ? fittingSize(value, column.w - 6, column.size) : column.size;
  const lines = numeric ? [value] : wrap(value, column.w - 6, column.size, column.key === 'note' ? 2 : 1);
  const x = column.align === 'start' ? column.x + 3 : column.align === 'end' ? column.x + column.w - 3 : column.x + column.w / 2;
  return lines.map((line, index) => {
    const baseline = y + height / 2 + size / 3 + (index - (lines.length - 1) / 2) * (size + 1);
    return text(x, baseline, line, { size, anchor: column.align, italic: column.italic });
  }).join('');
}

const kzt = (value: number | null) => (value === null ? '' : `${money(value)} KZT`);

/** Approximate advance of Liberation Sans (no text measuring in SVG): wide enough for Cyrillic. */
function width(value: string, size: number): number {
  let units = 0;
  for (const char of value) units += /[0-9.,\s]/.test(char) ? 0.5 : /[A-ZА-ЯЁШЩЖМЮ]/.test(char) ? 0.72 : 0.56;
  return units * size;
}

/** The largest font (down to 7) at which the whole value fits. */
export function fittingSize(value: string, maxWidth: number, size: number): number {
  let current = size;
  while (current > 7 && width(value, current) > maxWidth) current -= 0.5;
  return current;
}

function fitText(value: string, maxWidth: number, size: number): string {
  return wrap(value, maxWidth, size, 1)[0];
}

/** Word wrap into at most `maxLines` lines; the last line ends with «…» when the text does not fit. */
export function wrap(value: string, maxWidth: number, size: number, maxLines: number): string[] {
  if (!value) return [''];
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (width(candidate, size) <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  const consumed = lines.join(' ').length;
  const truncated = consumed < words.join(' ').length;
  const result = lines.slice(0, maxLines).map((line) => fit(line, maxWidth, size));
  if (truncated) result[result.length - 1] = fit(`${result[result.length - 1]}…`, maxWidth, size, true);
  return result;
}

function fit(line: string, maxWidth: number, size: number, ellipsis = false): string {
  if (width(line, size) <= maxWidth) return line;
  let cut = line.replace(/…$/, '');
  while (cut.length > 1 && width(`${cut}…`, size) > maxWidth) cut = cut.slice(0, -1);
  return ellipsis || cut !== line ? `${cut}…` : cut;
}

function cell(x: number, y: number, boxWidth: number, height: number, fill?: string, grid = false): string {
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(boxWidth)}" height="${r(height)}" fill="${fill ?? '#ffffff'}" stroke="${grid ? GRID : LINE}" stroke-width="${grid ? 0.6 : 0.9}"/>`;
}

function centered(x: number, y: number, boxWidth: number, height: number, value: string, size: number): string {
  const lines = wrap(value, boxWidth - 4, size, 2);
  const first = y + height / 2 - ((lines.length - 1) * (size + 1)) / 2 + size / 3;
  return lines.map((line, index) => text(x + boxWidth / 2, first + index * (size + 1), line, { size, bold: true, anchor: 'middle' })).join('');
}

/** A column title written bottom-to-top, as in the sheet («Кол-во», «Площадь», «Обкат»). */
function vertical(cx: number, cy: number, value: string, size: number): string {
  return `<g transform="translate(${r(cx + size / 3)} ${r(cy)}) rotate(-90)">${text(0, 0, value, { size, bold: true, anchor: 'middle' })}</g>`;
}

function text(x: number, y: number, value: string,
  options: { size?: number; bold?: boolean; italic?: boolean; anchor?: Align; fill?: string } = {}): string {
  if (!value) return '';
  // No italic face is bundled: a slant keeps the sheet's italic labels recognisable.
  const slant = options.italic ? ` transform="skewX(-10)" ` : ' ';
  const xx = options.italic ? x + y * Math.tan((10 * Math.PI) / 180) : x;
  return `<text${slant}x="${r(xx)}" y="${r(y)}" font-family="${FAMILY}" font-size="${options.size ?? 11}" font-weight="${options.bold ? 'bold' : 'normal'}"`
    + ` fill="${options.fill ?? '#000000'}" text-anchor="${options.anchor ?? 'start'}">${escapeXml(value)}</text>`;
}

function r(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] as string);
}
