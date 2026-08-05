import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { Resvg } from '@resvg/resvg-js';
import QRCode from 'qrcode';
import { existsSync } from 'node:fs';
import { writeBmp } from './bmp-writer';
import { readQrErrorCorrection, readQrTemplate, renderLabelTemplateString } from './label-template-fields';
import { assertRenderableTemplateShape, legacyConditionPasses, readCutMapStyleV1, readTypographyV1, resolveLabelText } from './label-template-advanced';
import type { LabelRow } from './label-row-builder';
import type { LabelExportFormat, LabelTemplateDto } from './labels.types';

export interface RenderedPreview {
  pages: string[];
}

export interface LabelCutMapAsset {
  svg: string;
  isVacuum: boolean;
}

export type LabelCutMapAssets = ReadonlyMap<number, LabelCutMapAsset>;

const CUT_MAP_RENDERER_VERSION = 5;
const CUT_MAP_DETAIL_STROKE_MULTIPLIER = 2;
const CUT_MAP_SELECTED_FILL = '#000000';

export function renderSvgPages(
  template: LabelTemplateDto,
  rows: LabelRow[],
  cutMapAssets: LabelCutMapAssets = new Map(),
): RenderedPreview {
  assertRenderableTemplateShape(template);
  const width = px(template.canvasWidthMm, template.dpi);
  const height = px(template.canvasHeightMm, template.dpi);
  const sortedElements = template.elements
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex);
  const pages = rows.map((row) => {
    const body = sortedElements
      .filter((element) => legacyConditionPasses(element.condition, row.values))
      .map((element) => renderElement(element, row, cutMapAssets))
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
  cutMapAssets?: LabelCutMapAssets;
}): Promise<Buffer> {
  assertRenderableTemplateShape(input.template);
  const zip = new JSZip();
  const archiveDate = new Date(input.generatedAt);
  if (Number.isNaN(archiveDate.getTime())) {
    throw new Error('Invalid label generation timestamp');
  }
  const zipOptions = { date: archiveDate };
  zip.file('labels/', null, { ...zipOptions, dir: true });

  for (const [index, row] of input.rows.entries()) {
    const n = index + 1;
    const svg = renderSvgPage(input.template, row, input.cutMapAssets);
    const png = renderSvgToPng(svg);
    const image = PNG.sync.read(png);
    const bmp = writeBmp({ width: image.width, height: image.height, rgba: image.data });
    if (input.formats.includes('bmp')) zip.file(`labels/label${n}.bmp`, bmp, zipOptions);
    if (input.formats.includes('png')) zip.file(`labels/label${n}.png`, png, zipOptions);
    // Observed Bazis sample `.emf` files are BMP bytes with an `.emf` extension.
    // True vector EMF is explicitly out of MVP scope.
    if (input.formats.includes('emf')) zip.file(`labels/label${n}.emf`, bmp, zipOptions);
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
        rendererVersion: input.template.elements.some((element) => element.kind === 'cut_map')
          ? CUT_MAP_RENDERER_VERSION
          : 1,
      },
      null,
      2,
    ),
    zipOptions,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function renderElement(
  element: LabelTemplateDto['elements'][number],
  row: LabelRow,
  cutMapAssets: LabelCutMapAssets,
): string {
  const values = row.values;
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
  if (element.kind === 'cut_map') {
    return withRotation(renderCutMapElement(element, row, cutMapAssets));
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

function renderSvgPage(template: LabelTemplateDto, row: LabelRow, cutMapAssets?: LabelCutMapAssets): string {
  return renderSvgPages(template, [row], cutMapAssets).pages[0] ?? '';
}

function renderCutMapElement(
  element: LabelTemplateDto['elements'][number],
  row: LabelRow,
  cutMapAssets: LabelCutMapAssets,
): string {
  const map = row.cutMap;
  if (!map) return '';
  const frozenAsset = cutMapAssets.get(map.cutResultSheetMapId);
  if (!frozenAsset) {
    throw new Error(`Missing frozen cut-map asset ${map.cutResultSheetMapId}`);
  }
  const baseSvg = frozenAsset.svg;
  const keepLegacyRotatedOrigin = frozenAsset.isVacuum;
  const safeBody = extractSafeCutSheetBody(baseSvg);
  if (safeBody === null) {
    throw new Error(`Invalid frozen cut-map asset ${map.cutResultSheetMapId}`);
  }
  const body = thickenCutSheetDetailStrokes(safeBody);
  const style = readCutMapStyleV1(element.style);
  if (!style) {
    throw new Error(`Invalid cut-map style for ${element.elementKey}`);
  }

  const rotateSheet = (
    element.widthMm < element.heightMm && map.sheetWidthMm > map.sheetHeightMm
  ) || (
    element.widthMm > element.heightMm && map.sheetWidthMm < map.sheetHeightMm
  );
  const orientedSheetWidthMm = rotateSheet ? map.sheetHeightMm : map.sheetWidthMm;
  const orientedSheetHeightMm = rotateSheet ? map.sheetWidthMm : map.sheetHeightMm;
  const scale = Math.max(0.000001, Math.min(
    element.widthMm / orientedSheetWidthMm,
    element.heightMm / orientedSheetHeightMm,
  ));
  const markerStroke = 0.85 / scale;
  const selectedStroke = 0.42 / scale;
  const shownPieceSide = Math.min(map.widthMm, map.heightMm) * scale;
  const markerRadius = Math.min(Math.min(map.sheetWidthMm, map.sheetHeightMm) / 18, 1.35 / scale);
  const marker = shownPieceSide < 1.5
    ? `<circle cx="${num(map.xMm + map.widthMm / 2)}" cy="${num(map.yMm + map.heightMm / 2)}" r="${num(markerRadius)}" fill="none" stroke="${CUT_MAP_SELECTED_FILL}" stroke-width="${num(markerStroke)}"/>`
    : '';

  const sheetBody = [
    body,
    `<rect x="${num(map.xMm)}" y="${num(map.yMm)}" width="${num(map.widthMm)}" height="${num(map.heightMm)}" fill="${CUT_MAP_SELECTED_FILL}" stroke="${CUT_MAP_SELECTED_FILL}" stroke-width="${num(selectedStroke)}"/>`,
    marker,
  ].join('');
  const orientedSheetBody = !rotateSheet
    ? sheetBody
    : keepLegacyRotatedOrigin
      ? `<g transform="translate(${num(map.sheetHeightMm)} 0) rotate(90)">${sheetBody}</g>`
      : `<g transform="matrix(0 1 1 0 0 0)">${sheetBody}</g>`;
  const flipScaleX = style.flipHorizontal ? -1 : 1;
  const flipScaleY = style.flipVertical ? -1 : 1;
  const flipTranslateX = style.flipHorizontal ? orientedSheetWidthMm : 0;
  const flipTranslateY = style.flipVertical ? orientedSheetHeightMm : 0;
  const displayedSheetBody = style.flipHorizontal || style.flipVertical
    ? `<g transform="translate(${num(flipTranslateX)} ${num(flipTranslateY)}) scale(${flipScaleX} ${flipScaleY})">${orientedSheetBody}</g>`
    : orientedSheetBody;

  return [
    `<g data-label-element-kind="cut_map" data-cut-number="${escapeXml(map.cutNumber)}" data-cut-result-placement-id="${map.cutResultPlacementId}" data-cut-map-flip-horizontal="${style.flipHorizontal}" data-cut-map-flip-vertical="${style.flipVertical}">`,
    `<svg x="${num(element.xMm)}" y="${num(element.yMm)}" width="${num(element.widthMm)}" height="${num(element.heightMm)}" viewBox="0 0 ${num(orientedSheetWidthMm)} ${num(orientedSheetHeightMm)}" preserveAspectRatio="xMidYMid meet" overflow="hidden">`,
    displayedSheetBody,
    '</svg>',
    '</g>',
  ].join('');
}

function extractSafeCutSheetBody(svg: string): string | null {
  const match = /^\s*<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg);
  if (!match) return null;
  const source = match[1];
  const elements: string[] = [];
  const tagPattern = /<rect\b([^>]*)\/>|<line\b([^>]*)\/>|<g\b([^>]*)>|<\/g>|<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let cursor = 0;
  for (const tag of source.matchAll(tagPattern)) {
    const index = tag.index ?? -1;
    if (index < cursor || source.slice(cursor, index).trim()) return null;
    const token = tag[0];
    if (/^<rect\b/i.test(token)) {
      const attributes = parseSafeRectAttributes(tag[1] ?? '');
      if (!attributes) return null;
      elements.push(`<rect${attributes}/>`);
    } else if (/^<line\b/i.test(token)) {
      const attributes = parseSafeLineAttributes(tag[2] ?? '');
      if (!attributes) return null;
      elements.push(`<line${attributes}/>`);
    } else if (/^<g\b/i.test(token)) {
      if (!hasSafeIgnoredAttributes(tag[3] ?? '')) return null;
    } else if (/^<\/g>/i.test(token)) {
      // Group wrappers from frozen cut-map SVGs only carry metadata. They are
      // stripped after validating their attributes.
    } else {
      const attributes = parseSafeTextAttributes(tag[4] ?? '');
      const text = tag[5] ?? '';
      if (!attributes || /[<>]/.test(text)) return null;
      elements.push(`<text${attributes}>${escapeXml(text.trim())}</text>`);
    }
    cursor = index + tag[0].length;
  }
  if (source.slice(cursor).trim()) return null;
  return elements.join('');
}

function thickenCutSheetDetailStrokes(body: string): string {
  return body.replace(/<rect\b[^>]*\/>/gi, (rect) => {
    if (!/\sstroke="#1f2d3d"/i.test(rect)) return rect;
    return rect.replace(
      /\sstroke-width="([^"]+)"/i,
      (_attribute, value: string) => ` stroke-width="${num(Number(value) * CUT_MAP_DETAIL_STROKE_MULTIPLIER)}"`,
    );
  });
}

