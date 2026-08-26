import {
  CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
  cutRenderLabelFontWeight,
  cutRenderLabelLetterSpacingRatio,
  cutRenderLabelFillForBackground,
  cutRenderLabelLineSpecs,
  cutRenderNormalizeLabelLines,
  cutRenderPieceSizeLine,
  cutRenderLabelStrokeForBackground,
  cutRenderOrderFillPalette,
  cutRenderPositionLine,
  cutRenderRawSvgScreenshotMinStrokePx,
  cutRenderSourceSvgCss,
  resolveCutRenderStyleFromSetting,
  type CutRenderStyleRef,
  type CutRenderStylesSetting,
} from '@shared/cut-render-style';
import type { CncTelegramCutLayout } from '../../api/types/cncTelegramApi.types';
import type { ParsedSvgUpload } from './svgCutUploadParser';

export const RAW_SVG_UPLOAD_PREVIEW_TARGET_PX = 720;

/**
 * Keep the complete source SVG, including milling geometry, while making
 * sub-pixel CNC strokes visible at the upload modal's screen scale.
 */
export function buildRawSvgUploadPreview(
  svg: string,
  targetPx = RAW_SVG_UPLOAD_PREVIEW_TARGET_PX,
): string {
  const longSide = rawSvgLongSideUserUnits(svg);
  if (longSide === null || !Number.isFinite(targetPx) || targetPx <= 0) return svg;
  const minStrokeWidth = longSide / targetPx
    * cutRenderRawSvgScreenshotMinStrokePx(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW);
  if (!Number.isFinite(minStrokeWidth) || minStrokeWidth <= 0) return svg;
  return widenRawSvgPreviewStrokes(svg, minStrokeWidth);
}

export function createRawSvgUploadPreviewBlob(svg: string): Blob {
  return new Blob([buildRawSvgUploadPreview(svg)], { type: 'image/svg+xml' });
}

export function createStyledSvgUploadPreviewBlob(
  parsed: ParsedSvgUpload,
  renderStylesSetting?: CutRenderStylesSetting | null,
): Blob | null {
  const svg = buildStyledSvgUploadPreview(parsed, renderStylesSetting);
  return svg ? new Blob([svg], { type: 'image/svg+xml' }) : null;
}

export function buildStyledSvgUploadPreview(
  parsed: ParsedSvgUpload,
  renderStylesSetting?: CutRenderStylesSetting | null,
): string | null {
  return buildStyledCutLayoutPreview(parsed.cutLayout, renderStylesSetting);
}

export function buildStyledCutLayoutPreview(
  layout: CncTelegramCutLayout,
  renderStylesSetting?: CutRenderStylesSetting | null,
): string | null {
  const sheet = layout.sheet;
  if (!sheet || layout.items.length === 0) return null;
  const style = resolveCutRenderStyleFromSetting(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW, renderStylesSetting);
  const palette = cutRenderOrderFillPalette(style);
  const orderIndexByName = new Map<string, number>();
  const fontMm = Math.max(24, Math.round(Math.min(sheet.widthMm, sheet.heightMm) / 40));
  const renderedItems = layout.items.map((item, itemIndex) => {
    const background = style.piece.defaultFill;
    const contour = contourForOrderName(item.orderName, orderIndexByName, palette, style.piece.stroke);
    const cx = item.xMm + item.placedWidthMm / 2;
    const cy = item.yMm + item.placedHeightMm / 2;
    const rect = `<rect x="${num(item.xMm)}" y="${num(item.yMm)}" width="${num(item.placedWidthMm)}" height="${num(
      item.placedHeightMm,
    )}" fill="${escapeXml(background)}" stroke="${escapeXml(contour)}" stroke-width="${num(style.piece.strokeWidthMm)}"/>`;
    const sourceClass = `cut-sheet-piece-source-svg-${itemIndex}`;
    const sourceSvg = renderSourceSvg(
      item.sourceSvg,
      item.xMm,
      item.yMm,
      item.placedWidthMm,
      item.placedHeightMm,
      cutRenderSourceSvgCss(style, background, contour, `.${sourceClass}`),
      sourceClass,
    );
    const lines = itemLabelLines(item);
    const labelFill = cutRenderLabelFillForBackground(background, style);
    const labelStroke = cutRenderLabelStrokeForBackground(background, fontMm, style);
    const labelStrokeAttrs = labelStroke
      ? ` stroke="${labelStroke.stroke}" stroke-width="${num(labelStroke.strokeWidthMm)}" paint-order="stroke"`
      : '';
    const text = renderPieceLabelText({
      lines,
      cx,
      cy,
      fontMm,
      renderStyle: style,
      fontWeight: cutRenderLabelFontWeight(style),
      letterSpacingRatio: cutRenderLabelLetterSpacingRatio(style),
      fill: labelFill,
      strokeAttrs: labelStrokeAttrs,
    });
    return {
      geometry: `<g>${rect}${sourceSvg}</g>`,
      label: text,
    };
  });
  const geometry = renderedItems.map((item) => item.geometry).join('');
  const labels = renderedItems.map((item) => item.label).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(sheet.widthMm)} ${num(sheet.heightMm)}">`,
    `<rect x="0" y="0" width="${num(sheet.widthMm)}" height="${num(sheet.heightMm)}" fill="${escapeXml(style.piece.defaultFill)}" stroke="#9aa7b4" stroke-width="3"/>`,
    `<g class="cut-sheet-piece-geometry-layer">${geometry}</g>`,
    `<g class="cut-sheet-piece-label-layer">${labels}</g>`,
    '</svg>',
  ].join('');
}

