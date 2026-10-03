import { renderAsync } from '@resvg/resvg-js';
import type { OrderFormData } from './order-form-data';
import { COLUMN_PERCENTS, HEADERS, NUMERIC, area, common, date, decimal, detailSum, fontPath, money, note, rows, type Row } from './form-layout';

const FAMILY = 'Liberation Sans';
const WIDTH = 1400;
const PAD = 28;
const TABLE_WIDTH = WIDTH - PAD * 2;
const FONT = 17;
const LINE = 21;
const ROW_PAD = 7;
const HEAD_ROW = 46;
/** Details per picture: a longer order is split into several pictures of the same height. */
export const IMAGE_DETAILS_PER_PAGE = 55;
export const IMAGE_MAX_PAGES = 20;
/** Columns of «для производства»: no price and sum (indexes 8 and 9 of the print form). */
const PRODUCTION_COLUMNS = [0, 1, 2, 3, 4, 5, 6, 7, 10];
const FINANCIAL_COLUMNS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export class OrderImageTooLongError extends Error {}

/**
 * Order form as PNG pictures (WhatsApp images). The same rows and numbers as the PDF/print form;
 * `financial=false` — «для производства»: no price, sum, totals or payments (the data is already
 * projected). Up to 55 details per picture; full pictures share one height, the last one is cut to
 * its content; «стр. k/N» on each when there are several.
 */