const CUT_SHEET_NUMERIC_ATTRIBUTES = new Set([
  'x', 'y', 'width', 'height', 'rx', 'ry', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-width',
]);
const CUT_SHEET_COLOR_ATTRIBUTES = new Set(['fill', 'stroke']);
const CUT_SHEET_LINE_NUMERIC_ATTRIBUTES = new Set(['x1', 'y1', 'x2', 'y2', 'stroke-opacity', 'stroke-width']);
const CUT_SHEET_TEXT_NUMERIC_ATTRIBUTES = new Set(['x', 'y', 'font-size', 'font-weight', 'stroke-width']);
const CUT_SHEET_TEXT_ENUM_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  'dominant-baseline': new Set(['middle', 'central', 'alphabetic', 'hanging']),
  'paint-order': new Set(['stroke', 'fill', 'markers', 'stroke fill', 'stroke fill markers']),
  'pointer-events': new Set(['none']),
  'text-anchor': new Set(['start', 'middle', 'end']),
};

function parseSafeRectAttributes(source: string): string | null {
  return parseSafeAttributes(source, (name, value) => {
    if (CUT_SHEET_NUMERIC_ATTRIBUTES.has(name)) {
      return isSafeNumber(value) ? value : null;
    }
    if (CUT_SHEET_COLOR_ATTRIBUTES.has(name)) {
      return isSafeColor(value) ? value : null;
    }
    return null;
  });
}

