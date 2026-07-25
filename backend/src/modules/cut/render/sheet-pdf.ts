import PDFDocument from 'pdfkit';
import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode';
import SVGtoPDF from 'svg-to-pdfkit';
import {
  evaluateCustomFieldExpression,
  readCustomFieldExpressionV1,
  type LabelCustomExpressionScalar,
} from '../../labels/application/label-custom-field-expression';
import { FONT_FAMILY, resolveFontPath } from './sheet-png';

/**
 * Per-sheet vector PDF (plan §7): one page per sheet, drawn from the SAME
 * backend-rendered per-sheet SVG used for PNG. resvg does not emit PDF, so we
 * use PDFKit + svg-to-pdfkit. On-demand render; no persisted blobs (the DB
 * placements stay the source of truth). The bundled Cyrillic TTF is registered
 * with the document so labels (e.g. "№123-45") render — the PDF standard-14
 * fonts have no Cyrillic.
 */
const MM_TO_PT = 2.834645669; // 1 mm in PDF points (1/72 inch)

export interface PdfSheetInput {
  svg: string;
  bathSvg?: string;
  sheetWidthMm: number;
  sheetHeightMm: number;
  sheetNumber?: number;
  pageCount?: number;
  template?: string;
  templateLayout?: Record<string, unknown> | null;
  meta?: PdfSheetMeta;
  detailRows?: PdfSheetDetailRow[];
}

export interface PdfSheetMeta {
  orders?: readonly string[];
  clients?: readonly string[];
  dates?: readonly string[];
  readyDates?: readonly string[];
  materials?: readonly string[];
  thicknesses?: readonly string[];
  films?: readonly string[];
}

export interface PdfSheetDetailRow {
  order: string;
  position: number | string;
  lengthMm: number | null;
  widthMm: number | null;
  quantity: number;
  due?: string | null;
  material?: string | null;
  film?: string | null;
  client?: string | null;
  orderDate?: string | null;
  readyDate?: string | null;
  thickness?: number | null;
}

interface PdfTemplateLayoutV3 {
  version: number;
  page?: Record<string, unknown>;
  customFieldSchema?: Record<string, unknown>;
  elements?: unknown[];
}

interface PdfLayoutElement {
  id?: string;
  type: 'text' | 'field' | 'custom' | 'qr' | 'line' | 'rect' | 'sheet_thumbnail' | 'detail_table';
  label?: string;
  source?: string | null;
  text?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  zIndex?: number;
  align?: 'left' | 'center' | 'right';
  style?: Record<string, unknown>;
}

interface DetailTableColumn {
  field: string;
  label: string;
  width: number;
  visible: boolean;
}

export type FrozenPdfRenderContract = 'cut_sheet_render_v1';

/**
 * Historical dispatcher. Once a contract exists here its implementation is
 * append-only: a future PDF layout must add v2 and leave v1 untouched.
 */
export function buildFrozenSheetsPdf(
  contract: FrozenPdfRenderContract,
  sheets: readonly PdfSheetInput[],
): Promise<Buffer> {
  switch (contract) {
    case 'cut_sheet_render_v1':
      return buildSheetsPdfV1(sheets);
  }
}

export function buildSheetsPdf(sheets: readonly PdfSheetInput[]): Promise<Buffer> {
  return buildSheetsPdfV1(sheets, true);
}

