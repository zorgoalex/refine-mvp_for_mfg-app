import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OrderFormData, OrderFormDetail } from './order-form-data';

const REGULAR = 'Liberation Sans';
const BOLD = 'Liberation Sans Bold';
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { left: 17, right: 17, top: 36, bottom: 30 };
// Column widths follow the print form (orderProductionPdf.ts colgroup, % of the table width).
const COLUMN_PERCENTS = [3.06, 6.48, 6.36, 5.53, 4.36, 15.79, 4.36, 18.73, 6.83, 10.96, 18.54];
const HEADERS = ['№', 'Высота', 'Ширина', 'Кол-во', 'Площадь', 'Тип детали', 'Обкат', 'Примечание', 'Цена за кв.м.', 'Сумма', 'Пленка'];
const NUMERIC = new Set([0, 1, 2, 3, 4, 8, 9]);

function fontPath(file: string): string | null {
  const candidates = [
    resolve(__dirname, '../../../../../assets/fonts', file),
    join(process.cwd(), 'assets/fonts', file),
    join(process.cwd(), 'backend/assets/fonts', file),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

type Row = { kind: 'detail'; ordinal: number; detail: OrderFormDetail } | { kind: 'blank' };

/** Production layout groups details by film with a blank row between groups (as the print form). */
function rows(data: OrderFormData, financial: boolean): Row[] {
  const list = data.details;
  if (financial) return list.map((detail, index) => ({ kind: 'detail', ordinal: index + 1, detail }));
  const groups = new Map<string, OrderFormDetail[]>();
  for (const detail of list) {
    const key = detail.film?.trim() || '';
    groups.set(key, [...(groups.get(key) ?? []), detail]);
  }
  const ordered = [...[...groups.entries()].filter(([key]) => key !== ''), ...[...groups.entries()].filter(([key]) => key === '')];
  const result: Row[] = [];
  let ordinal = 0;
  ordered.forEach(([, group], index) => {
    if (index > 0) result.push({ kind: 'blank' });
    for (const detail of group) result.push({ kind: 'detail', ordinal: (ordinal += 1), detail });
  });
  return result;
}

function area(detail: OrderFormDetail): number | null {
  if (detail.height === null || detail.width === null) return null;
  return Math.round((detail.height / 1000) * (detail.width / 1000) * detail.quantity * 100) / 100;
}

/** As the order calculation: the stored detail cost wins, otherwise area × rate. */
function detailSum(detail: OrderFormDetail): number | null {
  if (detail.detailCost !== null) return Math.round(detail.detailCost * 100) / 100;
  const value = area(detail);
  if (detail.millingCostPerSqm === null || value === null) return null;
  return Math.round(value * detail.millingCostPerSqm * 100) / 100;
}

const money = (value: number | null) => value === null ? '' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
const decimal = (value: number | null) => value === null ? '' : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const date = (value: Date | null) => value ? `${String(value.getDate()).padStart(2, '0')}.${String(value.getMonth() + 1).padStart(2, '0')}.${value.getFullYear()}` : '';

function common(details: OrderFormDetail[], pick: (detail: OrderFormDetail) => string | null): string {
  const values = details.map(pick).filter((value): value is string => Boolean(value));
  return values.length && values.every((value) => value === values[0]) ? values[0] : '';
}

function note(detail: OrderFormDetail): string {
  const original = (detail.note ?? '').replace(/\r\n?/g, '\n').trim();
  if (!detail.doweling) return original;
  if (original.toLocaleLowerCase('ru-RU').includes('присадка')) return original;
  return original ? `Присадка\n${original}` : 'Присадка';
}

/**
 * Order form as PDF. `financial=false` — «для производства»: price, sum, totals, payments and the
 * balance are left empty (the data is already projected; this only shapes the layout).
 */
export function renderOrderPdf(data: OrderFormData, financial: boolean): Promise<Buffer> {
  return new Promise<Buffer>((resolvePdf, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: MARGIN.top, bottom: MARGIN.bottom, left: MARGIN.left, right: MARGIN.right },
      info: { Title: `Заказ ${data.orderName}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolvePdf(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const regular = fontPath('LiberationSans-Regular.ttf');
      const bold = fontPath('LiberationSans-Bold.ttf');
      if (!regular || !bold) throw new Error('Liberation Sans fonts are missing from backend assets');
      doc.registerFont(REGULAR, regular);
      doc.registerFont(BOLD, bold);
      draw(doc, data, financial);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function draw(doc: PDFKit.PDFDocument, data: OrderFormData, financial: boolean) {
  const tableWidth = PAGE.width - MARGIN.left - MARGIN.right;
  const widths = COLUMN_PERCENTS.map((percent) => (percent / 100) * tableWidth);
  const totalArea = data.details.reduce((sum, detail) => sum + (area(detail) ?? 0), 0);
  const totalQuantity = data.details.reduce((sum, detail) => sum + detail.quantity, 0);
  let y = MARGIN.top;

  // Header: order, client, financial summary, common parameters, date, phone, totals.
  const cell = (x: number, top: number, width: number, height: number, label: string, value: string, options: { bold?: boolean; size?: number; color?: string } = {}) => {
    doc.lineWidth(0.5).strokeColor('#444').rect(x, top, width, height).stroke();
    if (label) doc.font(REGULAR).fontSize(6).fillColor('#555').text(label, x + 2, top + 1.5, { width: width - 4, lineBreak: false, ellipsis: true });
    doc.font(options.bold === false ? REGULAR : BOLD).fontSize(options.size ?? 9).fillColor(options.color ?? '#111')
      .text(value, x + 2, top + (label ? 9 : 3), { width: width - 4, height: height - (label ? 10 : 4), ellipsis: true });
  };
  const year = String(data.orderDate.getFullYear()).slice(-2);
  doc.font(REGULAR).fontSize(8).fillColor('#111').text(year, MARGIN.left, y, { width: 24, align: 'right' });
  doc.font(BOLD).fontSize(14).text(data.orderName, MARGIN.left + 30, y - 2, { width: 150, lineBreak: false, ellipsis: true });
  const x0 = MARGIN.left + 185;
  cell(x0, y, 60, 26, '№ присадки', data.prisadkaName ?? '', { color: '#c00' });
  cell(x0 + 60, y, 170, 26, 'Заказчик', data.clientName ?? 'Не указан', { size: 10 });
  cell(x0 + 230, y, 75, 26, 'общая сумма', financial ? money(data.totalAmount) : '');
  cell(x0 + 305, y, 56.28, 26, 'скидка', financial ? money(data.discount) : '');
  y += 32;
  const commonWidth = (tableWidth - 140) / 4;
  cell(MARGIN.left, y, commonWidth, 30, 'фрезеровка', common(data.details, (detail) => detail.millingType));
  cell(MARGIN.left + commonWidth, y, commonWidth, 30, 'обкат', common(data.details, (detail) => detail.edgeType));
  cell(MARGIN.left + commonWidth * 2, y, commonWidth, 30, 'пленка', common(data.details, (detail) => detail.film));
  cell(MARGIN.left + commonWidth * 3, y, commonWidth, 30, 'материал',
    data.details.length ? common(data.details, (detail) => detail.material) : data.headerMaterial ?? '');
  const balance = financial && data.finalAmount !== null ? data.finalAmount - (data.paidAmount ?? 0) : null;
  cell(MARGIN.left + commonWidth * 4, y, 140, 15, 'остаток оплаты', financial ? money(balance) : '', { size: 8 });
  cell(MARGIN.left + commonWidth * 4, y + 15, 140, 15, 'срок выполнения', date(data.completionDate), { size: 8 });
  y += 34;
  const quarter = tableWidth / 6;
  cell(MARGIN.left, y, quarter, 22, 'Дата', date(data.orderDate));
  cell(MARGIN.left + quarter, y, quarter * 1.5, 22, '', data.prisadkaDesignerName ? `конструктор ${data.prisadkaDesignerName}` : '', { size: 8 });
  cell(MARGIN.left + quarter * 2.5, y, quarter * 1.5, 22, 'телефон', data.clientPhone ?? '', { size: 10 });
  cell(MARGIN.left + quarter * 4, y, quarter, 22, 'общая площадь', decimal(Math.round(totalArea * 100) / 100));
  cell(MARGIN.left + quarter * 5, y, quarter, 22, 'кол-во деталей', String(totalQuantity));
  y += 28;

  const drawHead = () => {
    let x = MARGIN.left;
    doc.font(BOLD).fontSize(6.5).fillColor('#111');
    HEADERS.forEach((title, index) => {
      doc.lineWidth(0.5).strokeColor('#555').rect(x, y, widths[index], 22).stroke();
      doc.text(title, x + 1.5, y + 4, { width: widths[index] - 3, align: 'center' });
      x += widths[index];
    });
    y += 22;
  };
  drawHead();
  for (const row of rows(data, financial)) {
    const values = row.kind === 'blank' ? HEADERS.map(() => '') : [
      String(row.ordinal),
      row.detail.height === null ? '' : String(row.detail.height),
      row.detail.width === null ? '' : String(row.detail.width),
      String(row.detail.quantity),
      decimal(area(row.detail)),
      row.detail.millingType ?? '',
      row.detail.edgeType ?? '',
      note(row.detail),
      financial ? money(row.detail.millingCostPerSqm) : '',
      financial ? money(detailSum(row.detail)) : '',
      row.detail.film ?? '',
    ];
    doc.font(REGULAR).fontSize(7.5);
    const height = Math.max(14, ...values.map((value, index) => doc.heightOfString(value, { width: widths[index] - 3 }) + 4));
    if (y + height > PAGE.height - MARGIN.bottom) {
      doc.addPage();
      y = MARGIN.top;
      drawHead();
      doc.font(REGULAR).fontSize(7.5);
    }
    let x = MARGIN.left;
    values.forEach((value, index) => {
      doc.lineWidth(0.5).strokeColor('#555').rect(x, y, widths[index], height).stroke();
      if (value) doc.fillColor('#111').text(value, x + 1.5, y + 2, { width: widths[index] - 3, align: NUMERIC.has(index) ? 'right' : 'left' });
      x += widths[index];
    });
    y += height;
  }
  if (financial && data.payments.length) {
    y += 10;
    if (y + 14 * (data.payments.length + 1) > PAGE.height - MARGIN.bottom) { doc.addPage(); y = MARGIN.top; }
    doc.font(BOLD).fontSize(8).fillColor('#111').text('Оплаты', MARGIN.left, y);
    y += 12;
    doc.font(REGULAR).fontSize(8);
    for (const payment of data.payments) {
      doc.text(`${date(payment.date)}  ${payment.type ?? ''}  ${money(payment.amount)}`, MARGIN.left, y, { width: tableWidth });
      y += 12;
    }
  }
}
