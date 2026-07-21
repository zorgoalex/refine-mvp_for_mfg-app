import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { Resvg } from '@resvg/resvg-js';
import QRCode from 'qrcode';
import { existsSync } from 'node:fs';
import { writeBmp } from './bmp-writer';
import { readQrErrorCorrection, readQrTemplate, renderLabelTemplateString } from './label-template-fields';
import { assertRenderableTemplateShape, legacyConditionPasses, readTypographyV1, resolveLabelText } from './label-template-advanced';
import type { LabelRow } from './label-row-builder';
import type { LabelExportFormat, LabelTemplateDto } from './labels.types';

export interface RenderedPreview {
  pages: string[];
}

export function renderSvgPages(template: LabelTemplateDto, rows: LabelRow[]): RenderedPreview {
  assertRenderableTemplateShape(template);
  const width = px(template.canvasWidthMm, template.dpi);
  const height = px(template.canvasHeightMm, template.dpi);
  const sortedElements = template.elements
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex);
  const pages = rows.map((row) => {
    const body = sortedElements
      .filter((element) => legacyConditionPasses(element.condition, row.values))
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
  assertRenderableTemplateShape(input.template);
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
  const withRotation = (markup: string): string => {
    const rotation = Number(element.rotationDeg ?? 0);
    return Number.isFinite(rotation) && rotation !== 0
      ? `<g transform="rotate(${rotation} ${x} ${y})">${markup}</g>`
      : markup;
  };
  if (element.kind === 'line') {
    return withRotation(`<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="black"/>`);
  }
  if (element.kind === 'rect') {
    return withRotation(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="black"/>`);
  }
  if (element.kind === 'qr') {
    return withRotation(renderQrElement(element, values));
  }
  const value = resolveLabelText(element, values);
  const typography = readTypographyV1(element.style);
  const sizeMm = fontSizeMm(typography?.fontSizePt ?? element.style.fontSize);
  const align = labelTextAlign(element.style.textAlign);
  const textX = align === 'left' ? x : align === 'right' ? x + w : x + w / 2;
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  const weight = typography?.fontWeight === 'bold' ? ' font-weight="700"' : '';
  const italic = typography?.italic ? ' font-style="italic"' : '';
  return withRotation(`<text x="${textX}" y="${y + sizeMm}" text-anchor="${anchor}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${sizeMm}"${weight}${italic}>${escapeXml(value)}</text>`);
}

function renderSvgPage(template: LabelTemplateDto, row: LabelRow): string {
  return renderSvgPages(template, [row]).pages[0] ?? '';
}

function renderQrElement(
  element: LabelTemplateDto['elements'][number],
  values: Record<string, string | number | boolean | null>,
): string {
  const x = element.xMm;
  const y = element.yMm;
  const width = element.widthMm;
  const height = element.heightMm;
  const side = Math.max(1, Math.min(width, height));
  const payload = renderLabelTemplateString(readQrTemplate(element.style), values);
  const originX = x + (width - side) / 2;
  const originY = y + (height - side) / 2;
  if (!payload) {
    return `<g data-label-element-kind="qr" data-qr-payload=""><rect x="${originX}" y="${originY}" width="${side}" height="${side}" fill="white"/></g>`;
  }

  const errorCorrectionLevel = readQrErrorCorrection(element.style);
  const code = QRCode.create(payload, { errorCorrectionLevel });
  const moduleCount = code.modules.size;
  const quietZoneModules = 4;
  const totalModules = moduleCount + quietZoneModules * 2;
  const moduleSide = side / totalModules;
  const modules: string[] = [];

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (code.modules.get(row, col) !== 1) {
        continue;
      }
      modules.push(
        `<rect x="${originX + (col + quietZoneModules) * moduleSide}" y="${originY + (row + quietZoneModules) * moduleSide}" width="${moduleSide}" height="${moduleSide}" fill="black"/>`,
      );
    }
  }

  return `<g data-label-element-kind="qr" data-qr-payload="${escapeXml(payload)}"><rect x="${originX}" y="${originY}" width="${side}" height="${side}" fill="white"/>${modules.join('')}</g>`;
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

function px(mm: number, dpi: number): number {
  return Math.max(1, Math.round((mm * dpi) / 25.4));
}

function fontSizeMm(value: unknown): number {
  const parsed = Number(value ?? 10);
  const sizePt = Number.isFinite(parsed) ? Math.min(96, Math.max(4, parsed)) : 10;
  return Math.max(1.8, sizePt * 0.3528);
}

function labelTextAlign(value: unknown): 'left' | 'center' | 'right' {
  return value === 'left' || value === 'right' ? value : 'center';
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