function buildSheetsPdfV1(sheets: readonly PdfSheetInput[], useTemplateLayout = false): Promise<Buffer> {
  return new Promise<Buffer>((resolvePdf, reject) => {
    if (sheets.length === 0) {
      reject(new Error('Cannot render a cut PDF with no sheets'));
      return;
    }

    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolvePdf(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fontPath = resolveFontPath();
    if (fontPath) {
      doc.registerFont(FONT_FAMILY, fontPath);
      doc.font(FONT_FAMILY);
    }
    const fontCallback = fontPath ? () => FONT_FAMILY : undefined;

    try {
      for (const sheet of sheets) {
        if (useTemplateLayout && isTemplateLayoutV3(sheet.templateLayout)) {
          drawTemplateLayoutPage(doc, sheet, sheet.templateLayout, fontCallback);
        } else if (sheet.template === 'bath_profiles') {
          drawBathProfilePage(doc, sheet, fontCallback);
        } else {
          const sourceWidthPt = sheet.sheetWidthMm * MM_TO_PT;
          const sourceHeightPt = sheet.sheetHeightMm * MM_TO_PT;
          const rotateToLandscape = sourceHeightPt > sourceWidthPt;
          const pageWidthPt = rotateToLandscape ? sourceHeightPt : sourceWidthPt;
          const pageHeightPt = rotateToLandscape ? sourceWidthPt : sourceHeightPt;
          doc.addPage({ size: [pageWidthPt, pageHeightPt], margin: 0 });
          if (rotateToLandscape) {
            doc.save();
            doc.translate(pageWidthPt, 0);
            doc.rotate(90);
          }
          SVGtoPDF(doc, sheet.svg, 0, 0, {
            width: sourceWidthPt,
            height: sourceHeightPt,
            assumePt: false,
            ...(fontCallback ? { fontCallback } : {}),
          });
          if (rotateToLandscape) {
            doc.restore();
          }
        }
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function drawTemplateLayoutPage(
  doc: PDFKit.PDFDocument,
  sheet: PdfSheetInput,
  layout: PdfTemplateLayoutV3,
  fontCallback?: () => string,
): void {
  const page = isRecord(layout.page) ? layout.page : {};
  const pageW = mmToPt(readNumber(page.width, 297, 20, 2000));
  const pageH = mmToPt(readNumber(page.height, 210, 20, 2000));
  const customFieldSchema = isRecord(layout.customFieldSchema) ? layout.customFieldSchema : {};
  const values = resolveCustomFieldValues(customFieldSchema, buildSheetFieldValues(sheet));
  const elements = (layout.elements ?? [])
    .map((raw, index) => toLayoutElement(raw, index))
    .filter((element): element is PdfLayoutElement => element !== null)
    .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));

  doc.addPage({ size: [pageW, pageH], margin: 0 });
  doc.rect(0, 0, pageW, pageH).fillColor('#ffffff').fill();

  for (const element of elements) {
    drawTemplateElement(doc, sheet, element, values, fontCallback);
  }
}

function drawTemplateElement(
  doc: PDFKit.PDFDocument,
  sheet: PdfSheetInput,
  element: PdfLayoutElement,
  values: Record<string, LabelCustomExpressionScalar>,
  fontCallback?: () => string,
): void {
  const style = isRecord(element.style) ? element.style : {};
  withElementTransform(doc, element, (w, h) => {
    switch (element.type) {
      case 'line':
        drawTemplateLine(doc, w, h, style);
        return;
      case 'rect':
        drawTemplateRect(doc, w, h, style);
        return;
      case 'qr':
        drawTemplateQr(doc, element, w, h, style, values);
        return;
      case 'sheet_thumbnail':
        drawSheetThumbnail(doc, sheet, w, h, style, fontCallback);
        return;
      case 'detail_table':
        drawTemplateDetailsTable(doc, sheet.detailRows ?? [], w, h, style);
        return;
      case 'text':
      case 'field':
      case 'custom':
        drawTemplateText(doc, resolveElementText(element, values), w, h, element.align, style);
        return;
    }
  });
}

function withElementTransform(
  doc: PDFKit.PDFDocument,
  element: PdfLayoutElement,
  draw: (w: number, h: number) => void,
): void {
  const x = mmToPt(element.x);
  const y = mmToPt(element.y);
  const w = mmToPt(Math.max(element.w, 0));
  const h = mmToPt(Math.max(element.h, 0));
  doc.save();
  doc.translate(x + w / 2, y + h / 2);
  if (element.rotation) doc.rotate(element.rotation);
  doc.translate(-w / 2, -h / 2);
  draw(w, h);
  doc.restore();
}

function drawTemplateText(
  doc: PDFKit.PDFDocument,
  text: string,
  w: number,
  h: number,
  align: PdfLayoutElement['align'],
  style: Record<string, unknown>,
): void {
  if (w <= 0 || h <= 0) return;
  const fontSize = readNumber(style.fontSize, 10, 2, 96);
  const padding = mmToPt(readNumber(style.padding, 0, 0, 50));
  const textW = Math.max(1, w - padding * 2);
  const textH = Math.max(1, h - padding * 2);
  doc.save();
  doc.rect(0, 0, w, h).clip();
  doc
    .fontSize(fontSize)
    .fillColor(readColor(style.color, '#111111'))
    .text(text, padding, padding, {
      width: textW,
      height: textH,
      align: align ?? 'left',
      lineBreak: true,
      ellipsis: true,
    });
  doc.restore();
}

function drawTemplateLine(doc: PDFKit.PDFDocument, w: number, h: number, style: Record<string, unknown>): void {
  doc
    .save()
    .lineWidth(mmToPt(readNumber(style.strokeWidth, 0.35, 0.01, 20)))
    .strokeColor(readColor(style.color, '#111111'))
    .moveTo(0, 0)
    .lineTo(w, h)
    .stroke()
    .restore();
}

function drawTemplateRect(doc: PDFKit.PDFDocument, w: number, h: number, style: Record<string, unknown>): void {
  if (w <= 0 || h <= 0) return;
  const stroke = readColor(style.color, '#111111');
  const fill = readColor(style.fill, 'transparent');
  doc.save().lineWidth(mmToPt(readNumber(style.strokeWidth, 0.35, 0.01, 20)));
  if (fill === 'transparent') {
    doc.rect(0, 0, w, h).strokeColor(stroke).stroke();
  } else {
    doc.rect(0, 0, w, h).fillAndStroke(fill, stroke);
  }
  doc.restore();
}

function drawSheetThumbnail(
  doc: PDFKit.PDFDocument,
  sheet: PdfSheetInput,
  w: number,
  h: number,
  style: Record<string, unknown>,
  fontCallback?: () => string,
): void {
  if (w <= 0 || h <= 0) return;
  const sourceW = Math.max(1, sheet.sheetWidthMm * MM_TO_PT);
  const sourceH = Math.max(1, sheet.sheetHeightMm * MM_TO_PT);
  const fit = String(style.fit ?? 'contain');
  const scale = fit === 'cover'
    ? Math.max(w / sourceW, h / sourceH)
    : fit === 'stretch'
      ? 1
      : Math.min(w / sourceW, h / sourceH);
  const drawW = fit === 'stretch' ? w : sourceW * scale;
  const drawH = fit === 'stretch' ? h : sourceH * scale;
  const dx = (w - drawW) / 2;
  const dy = (h - drawH) / 2;
  doc.save();
  doc.rect(0, 0, w, h).clip();
  SVGtoPDF(doc, sheet.svg, dx, dy, {
    width: drawW,
    height: drawH,
    assumePt: false,
    ...(fontCallback ? { fontCallback } : {}),
  });
  doc.restore();
  doc.save()
    .lineWidth(mmToPt(readNumber(style.strokeWidth, 0.25, 0, 20)))
    .strokeColor(readColor(style.color, '#111111'))
    .rect(0, 0, w, h)
    .stroke()
    .restore();
}

function drawTemplateQr(
  doc: PDFKit.PDFDocument,
  element: PdfLayoutElement,
  w: number,
  h: number,
  style: Record<string, unknown>,
  values: Record<string, LabelCustomExpressionScalar>,
): void {
  const side = Math.max(1, Math.min(w, h));
  const x = (w - side) / 2;
  const y = (h - side) / 2;
  const payload = renderTemplateString(String(style.qrTemplate ?? element.text ?? element.source ?? ''), values);
  doc.save().rect(x, y, side, side).fillAndStroke('#ffffff', '#111111');
  if (payload) {
    const code = QRCode.create(payload, { errorCorrectionLevel: readQrErrorCorrection(style.qrErrorCorrection) });
    const moduleCount = code.modules.size;
    const quietZoneModules = 4;
    const moduleSide = side / (moduleCount + quietZoneModules * 2);
    doc.fillColor('#111111');
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount; col += 1) {
        if (code.modules.get(row, col) !== 1) continue;
        doc.rect(
          x + (col + quietZoneModules) * moduleSide,
          y + (row + quietZoneModules) * moduleSide,
          moduleSide,
          moduleSide,
        ).fill();
      }
    }
  }
  doc.restore();
}

function drawTemplateDetailsTable(
  doc: PDFKit.PDFDocument,
  rows: readonly PdfSheetDetailRow[],
  w: number,
  h: number,
  style: Record<string, unknown>,
): void {
  if (w <= 0 || h <= 0) return;
  const columns = readDetailTableColumns(style);
  if (columns.length === 0) return;
  const sort = readDetailTableSort(style);
  const sortedRows = sortDetailRows(rows, sort.field, sort.direction);
  const fontSize = readNumber(style.fontSize, 7, 3, 36);
  const headerFontSize = readNumber(style.headerFontSize, fontSize, 3, 36);
  const rowH = mmToPt(readNumber(style.rowHeight, 5.5, 2, 40));
  const headerH = mmToPt(readNumber(style.headerHeight, 6, 2, 40));
  const border = readColor(style.color, '#111111');
  const headerFill = readColor(style.headerFill, '#f2f2f2');
  const totalWidth = columns.reduce((sum, column) => sum + Math.max(column.width, 0.1), 0);
  const widths = columns.map((column) => (w * Math.max(column.width, 0.1)) / totalWidth);

  let cy = 0;
  drawDetailTableRow(doc, columns.map((column) => column.label), widths, cy, headerH, headerFontSize, border, headerFill);
  cy += headerH;
  for (const [index, row] of sortedRows.entries()) {
    if (cy + rowH > h) break;
    drawDetailTableRow(
      doc,
      columns.map((column) => detailRowValue(row, column.field, index)),
      widths,
      cy,
      rowH,
      fontSize,
      border,
      'transparent',
    );
    cy += rowH;
  }
}

function drawDetailTableRow(
  doc: PDFKit.PDFDocument,
  values: readonly string[],
  widths: readonly number[],
  y: number,
  h: number,
  fontSize: number,
  border: string,
  fill: string,
): void {
  let x = 0;
  for (let i = 0; i < widths.length; i += 1) {
    const w = widths[i];
    doc.save().lineWidth(0.5);
    if (fill === 'transparent') doc.rect(x, y, w, h).strokeColor(border).stroke();
    else doc.rect(x, y, w, h).fillAndStroke(fill, border);
    doc.rect(x, y, w, h).clip();
    doc.fontSize(fontSize).fillColor('#111111').text(values[i] ?? '', x + 1.8, y + 2, {
      width: Math.max(1, w - 3.6),
      height: Math.max(1, h - 3),
      align: 'center',
      lineBreak: true,
      ellipsis: true,
    });
    doc.restore();
    x += w;
  }
}

function drawBathProfilePage(doc: PDFKit.PDFDocument, sheet: PdfSheetInput, fontCallback?: () => string): void {
  const pageW = 842;
  const pageH = 595;
  const margin = 28;
  const headerH = 68;
  const footerH = 34;
  const tableW = 168;
  const gap = 14;
  const drawingX = margin;
  const drawingY = margin + headerH + 10;
  const drawingW = pageW - margin * 2 - tableW - gap;
  const drawingH = pageH - drawingY - footerH - margin;
  const tableX = drawingX + drawingW + gap;

  doc.addPage({ size: [pageW, pageH], margin: 0 });
  doc.fontSize(8).fillColor('#111111');

  drawHeader(doc, sheet.meta ?? {}, margin, margin, pageW - margin * 2);

  const scale = Math.min(drawingW / Math.max(sheet.sheetWidthMm, 1), drawingH / Math.max(sheet.sheetHeightMm, 1));
  const svgW = sheet.sheetWidthMm * scale;
  const svgH = sheet.sheetHeightMm * scale;
  SVGtoPDF(doc, sheet.bathSvg ?? sheet.svg, drawingX, drawingY, {
    width: svgW,
    height: svgH,
    assumePt: false,
    ...(fontCallback ? { fontCallback } : {}),
  });
  doc.rect(drawingX, drawingY, svgW, svgH).strokeColor('#111111').lineWidth(0.75).stroke();

  drawDetailsTable(doc, sheet.detailRows ?? [], tableX, drawingY, tableW, sheet.sheetNumber);
  drawFooter(doc, sheet, drawingX, pageH - margin - footerH + 4);
}

function drawHeader(doc: PDFKit.PDFDocument, meta: PdfSheetMeta, x: number, y: number, width: number): void {
  const colW = width / 3;
  const rowH = 22;
  const labelW = 82;
  const fontSize = 10.5;
  const cells = [
    { label: 'Заказ:', value: join(meta.orders), x, y, valueW: colW - labelW - 4 },
    { label: 'Клиент:', value: join(meta.clients), x: x + colW, y, valueW: colW - labelW - 4 },
    { label: 'Дата:', value: join(meta.dates), x: x + colW * 2, y, valueW: colW - labelW - 4 },
    { label: 'Дата готовности:', value: join(meta.readyDates), x, y: y + rowH, valueW: colW - labelW - 4 },
    { label: 'Материал:', value: join(meta.materials), x: x + colW, y: y + rowH, valueW: colW - labelW - 4 },
    { label: 'Толщина:', value: join(meta.thicknesses), x: x + colW * 2, y: y + rowH, valueW: colW - labelW - 4 },
    { label: 'Пленка:', value: join(meta.films), x, y: y + rowH * 2, valueW: width - labelW - 4 },
  ];
  doc.lineWidth(0.7).strokeColor('#111111');
  for (const cell of cells) {
    doc.fontSize(fontSize).text(cell.label, cell.x, cell.y, { width: labelW, lineBreak: false });
    doc.fontSize(fontSize).text(` ${cell.value}`, cell.x + labelW, cell.y, {
      width: cell.valueW,
      lineBreak: true,
    });
  }
  doc.moveTo(x, y + rowH - 3).lineTo(x + width, y + rowH - 3).stroke();
  doc.moveTo(x, y + rowH * 2 - 3).lineTo(x + width, y + rowH * 2 - 3).stroke();
}

function drawDetailsTable(
  doc: PDFKit.PDFDocument,
  rows: readonly PdfSheetDetailRow[],
  x: number,
  y: number,
  w: number,
  sheetNumber: number | undefined,
): void {
  const title = Number.isInteger(sheetNumber) ? `Лист ${sheetNumber}` : 'Лист';
  doc.fontSize(10).text(title, x, y - 25, { width: w, align: 'center' });
  doc.fontSize(9).text('Детали', x, y - 13, { width: w, align: 'center' });
  const col = [14, 40, 22, 32, 32, 28];
  const headers = ['#', 'Заказ', 'Поз.', 'Длина', 'Ширина', 'Кол-во'];
  let cy = y;
  drawTableRow(doc, headers, x, cy, col, true);
  cy += 16;
  const visibleRows = rows.slice(0, 27);
  for (const [index, row] of visibleRows.entries()) {
    drawTableRow(
      doc,
      [
        String(index + 1),
        row.order,
        String(row.position),
        formatMm(row.lengthMm),
        formatMm(row.widthMm),
        String(row.quantity),
      ],
      x,
      cy,
      col,
      false,
    );
    cy += 16;
  }
  drawTableTotalRow(doc, totalDetailQuantity(rows), x, cy, w);
}

function drawTableRow(doc: PDFKit.PDFDocument, values: readonly string[], x: number, y: number, widths: readonly number[], header: boolean): void {
  let cx = x;
  const h = 16;
  const baseFont = header ? 6 : 7;
  doc.lineWidth(0.5).strokeColor('#111111').fontSize(baseFont);
  for (let i = 0; i < widths.length; i += 1) {
    doc.rect(cx, y, widths[i], h).stroke();
    const value = values[i] ?? '';
    doc.fontSize(fitTableCellFont(value, widths[i] - 4, baseFont));
    doc.text(value, cx + 2, y + 4, { width: widths[i] - 4, align: 'center', lineBreak: false });
    cx += widths[i];
  }
}

function drawTableTotalRow(doc: PDFKit.PDFDocument, total: number, x: number, y: number, w: number): void {
  doc.lineWidth(0.5).strokeColor('#111111').fontSize(7);
  doc.rect(x, y, w, 16).stroke();
  doc.text(`Итого: ${total}`, x + 4, y + 4, { width: w - 8, align: 'right', lineBreak: false });
}

function fitTableCellFont(value: string, widthPt: number, baseFontPt: number): number {
  const estimated = estimatePdfTextWidthPt(value, baseFontPt);
  if (estimated <= widthPt) return baseFontPt;
  return Math.max(4.5, baseFontPt * (widthPt / Math.max(estimated, 1)));
}

function drawFooter(doc: PDFKit.PDFDocument, sheet: PdfSheetInput, x: number, y: number): void {
  const count = (sheet.detailRows ?? []).reduce((sum, row) => sum + row.quantity, 0);
  const area = (sheet.detailRows ?? []).reduce((sum, row) => {
    if (row.lengthMm === null || row.widthMm === null) return sum;
    return sum + row.lengthMm * row.widthMm * row.quantity;
  }, 0) / 1_000_000;
  const sheetArea = (sheet.sheetWidthMm * sheet.sheetHeightMm) / 1_000_000;
  const fill = sheetArea > 0 ? (area / sheetArea) * 100 : 0;
  doc.moveTo(x, y - 6).lineTo(x + 610, y - 6).stroke();
  doc.fontSize(9).text(`${formatMm(sheet.sheetWidthMm)} X ${formatMm(sheet.sheetHeightMm)}  -  1  |  Кол-во - 1`, x + 20, y);
  doc.text(`Количество деталей: ${count}  |  Площадь деталей: ${area.toFixed(3)} м.кв.  |  ${fill.toFixed(2)} %`, x + 20, y + 14);
}

function isTemplateLayoutV3(layout: unknown): layout is PdfTemplateLayoutV3 {
  return isRecord(layout) && Number(layout.version ?? 0) >= 3 && Array.isArray(layout.elements);
}

function toLayoutElement(raw: unknown, index: number): PdfLayoutElement | null {
  if (!isRecord(raw) || !isPdfElementType(raw.type)) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : `${raw.type}-${index}`,
    type: raw.type,
    label: typeof raw.label === 'string' ? raw.label : undefined,
    source: typeof raw.source === 'string' ? raw.source : null,
    text: typeof raw.text === 'string' ? raw.text : null,
    x: Number(raw.x ?? 0),
    y: Number(raw.y ?? 0),
    w: Number(raw.w ?? 0),
    h: Number(raw.h ?? 0),
    rotation: Number(raw.rotation ?? 0),
    zIndex: Number(raw.zIndex ?? index),
    align: raw.align === 'right' || raw.align === 'center' ? raw.align : 'left',
    style: isRecord(raw.style) ? raw.style : {},
  };
}

function isPdfElementType(value: unknown): value is PdfLayoutElement['type'] {
  return value === 'text'
    || value === 'field'
    || value === 'custom'
    || value === 'qr'
    || value === 'line'
    || value === 'rect'
    || value === 'sheet_thumbnail'
    || value === 'detail_table';
}

function buildSheetFieldValues(sheet: PdfSheetInput): Record<string, LabelCustomExpressionScalar> {
  const rows = sheet.detailRows ?? [];
  const meta = sheet.meta ?? {};
  const totalQuantity = totalDetailQuantity(rows);
  const detailsArea = rows.reduce((sum, row) => {
    if (row.lengthMm === null || row.widthMm === null) return sum;
    return sum + row.lengthMm * row.widthMm * row.quantity;
  }, 0) / 1_000_000;
  return {
    'job.name': '',
    'job.number': '',
    'job.pdf_template': sheet.template ?? '',
    'group.number': '',
    'group.material': joinBlank(meta.materials),
    'group.film': joinBlank(meta.films),
    'sheet.number': sheet.sheetNumber ?? null,
    'sheet.page_count': sheet.pageCount ?? null,
    'sheet.size': `${formatMm(sheet.sheetWidthMm)}x${formatMm(sheet.sheetHeightMm)}`,
    'sheet.details_count': totalQuantity,
    'sheet.area': detailsArea > 0 ? Number(detailsArea.toFixed(3)) : null,
    'sheet.thumbnail': '',
    'detail.table': '',
    'order.unique_names': joinBlank(meta.orders),
    'order.date': joinBlank(meta.dates),
    'order.ready_date': joinBlank(meta.readyDates),
    'client.unique_names': joinBlank(meta.clients),
    'detail.materials': joinBlank(meta.materials),
    'detail.films': joinBlank(meta.films),
    'detail.thicknesses': joinBlank(meta.thicknesses),
    'computed.today': new Date().toISOString().slice(0, 10),
    'computed.page_number': sheet.sheetNumber ?? null,
    'computed.page_count': sheet.pageCount ?? null,
  };
}

function resolveCustomFieldValues(
  customFieldSchema: Record<string, unknown>,
  baseValues: Record<string, LabelCustomExpressionScalar>,
): Record<string, LabelCustomExpressionScalar> {
  const values: Record<string, LabelCustomExpressionScalar> = { ...baseValues };
  const resolving = new Set<string>();
  const resolved = new Set<string>();
  const schemaKeys = new Set(Object.keys(customFieldSchema));

  const resolveCustom = (rawFieldId: string): LabelCustomExpressionScalar => {
    const fieldId = rawFieldId.replace(/^custom\./, '');
    if (resolved.has(fieldId)) return scalar(values[`custom.${fieldId}`] ?? values[fieldId]);
    if (resolving.has(fieldId)) return '';
    const schema = customFieldSchema[fieldId] ?? customFieldSchema[`custom.${fieldId}`];
    if (!isRecord(schema)) return '';
    resolving.add(fieldId);
    let value: LabelCustomExpressionScalar = '';
    const expression = readCustomFieldExpressionV1(schema);
    if (expression) {
      value = evaluateCustomFieldExpression(expression, (dependency) => {
        const dep = dependency.replace(/^custom\./, '');
        if (schemaKeys.has(dependency) || schemaKeys.has(dep)) return resolveCustom(dep);
        return scalar(values[dependency] ?? values[dep] ?? values[`custom.${dep}`]);
      });
    } else if (typeof schema.sourceField === 'string') {
      value = scalar(values[schema.sourceField] ?? values[schema.sourceField.replace(/^custom\./, '')]);
    } else if (Object.prototype.hasOwnProperty.call(schema, 'defaultValue')) {
      value = scalar(schema.defaultValue);
    } else if (Object.prototype.hasOwnProperty.call(schema, 'value')) {
      value = scalar(schema.value);
    }
    values[fieldId] = value;
    values[`custom.${fieldId}`] = value;
    resolved.add(fieldId);
    resolving.delete(fieldId);
    return value;
  };

  for (const fieldId of schemaKeys) resolveCustom(fieldId);
  return values;
}

function resolveElementText(element: PdfLayoutElement, values: Record<string, LabelCustomExpressionScalar>): string {
  if (element.type === 'text') return element.text ?? '';
  if (!element.source) return '';
  return stringify(values[element.source] ?? values[element.source.replace(/^custom\./, '')]);
}

function renderTemplateString(template: string, values: Record<string, LabelCustomExpressionScalar>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, rawField: string) => {
    const field = rawField.trim();
    return stringify(values[field] ?? values[field.replace(/^custom\./, '')]);
  });
}