export async function renderOrderImages(data: OrderFormData, financial: boolean): Promise<Buffer[]> {
  const regular = fontPath('LiberationSans-Regular.ttf');
  const bold = fontPath('LiberationSans-Bold.ttf');
  if (!regular || !bold) throw new Error('Liberation Sans fonts are missing from backend assets');
  const pages = paginate(rows(data, financial));
  if (pages.length > IMAGE_MAX_PAGES) throw new OrderImageTooLongError(`${pages.length} pages`);
  const drawn = pages.map((pageRows, index) => drawPage(data, financial, pageRows, index, pages.length));
  // Full pages share one height (WhatsApp shows pictures of a different shape at a different width);
  // the last page is cut to its content.
  const fullHeight = Math.max(...drawn.slice(0, -1).map((page) => page.height), 0);
  // Pages one after another off the event loop (resvg's thread pool), never all at once.
  const result: Buffer[] = [];
  for (const [index, page] of drawn.entries()) {
    const height = index === drawn.length - 1 ? page.height : fullHeight;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`
      + `<rect width="${WIDTH}" height="${height}" fill="#ffffff"/>${page.body}`
      + (pages.length > 1 ? text(WIDTH - PAD, height - 14, `стр. ${page.number}/${pages.length}`, { size: 15, anchor: 'end', fill: '#555' }) : '')
      + '</svg>';
    const image = await renderAsync(svg, { font: { fontFiles: [regular, bold], defaultFontFamily: FAMILY, loadSystemFonts: false } });
    result.push(Buffer.from(image.asPng()));
  }
  return result;
}

/** The SVG bodies of every page, for tests (what the pictures say, without rasterizing). */
export function drawSvgForTest(data: OrderFormData, financial: boolean): string {
  const pages = paginate(rows(data, financial));
  return pages.map((pageRows, index) => drawPage(data, financial, pageRows, index, pages.length).body).join('\n');
}

/** Splits the rows into pages of at most 55 details; a blank group separator never starts a page. */
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

function drawPage(data: OrderFormData, financial: boolean, pageRows: Row[], index: number, total: number) {
  const columns = financial ? FINANCIAL_COLUMNS : PRODUCTION_COLUMNS;
  const percent = columns.reduce((sum, column) => sum + COLUMN_PERCENTS[column], 0);
  const widths = columns.map((column) => (COLUMN_PERCENTS[column] / percent) * TABLE_WIDTH);
  let y = PAD;
  let body = '';
  if (index === 0) {
    const head = header(data, financial, y);
    body += head.body;
    y = head.y;
  } else {
    body += text(PAD, y + 24, `Заказ ${data.orderName}`, { size: 24, bold: true });
    if (data.clientName) body += text(PAD + 16 + width(`Заказ ${data.orderName}`, 24), y + 24, data.clientName, { size: 18, fill: '#333' });
    y += 42;
  }
  // Table head.
  let x = PAD;
  columns.forEach((column, position) => {
    body += box(x, y, widths[position], HEAD_ROW, '#eef1f5');
    body += centered(x, y, widths[position], HEAD_ROW, HEADERS[column], 14);
    x += widths[position];
  });
  y += HEAD_ROW;
  for (const row of pageRows) {
    const values = columns.map((column) => cellValue(row, column, financial));
    // Numbers are never cut: a long one gets a smaller font instead («1000» in the narrow «№»).
    const sizes = values.map((value, position) => (NUMERIC.has(columns[position]) ? fittingSize(value, widths[position] - 10, FONT) : FONT));
    const lines = values.map((value, position) => (NUMERIC.has(columns[position])
      ? [value]
      : wrap(value, widths[position] - 10, FONT, columns[position] === 7 || columns[position] === 5 ? 2 : 1)));
    const height = Math.max(...lines.map((cell) => cell.length), 1) * LINE + ROW_PAD * 2;
    x = PAD;
    lines.forEach((cell, position) => {
      body += box(x, y, widths[position], height);
      const numeric = NUMERIC.has(columns[position]);
      cell.forEach((line, lineIndex) => {
        const baseline = y + ROW_PAD + LINE * (lineIndex + 1) - 5;
        body += numeric
          ? text(x + widths[position] - 5, baseline, line, { anchor: 'end', size: sizes[position] })
          : text(x + 5, baseline, line);
      });
      x += widths[position];
    });
    y += height;
  }
  if (index === total - 1) {
    const footer = totals(data, financial, y + 16);
    body += footer.body;
    y = footer.y;
  }
  return { body, height: Math.ceil(y + PAD + (total > 1 ? 22 : 0)), number: index + 1 };
}

function header(data: OrderFormData, financial: boolean, top: number): { body: string; y: number } {
  let body = '';
  let y = top;
  body += text(PAD, y + 30, String(data.orderDate.getFullYear()).slice(-2), { size: 18, fill: '#555' });
  body += text(PAD + 34, y + 32, data.orderName, { size: 32, bold: true });
  const x0 = PAD + 320;
  const cellsA: Array<[number, string, string, { color?: string }?]> = [
    [150, '№ присадки', data.prisadkaName ?? '', { color: '#c00000' }],
    [460, 'Заказчик', data.clientName ?? 'Не указан'],
    [220, 'общая сумма', financial ? money(data.totalAmount) : ''],
    [194, 'скидка', financial ? money(data.discount) : ''],
  ];
  let x = x0;
  for (const [cellWidth, label, value, options] of cellsA) {
    body += labelled(x, y, cellWidth, 60, label, value, options?.color);
    x += cellWidth;
  }
  y += 70;
  const common4 = (TABLE_WIDTH - 330) / 4;
  const material = data.details.length ? common(data.details, (detail) => detail.material) : data.headerMaterial ?? '';
  const cellsB: Array<[string, string]> = [
    ['фрезеровка', common(data.details, (detail) => detail.millingType)],
    ['обкат', common(data.details, (detail) => detail.edgeType)],
    ['пленка', common(data.details, (detail) => detail.film)],
    ['материал', material],
  ];
  x = PAD;
  for (const [label, value] of cellsB) {
    body += labelled(x, y, common4, 60, label, value);
    x += common4;
  }
  const balance = financial && data.finalAmount !== null ? data.finalAmount - (data.paidAmount ?? 0) : null;
  body += labelled(x, y, 330, 30, 'остаток оплаты', financial ? money(balance) : '', undefined, 15);
  body += labelled(x, y + 30, 330, 30, 'срок выполнения', date(data.completionDate), undefined, 15);
  y += 70;
  const sixth = TABLE_WIDTH / 6;
  const totalArea = data.details.reduce((sum, detail) => sum + (area(detail) ?? 0), 0);
  const quantity = data.details.reduce((sum, detail) => sum + detail.quantity, 0);
  const cellsC: Array<[number, string, string]> = [
    [sixth, 'Дата', date(data.orderDate)],
    [sixth * 1.5, '', data.prisadkaDesignerName ? `конструктор ${data.prisadkaDesignerName}` : ''],
    // The client's phone only on «Изображение заказа»: the production picture goes to workshop chats.
    [sixth * 1.5, financial ? 'телефон' : '', financial ? data.clientPhone ?? '' : ''],
    [sixth, 'общая площадь', decimal(Math.round(totalArea * 100) / 100)],
    [sixth, 'кол-во деталей', String(quantity)],
  ];
  x = PAD;
  for (const [cellWidth, label, value] of cellsC) {
    body += labelled(x, y, cellWidth, 56, label, value);
    x += cellWidth;
  }
  return { body, y: y + 68 };
}

function totals(data: OrderFormData, financial: boolean, top: number): { body: string; y: number } {
  let y = top;
  let body = '';
  const totalArea = data.details.reduce((sum, detail) => sum + (area(detail) ?? 0), 0);
  const quantity = data.details.reduce((sum, detail) => sum + detail.quantity, 0);
  const parts = [`Итого: ${decimal(Math.round(totalArea * 100) / 100)} м²`, `деталей ${quantity}`];
  if (financial) {
    if (data.totalAmount !== null) parts.push(`сумма ${money(data.totalAmount)}`);
    if (data.discount) parts.push(`скидка ${money(data.discount)}`);
    if (data.finalAmount !== null) parts.push(`к оплате ${money(data.finalAmount)}`);
    if (data.paidAmount !== null) parts.push(`оплачено ${money(data.paidAmount)}`);
    if (data.finalAmount !== null) parts.push(`остаток ${money(data.finalAmount - (data.paidAmount ?? 0))}`);
  }
  body += text(PAD, y + 22, parts.join(' · '), { size: 19, bold: true });
  y += 34;
  if (financial && data.payments.length) {
    body += text(PAD, y + 20, 'Оплаты', { size: 17, bold: true });
    y += 28;
    for (const payment of data.payments) {
      body += text(PAD, y + 18, `${date(payment.date)}  ${payment.type ?? ''}  ${money(payment.amount)}`, { size: 16 });
      y += 24;
    }
  }
  return { body, y };
}

function cellValue(row: Row, column: number, financial: boolean): string {
  if (row.kind === 'blank') return '';
  const detail = row.detail;
  switch (column) {
    case 0: return String(row.ordinal);
    case 1: return detail.height === null ? '' : String(detail.height);
    case 2: return detail.width === null ? '' : String(detail.width);
    case 3: return String(detail.quantity);
    case 4: return decimal(area(detail));
    case 5: return detail.millingType ?? '';
    case 6: return detail.edgeType ?? '';
    case 7: return note(detail).replace(/\n+/g, ' · ');
    case 8: return financial ? money(detail.millingCostPerSqm) : '';
    case 9: return financial ? money(detailSum(detail)) : '';
    case 10: return detail.film ?? '';
    default: return '';
  }
}

/** Approximate advance of Liberation Sans (no text measuring in SVG): wide enough for Cyrillic. */
function width(value: string, size: number): number {
  let units = 0;
  for (const char of value) units += /[0-9.,\s]/.test(char) ? 0.5 : /[A-ZА-ЯЁШЩЖМЮ]/.test(char) ? 0.72 : 0.56;
  return units * size;
}

/** The largest font (down to 9) at which the whole value fits. */
export function fittingSize(value: string, maxWidth: number, size: number): number {
  let current = size;
  while (current > 9 && width(value, current) > maxWidth) current -= 1;
  return current;
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

function box(x: number, y: number, boxWidth: number, height: number, fill = '#ffffff'): string {
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(boxWidth)}" height="${r(height)}" fill="${fill}" stroke="#555555" stroke-width="1"/>`;
}

function labelled(x: number, y: number, boxWidth: number, height: number, label: string, value: string, color?: string, size = 20): string {
  let svg = box(x, y, boxWidth, height);
  if (label && height < 44) {
    // A low cell: the label on the left, the value on the right of one line.
    const baseline = y + height / 2 + size / 3;
    svg += text(x + 6, baseline, label, { size: 13, fill: '#555' });
    const room = boxWidth - 18 - width(label, 13);
    return svg + text(x + boxWidth - 6, baseline, wrap(value, room, size, 1)[0], { size, bold: true, anchor: 'end', fill: color ?? '#111' });
  }
  if (label) svg += text(x + 6, y + 16, label, { size: 13, fill: '#555' });
  const line = wrap(value, boxWidth - 12, size, 1)[0];
  svg += text(x + 6, y + height - (label ? 10 : (height - size) / 2), line, { size, bold: true, fill: color ?? '#111' });
  return svg;
}

function centered(x: number, y: number, boxWidth: number, height: number, value: string, size: number): string {
  // A narrow column header gets a smaller font before it is cut («Площадь»).
  while (size > 10 && value.split(/\s+/).some((word) => width(word, size) > boxWidth - 6)) size -= 1;
  const lines = wrap(value, boxWidth - 6, size, 2);
  const first = y + height / 2 - ((lines.length - 1) * (size + 2)) / 2 + size / 3;
  return lines.map((line, index) => text(x + boxWidth / 2, first + index * (size + 2), line, { size, bold: true, anchor: 'middle' })).join('');
}

function text(x: number, y: number, value: string, options: { size?: number; bold?: boolean; anchor?: 'start' | 'middle' | 'end'; fill?: string } = {}): string {
  if (!value) return '';
  return `<text x="${r(x)}" y="${r(y)}" font-family="${FAMILY}" font-size="${options.size ?? FONT}" font-weight="${options.bold ? 'bold' : 'normal'}"`
    + ` fill="${options.fill ?? '#111111'}" text-anchor="${options.anchor ?? 'start'}">${escapeXml(value)}</text>`;
}

function r(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] as string);
}
