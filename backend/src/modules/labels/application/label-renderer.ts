import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { createWhiteBitmap, writeBmp } from './bmp-writer';
import type { LabelRow } from './label-row-builder';
import type { LabelExportFormat, LabelTemplateDto } from './labels.types';

export interface RenderedPreview {
  pages: string[];
}

export function renderSvgPages(template: LabelTemplateDto, rows: LabelRow[]): RenderedPreview {
  const width = px(template.canvasWidthMm, template.dpi);
  const height = px(template.canvasHeightMm, template.dpi);
  const pages = rows.map((row) => {
    const body = template.elements
      .slice()
      .sort((a, b) => a.zIndex - b.zIndex)
      .filter((element) => conditionPasses(element.condition, row.values))
      .map((element) => renderElement(element, row.values))
      .join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${template.canvasWidthMm} ${template.canvasHeightMm}">${body}</svg>`;
  });
  return { pages };
}

export async function renderLabelsZip(input: {
  generationId: number;
  orderId: number;
  template: LabelTemplateDto;
  rows: LabelRow[];
  formats: LabelExportFormat[];
  generatedAt: string;
}): Promise<Buffer> {
  const zip = new JSZip();

  input.rows.forEach((row, index) => {
    const n = index + 1;
    const bitmap = renderBitmap(input.template, row);
    const bmp = writeBmp(bitmap);
    const pngImage = new PNG({ width: bitmap.width, height: bitmap.height });
    pngImage.data = Buffer.from(bitmap.rgba);
    const png = PNG.sync.write(pngImage);
    if (input.formats.includes('bmp')) zip.file(`labels/label${n}.bmp`, bmp);
    if (input.formats.includes('png')) zip.file(`labels/label${n}.png`, png);
    // Observed Bazis sample `.emf` files are BMP bytes with an `.emf` extension.
    // True vector EMF is explicitly out of MVP scope.
    if (input.formats.includes('emf')) zip.file(`labels/label${n}.emf`, bmp);
  });
  zip.file(
    'manifest.json',
    JSON.stringify(
      {
        generationId: input.generationId,
        orderId: input.orderId,
        templateId: input.template.labelTemplateId,
        labelCount: input.rows.length,
        formats: input.formats,
        generatedAt: input.generatedAt,
        rendererVersion: 1,
      },
      null,
      2,
    ),
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function renderBitmap(template: LabelTemplateDto, row: LabelRow) {
  const width = px(template.canvasWidthMm, template.dpi);
  const height = px(template.canvasHeightMm, template.dpi);
  const bitmap = createWhiteBitmap(width, height);
  const scale = template.dpi / 25.4;
  for (const element of template.elements.slice().sort((a, b) => a.zIndex - b.zIndex)) {
    if (!conditionPasses(element.condition, row.values)) continue;
    const x = Math.round(element.xMm * scale);
    const y = Math.round(element.yMm * scale);
    const w = Math.max(1, Math.round(element.widthMm * scale));
    const h = Math.max(1, Math.round(element.heightMm * scale));
    if (element.kind === 'line') {
      drawLine(bitmap, x, y, x + w, y + h);
    } else if (element.kind === 'rect') {
      drawRect(bitmap, x, y, w, h);
    } else {
      const value = element.sourceField ? row.values[element.sourceField] : element.staticText;
      drawTextBlocks(bitmap, x, y, w, h, value == null ? '' : String(value), fontSizeMm(element.style.fontSize), scale);
    }
  }
  return bitmap;
}

function drawTextBlocks(
  bitmap: ReturnType<typeof createWhiteBitmap>,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  fontSizeMmValue: number,
  scale: number,
): void {
  const glyphHeight = Math.max(3, Math.min(height, Math.round(fontSizeMmValue * scale)));
  const glyphWidth = Math.max(2, Math.round(glyphHeight * 0.45));
  const gap = Math.max(1, Math.round(glyphWidth * 0.3));
  let cursor = x;
  for (const char of text) {
    if (cursor >= x + width) break;
    if (char !== ' ') {
      fillRect(bitmap, cursor, y, Math.min(glyphWidth, x + width - cursor), glyphHeight);
    }
    cursor += glyphWidth + gap;
  }
}

function drawRect(bitmap: ReturnType<typeof createWhiteBitmap>, x: number, y: number, width: number, height: number): void {
  drawLine(bitmap, x, y, x + width, y);
  drawLine(bitmap, x, y + height, x + width, y + height);
  drawLine(bitmap, x, y, x, y + height);
  drawLine(bitmap, x + width, y, x + width, y + height);
}

function fillRect(bitmap: ReturnType<typeof createWhiteBitmap>, x: number, y: number, width: number, height: number): void {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      setBlack(bitmap, xx, yy);
    }
  }
}

function drawLine(bitmap: ReturnType<typeof createWhiteBitmap>, x1: number, y1: number, x2: number, y2: number): void {
  let x = x1;
  let y = y1;
  const dx = Math.abs(x2 - x1);
  const dy = -Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    setBlack(bitmap, x, y);
    if (x === x2 && y === y2) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function setBlack(bitmap: ReturnType<typeof createWhiteBitmap>, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return;
  const offset = (y * bitmap.width + x) * 4;
  bitmap.rgba[offset] = 0;
  bitmap.rgba[offset + 1] = 0;
  bitmap.rgba[offset + 2] = 0;
  bitmap.rgba[offset + 3] = 255;
}

function renderElement(
  element: LabelTemplateDto['elements'][number],
  values: Record<string, string | number | boolean | null>,
): string {
  const x = element.xMm;
  const y = element.yMm;
  const w = element.widthMm;
  const h = element.heightMm;
  if (element.kind === 'line') {
    return `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="black"/>`;
  }
  if (element.kind === 'rect') {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="black"/>`;
  }
  const value = element.sourceField ? values[element.sourceField] : element.staticText;
  const sizeMm = fontSizeMm(element.style.fontSize);
  return `<text x="${x}" y="${y + sizeMm}" font-family="Arial" font-size="${sizeMm}">${escapeXml(
    value == null ? '' : String(value),
  )}</text>`;
}

function conditionPasses(condition: Record<string, unknown>, values: Record<string, unknown>): boolean {
  const field = typeof condition.field === 'string' ? condition.field : '';
  const op = typeof condition.op === 'string' ? condition.op : '';
  if (!field || !op) return true;
  const value = values[field];
  if (op === 'exists') return value !== undefined && value !== null;
  if (op === 'not_empty') return value !== undefined && value !== null && String(value) !== '';
  if (op === 'equals') return String(value ?? '') === String(condition.value ?? '');
  if (op === 'not_equals') return String(value ?? '') !== String(condition.value ?? '');
  return true;
}

function px(mm: number, dpi: number): number {
  return Math.max(1, Math.round((mm * dpi) / 25.4));
}

function fontSizeMm(value: unknown): number {
  const sizePt = Number(value ?? 10);
  return Math.max(1.8, sizePt * 0.3528);
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