function readDetailTableColumns(style: Record<string, unknown>): DetailTableColumn[] {
  const table = isRecord(style.table) ? style.table : {};
  const rawColumns = Array.isArray(table.columns)
    ? table.columns
    : Array.isArray(style.columns)
      ? style.columns
      : DEFAULT_DETAIL_TABLE_COLUMNS;
  return rawColumns
    .map((raw): DetailTableColumn | null => {
      if (!isRecord(raw)) return null;
      const field = typeof raw.field === 'string' ? raw.field : '';
      if (!field) return null;
      return {
        field,
        label: String(raw.label ?? defaultDetailColumnLabel(field)),
        width: readNumber(raw.width, 1, 0.1, 100),
        visible: raw.visible !== false,
      };
    })
    .filter((column): column is DetailTableColumn => column !== null && column.visible);
}

function readDetailTableSort(style: Record<string, unknown>): { field: string; direction: 'asc' | 'desc' } {
  const table = isRecord(style.table) ? style.table : {};
  const raw = isRecord(table.sort) ? table.sort : isRecord(style.sort) ? style.sort : {};
  const direction = raw.direction === 'desc' ? 'desc' : 'asc';
  return { field: typeof raw.field === 'string' ? raw.field : 'detail.order', direction };
}

function sortDetailRows(
  rows: readonly PdfSheetDetailRow[],
  field: string,
  direction: 'asc' | 'desc',
): PdfSheetDetailRow[] {
  const normalized = normalizeDetailField(field);
  const factor = direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => factor * compareDetailValues(detailSortValue(a, normalized), detailSortValue(b, normalized)));
}

