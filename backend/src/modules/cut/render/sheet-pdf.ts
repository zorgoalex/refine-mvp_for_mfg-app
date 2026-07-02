import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
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
  sheetWidthMm: number;
  sheetHeightMm: number;
  template?: string;
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
  position: number | string;
  lengthMm: number | null;
  widthMm: number | null;
  quantity: number;
  due?: string | null;
}

export function buildSheetsPdf(sheets: readonly PdfSheetInput[]): Promise<Buffer> {
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
    }
    const fontCallback = fontPath ? () => FONT_FAMILY : undefined;

    try {
      for (const sheet of sheets) {
        if (sheet.template === 'bath_profiles') {
          drawBathProfilePage(doc, sheet, fontCallback);
        } else {
          const widthPt = sheet.sheetWidthMm * MM_TO_PT;
          const heightPt = sheet.sheetHeightMm * MM_TO_PT;
          doc.addPage({ size: [widthPt, heightPt], margin: 0 });
          SVGtoPDF(doc, sheet.svg, 0, 0, {
            width: widthPt,
            height: heightPt,
            assumePt: false,
            ...(fontCallback ? { fontCallback } : {}),
          });
        }
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function drawBathProfilePage(doc: PDFKit.PDFDocument, sheet: PdfSheetInput, fontCallback?: () => string): void {
  const pageW = 842;
  const pageH = 595;
  const margin = 28;
  const headerH = 42;
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
  SVGtoPDF(doc, sheet.svg, drawingX, drawingY, {
    width: svgW,
    height: svgH,
    assumePt: false,
    ...(fontCallback ? { fontCallback } : {}),
  });
  doc.rect(drawingX, drawingY, svgW, svgH).strokeColor('#111111').lineWidth(0.75).stroke();

  drawDetailsTable(doc, sheet.detailRows ?? [], tableX, drawingY, tableW);
  drawFooter(doc, sheet, drawingX, pageH - margin - footerH + 4);
}

function drawHeader(doc: PDFKit.PDFDocument, meta: PdfSheetMeta, x: number, y: number, width: number): void {
  const colW = width / 3;
  const rowH = 17;
  const cells = [
    { label: 'Заказ:', value: join(meta.orders), x, y },
    { label: 'Клиент:', value: join(meta.clients), x: x + colW, y },
    { label: 'Дата:', value: join(meta.dates), x: x + colW * 2, y },
    { label: 'Дата готовности:', value: join(meta.readyDates), x, y: y + rowH },
    { label: 'Материал:', value: join(meta.materials), x: x + colW, y: y + rowH },
    { label: 'Толщина:', value: join(meta.thicknesses), x: x + colW * 2, y: y + rowH },
    { label: 'Пленка:', value: join(meta.films), x, y: y + rowH * 2 },
  ];
  doc.lineWidth(0.7).strokeColor('#111111');
  for (const cell of cells) {
    doc.fontSize(7).text(cell.label, cell.x, cell.y, { width: 58, continued: true });
    doc.fontSize(7).text(` ${cell.value}`, { width: colW - 58 });
  }
  doc.moveTo(x, y + rowH - 3).lineTo(x + width, y + rowH - 3).stroke();
  doc.moveTo(x, y + rowH * 2 - 3).lineTo(x + width, y + rowH * 2 - 3).stroke();
}

function drawDetailsTable(doc: PDFKit.PDFDocument, rows: readonly PdfSheetDetailRow[], x: number, y: number, w: number): void {
  doc.fontSize(10).text('Детали', x, y - 13, { width: w, align: 'center' });
  const col = [20, 42, 42, 38, 26];
  const headers = ['#', 'Длина', 'Ширина', 'Кол-во', 'до'];
  let cy = y;
  drawTableRow(doc, headers, x, cy, col, true);
  cy += 16;
  for (const row of rows.slice(0, 28)) {
    drawTableRow(
      doc,
      [
        String(row.position),
        formatMm(row.lengthMm),
        formatMm(row.widthMm),
        String(row.quantity),
        row.due ?? '',
      ],
      x,
      cy,
      col,
      false,
    );
    cy += 16;
  }
}

function drawTableRow(doc: PDFKit.PDFDocument, values: readonly string[], x: number, y: number, widths: readonly number[], header: boolean): void {
  let cx = x;
  const h = 16;
  doc.lineWidth(0.5).strokeColor('#111111').fontSize(header ? 6 : 7);
  for (let i = 0; i < widths.length; i += 1) {
    doc.rect(cx, y, widths[i], h).stroke();
    doc.text(values[i] ?? '', cx + 2, y + 4, { width: widths[i] - 4, align: 'center' });
    cx += widths[i];
  }
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

function join(values: readonly string[] | undefined): string {
  const uniq = Array.from(new Set((values ?? []).map((v) => v.trim()).filter(Boolean)));
  return uniq.length > 0 ? uniq.join(', ') : '-';
}

function formatMm(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}