function parseSafeLineAttributes(source: string): string | null {
  return parseSafeAttributes(source, (name, value) => {
    if (CUT_SHEET_LINE_NUMERIC_ATTRIBUTES.has(name)) {
      return isSafeNumber(value) ? value : null;
    }
    if (CUT_SHEET_COLOR_ATTRIBUTES.has(name)) {
      return isSafeColor(value) ? value : null;
    }
    if (name === 'stroke-dasharray') {
      return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[ ,]+-?(?:\d+(?:\.\d+)?|\.\d+))*$/.test(value) ? value : null;
    }
    if (name === 'pointer-events') return value === 'none' ? value : null;
    if (isIgnoredCutMapMetadataAttribute(name, value)) return undefined;
    return null;
  });
}

function parseSafeTextAttributes(source: string): string | null {
  const parsed = parseSafeAttributes(source, (name, value) => {
    if (CUT_SHEET_TEXT_NUMERIC_ATTRIBUTES.has(name)) {
      return isSafeNumber(value) ? value : null;
    }
    if (CUT_SHEET_COLOR_ATTRIBUTES.has(name)) {
      return isSafeColor(value) ? value : null;
    }
    const allowed = CUT_SHEET_TEXT_ENUM_ATTRIBUTES[name];
    if (allowed) return allowed.has(value) ? value : null;
    if (name === 'font-family') return isSafeFontFamily(value) ? undefined : null;
    if (name === 'style') return value === 'font-variant-numeric:tabular-nums' ? undefined : null;
    if (isIgnoredCutMapMetadataAttribute(name, value)) return undefined;
    return null;
  });
  return parsed === null ? null : `${parsed} font-family="DejaVu Sans, Arial, sans-serif"`;
}

function hasSafeIgnoredAttributes(source: string): boolean {
  return parseSafeAttributes(source, (name, value) => (
    isIgnoredCutMapMetadataAttribute(name, value) ? undefined : null
  )) !== null;
}

function parseSafeAttributes(
  source: string,
  readValue: (name: string, value: string) => string | null | undefined,
): string | null {
  const attributes: string[] = [];
  const seen = new Set<string>();
  const pattern = /\s+([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? -1;
    if (index < cursor || source.slice(cursor, index).trim()) return null;
    const name = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? match[3] ?? '';
    if (seen.has(name)) return null;
    const safeValue = readValue(name, value);
    if (safeValue === null) return null;
    seen.add(name);
    if (safeValue !== undefined) attributes.push(` ${name}="${safeValue}"`);
    cursor = index + match[0].length;
  }
  if (source.slice(cursor).trim()) return null;
  return attributes.join('');
}

function isSafeNumber(value: string): boolean {
  return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) && Number.isFinite(Number(value));
}

function isSafeColor(value: string): boolean {
  return /^(?:#[0-9a-f]{3,8}|none|transparent|white|black)$/i.test(value);
}

function isSafeFontFamily(value: string): boolean {
  return /^[A-Za-z0-9 ,._-]+$/.test(value);
}

function isIgnoredCutMapMetadataAttribute(name: string, value: string): boolean {
  if (name === 'class') return /^[A-Za-z0-9 _:-]+$/.test(value);
  return name.startsWith('data-') && /^[A-Za-z0-9А-Яа-яЁё .:_-]+$/.test(value);
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

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
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