function detailRowValue(row: PdfSheetDetailRow, field: string, index: number): string {
  switch (normalizeDetailField(field)) {
    case 'row_number':
      return String(index + 1);
    case 'order':
      return row.order;
    case 'position':
      return String(row.position ?? '');
    case 'lengthMm':
      return formatMm(row.lengthMm);
    case 'widthMm':
      return formatMm(row.widthMm);
    case 'quantity':
      return String(row.quantity);
    case 'material':
      return row.material ?? '';
    case 'film':
      return row.film ?? '';
    case 'client':
      return row.client ?? '';
    case 'orderDate':
      return row.orderDate ?? '';
    case 'readyDate':
      return row.readyDate ?? row.due ?? '';
    case 'thickness':
      return formatMm(row.thickness);
    default:
      return '';
  }
}

function detailSortValue(row: PdfSheetDetailRow, field: string): string | number | null {
  switch (field) {
    case 'order':
      return row.order;
    case 'position':
      return Number(row.position) || String(row.position ?? '');
    case 'lengthMm':
      return row.lengthMm;
    case 'widthMm':
      return row.widthMm;
    case 'quantity':
      return row.quantity;
    case 'material':
      return row.material ?? '';
    case 'film':
      return row.film ?? '';
    case 'client':
      return row.client ?? '';
    case 'orderDate':
      return row.orderDate ?? '';
    case 'readyDate':
      return row.readyDate ?? row.due ?? '';
    case 'thickness':
      return row.thickness ?? null;
    default:
      return '';
  }
}

