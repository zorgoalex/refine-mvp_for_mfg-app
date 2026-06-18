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
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