function itemLabelLines(item: CncTelegramCutLayout['items'][number]): string[] {
  const rawLines = cutRenderNormalizeLabelLines(item.visualLabel?.rawLines ?? []);
  if (rawLines.length >= 3) return rawLines;
  if (rawLines.length > 0) return [...rawLines, cutRenderPieceSizeLine(item.widthMm, item.heightMm)];
  return [
    item.orderName,
    cutRenderPositionLine(item.detailNumber),
    cutRenderPieceSizeLine(item.widthMm, item.heightMm),
  ];
}

function renderPieceLabelText(input: {
  lines: readonly string[];
  cx: number;
  cy: number;
  fontMm: number;
  renderStyle: CutRenderStyleRef;
  fontWeight: number;
  letterSpacingRatio: number;
  fill: string;
  strokeAttrs: string;
}): string {
  const specs = cutRenderLabelLineSpecs(input.lines, input.renderStyle);
  if (specs.length === 0) return '';
  const lineHeights = specs.map((spec) => input.fontMm * spec.fontRatio * 0.82);
  const gaps = specs.map((spec, index) => index < specs.length - 1 ? input.fontMm * spec.gapAfterRatio : 0);
  const totalHeight = lineHeights.reduce((sum, height, index) => sum + height + (gaps[index] ?? 0), 0);
  let top = input.cy - totalHeight / 2;
  const tspans = specs.map((spec, index) => {
    const fontSize = input.fontMm * spec.fontRatio;
    const lineHeight = lineHeights[index] ?? fontSize * 0.82;
    const y = top + lineHeight / 2;
    top += lineHeight + (gaps[index] ?? 0);
    return `<tspan x="${num(input.cx)}" y="${num(y)}" font-size="${num(fontSize)}">${escapeXml(spec.text)}</tspan>`;
  }).join('');
  const letterSpacing = input.fontMm * input.letterSpacingRatio;
  const letterSpacingAttr = letterSpacing === 0 ? '' : ` letter-spacing="${num(letterSpacing)}"`;
  return `<text x="${num(input.cx)}" y="${num(input.cy)}" font-family="Liberation Sans, Arial, sans-serif" font-size="${num(
    input.fontMm,
  )}" font-weight="${num(input.fontWeight)}"${letterSpacingAttr} fill="${input.fill}"${input.strokeAttrs} text-anchor="middle" dominant-baseline="middle">${tspans}</text>`;
}

function contourForOrderName(
  orderName: string,
  orderIndexByName: Map<string, number>,
  palette: readonly string[],
  fallback: string,
): string {
  const key = orderName.trim();
  if (!key) return fallback;
  let index = orderIndexByName.get(key);
  if (index === undefined) {
    index = orderIndexByName.size;
    orderIndexByName.set(key, index);
  }
  return palette[index % palette.length] ?? fallback;
}

function renderSourceSvg(
  sourceSvg: CncTelegramCutLayout['items'][number]['sourceSvg'],
  x: number,
  y: number,
  width: number,
  height: number,
  css: string,
  scopeClass: string,
): string {
  if (!sourceSvg?.body.trim()) return '';
  return [
    `<svg class="cut-sheet-piece-source-svg ${scopeClass}" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(
      sourceSvg.viewBox.widthMm,
    )} ${num(sourceSvg.viewBox.heightMm)}" preserveAspectRatio="none" overflow="hidden">`,
    css ? `<style>${css}</style>` : '',
    sourceSvg.body,
    '</svg>',
  ].join('');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function rawSvgLongSideUserUnits(svg: string): number | null {
  const viewBoxMatch = svg.match(/\bviewBox\s*=\s*(["'])([^"']+)\1/i);
  if (viewBoxMatch?.[2]) {
    const values = viewBoxMatch[2].trim().split(/[\s,]+/).map(Number);
    const width = values[2] ?? 0;
    const height = values[3] ?? 0;
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return Math.max(width, height);
    }
  }
  const width = rawSvgRootLength(svg, 'width');
  const height = rawSvgRootLength(svg, 'height');
  return width !== null && height !== null ? Math.max(width, height) : null;
}

function rawSvgRootLength(svg: string, attr: 'width' | 'height'): number | null {
  const svgOpenMatch = svg.match(/<svg\b[^>]*>/i);
  const attrMatch = svgOpenMatch?.[0].match(new RegExp(`\\b${attr}\\s*=\\s*(["'])([^"']+)\\1`, 'i'));
  const lengthMatch = attrMatch?.[2]?.trim().match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
  if (!lengthMatch?.[0]) return null;
  const value = Number(lengthMatch[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function widenRawSvgPreviewStrokes(svg: string, minStrokeWidth: number): string {
  const minimum = Number(minStrokeWidth.toFixed(3)).toString();
  const svgNumber = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const unitlessBoundary = '(?![\\d.]|\\s*[a-zA-Z%])';
  const cssStrokeWidth = new RegExp(`(\\bstroke-width\\s*:\\s*)(${svgNumber})${unitlessBoundary}`, 'gi');
  const attrStrokeWidth = new RegExp(`(\\bstroke-width\\s*=\\s*)(["'])(${svgNumber})${unitlessBoundary}\\2`, 'gi');
  return svg
    .replace(cssStrokeWidth, (match, prefix: string, rawWidth: string) => {
      const width = Number(rawWidth);
      return Number.isFinite(width) && width > 0 && width < minStrokeWidth ? `${prefix}${minimum}` : match;
    })
    .replace(attrStrokeWidth, (match, prefix: string, quote: string, rawWidth: string) => {
      const width = Number(rawWidth);
      return Number.isFinite(width) && width > 0 && width < minStrokeWidth
        ? `${prefix}${quote}${minimum}${quote}`
        : match;
    });
}