function compareDetailValues(left: string | number | null, right: string | number | null): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return stringify(left).localeCompare(stringify(right), 'ru', { numeric: true, sensitivity: 'base' });
}

function normalizeDetailField(field: string): string {
  const raw = field.replace(/^detail\./, '');
  if (raw === 'rowNumber' || raw === 'rowNo' || raw === 'number') return 'row_number';
  if (raw === 'length' || raw === 'length_mm') return 'lengthMm';
  if (raw === 'width' || raw === 'width_mm') return 'widthMm';
  if (raw === 'order_date') return 'orderDate';
  if (raw === 'ready_date') return 'readyDate';
  return raw;
}

function defaultDetailColumnLabel(field: string): string {
  return DEFAULT_DETAIL_TABLE_COLUMNS.find((column) => column.field === field)?.label ?? field;
}

function readQrErrorCorrection(value: unknown): QRCodeErrorCorrectionLevel {
  return value === 'L' || value === 'Q' || value === 'H' ? value : 'M';
}

function readNumber(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  if (value === 'transparent' || /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value)) return value;
  return fallback;
}

function scalar(value: unknown): LabelCustomExpressionScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return String(value);
}

function mmToPt(value: number): number {
  return value * MM_TO_PT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DEFAULT_DETAIL_TABLE_COLUMNS: DetailTableColumn[] = [
  { field: 'detail.row_number', label: '#', width: 0.55, visible: true },
  { field: 'detail.order', label: 'Заказ', width: 1.6, visible: true },
  { field: 'detail.position', label: 'Поз.', width: 0.9, visible: true },
  { field: 'detail.lengthMm', label: 'Длина', width: 1.1, visible: true },
  { field: 'detail.widthMm', label: 'Ширина', width: 1.1, visible: true },
  { field: 'detail.quantity', label: 'Кол-во', width: 0.9, visible: true },
];

function joinBlank(values: readonly string[] | undefined): string {
  const uniq = Array.from(new Set((values ?? []).map((v) => v.trim()).filter(Boolean)));
  return uniq.join(', ');
}

function join(values: readonly string[] | undefined): string {
  const uniq = Array.from(new Set((values ?? []).map((v) => v.trim()).filter(Boolean)));
  return uniq.length > 0 ? uniq.join(', ') : '-';
}

function formatMm(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

function totalDetailQuantity(rows: readonly PdfSheetDetailRow[]): number {
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

function estimatePdfTextWidthPt(value: string, fontPt: number): number {
  let units = 0;
  for (const char of value) {
    if (char === ' ') units += 0.28;
    else if (/[0-9]/.test(char)) units += 0.52;
    else if (/[A-Za-zА-Яа-яЁё]/.test(char)) units += 0.58;
    else units += 0.4;
  }
  return units * fontPt;
}
