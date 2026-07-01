import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { Resvg } from '@resvg/resvg-js';
import { existsSync } from 'node:fs';
import { writeBmp } from './bmp-writer';
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
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${template.canvasWidthMm} ${template.canvasHeightMm}"><rect x="0" y="0" width="${template.canvasWidthMm}" height="${template.canvasHeightMm}" fill="white"/>${body}</svg>`;
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

  for (const [index, row] of input.rows.entries()) {
    const n = index + 1;
    const svg = renderSvgPage(input.template, row);
    const png = renderSvgToPng(svg);
    const image = PNG.sync.read(png);
    const bmp = writeBmp({ width: image.width, height: image.height, rgba: image.data });
    if (input.formats.includes('bmp')) zip.file(`labels/label${n}.bmp`, bmp);
    if (input.formats.includes('png')) zip.file(`labels/label${n}.png`, png);
    // Observed Bazis sample `.emf` files are BMP bytes with an `.emf` extension.
    // True vector EMF is explicitly out of MVP scope.
    if (input.formats.includes('emf')) zip.file(`labels/label${n}.emf`, bmp);
  }
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
  const align = labelTextAlign(element.style.textAlign);
  const textX = align === 'left' ? x : align === 'right' ? x + w : x + w / 2;
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  return `<text x="${textX}" y="${y + sizeMm}" text-anchor="${anchor}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${sizeMm}">${escapeXml(
    value == null ? '' : String(value),
  )}</text>`;
}

function renderSvgPage(template: LabelTemplateDto, row: LabelRow): string {
  return renderSvgPages(template, [row]).pages[0] ?? '';
}

function renderSvgToPng(svg: string): Buffer {
  const fontFiles = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].filter((file) => existsSync(file));
  return new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      defaultFontFamily: 'DejaVu Sans',
      fontFiles,
      loadSystemFonts: true,
    },
  }).render().asPng();
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

function labelTextAlign(value: unknown): 'left' | 'center' | 'right' {
  return value === 'left' || value === 'right' ? value : 'center';
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
