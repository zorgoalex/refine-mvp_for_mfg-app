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
  cutRenderSourceSvgCss,
  resolveCutRenderStyleFromSetting,
  type CutRenderStyleRef,
  type CutRenderStylesSetting,
} from '@shared/cut-render-style';
import type { CncTelegramCutLayout } from '../../api/types/cncTelegramApi.types';
import type { ParsedSvgUpload } from './svgCutUploadParser';

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
  const pieces = layout.items.map((item) => {
    const fill = fillForOrderName(item.orderName, orderIndexByName, palette, style.piece.defaultFill);
    const cx = item.xMm + item.placedWidthMm / 2;
    const cy = item.yMm + item.placedHeightMm / 2;
    const rect = `<rect x="${num(item.xMm)}" y="${num(item.yMm)}" width="${num(item.placedWidthMm)}" height="${num(
      item.placedHeightMm,
    )}" fill="${escapeXml(fill)}" stroke="${style.piece.stroke}" stroke-width="${num(style.piece.strokeWidthMm)}"/>`;
    const sourceSvg = renderSourceSvg(
      item.sourceSvg,
      item.xMm,
      item.yMm,
      item.placedWidthMm,
      item.placedHeightMm,
      cutRenderSourceSvgCss(style, fill),
    );
    const lines = itemLabelLines(item);
    const labelFill = cutRenderLabelFillForBackground(fill, style);
    const labelStroke = cutRenderLabelStrokeForBackground(fill, fontMm, style);
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
    return `<g>${rect}${sourceSvg}${text}</g>`;
  }).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(sheet.widthMm)} ${num(sheet.heightMm)}">`,
    `<rect x="0" y="0" width="${num(sheet.widthMm)}" height="${num(sheet.heightMm)}" fill="#ffffff" stroke="#9aa7b4" stroke-width="3"/>`,
    pieces,
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

function fillForOrderName(
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
): string {
  if (!sourceSvg?.body.trim()) return '';
  return [
    `<svg class="cut-sheet-piece-source-svg" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(
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
