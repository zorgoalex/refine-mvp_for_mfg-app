import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
import {
  CUT_RENDER_STYLE_DEFAULT,
  cutRenderRawSvgScreenshotMinStrokePx,
  type CutRenderStyleRef,
} from '../../../shared/cut-render-style';

/**
 * Per-sheet PNG rasterization (plan §7). resvg-js (pure-rust prebuilt binary, no
 * headless browser). Bundled TTF is loaded from disk into a buffer (NOT a system
 * path) so the container has no font dependency; a startup assert fails fast if
 * the font is missing (resvg silently drops <text> otherwise — MINOR-16).
 */
export const FONT_FAMILY = 'Liberation Sans';
const FONT_FILE = 'LiberationSans-Regular.ttf';

// Longest-side caps in px (plan §7).
export const RENDER_PRESETS = {
  thumb: 360,
  screen: 1400,
  print: 3500,
} as const;

export const RAW_SVG_SCREENSHOT_CONTRAST_DEFAULT = 1.45;
export const RAW_SVG_SCREENSHOT_CONTRAST_MIN = 1;
export const RAW_SVG_SCREENSHOT_CONTRAST_MAX = 6;
export const RAW_SVG_SCREENSHOT_MIN_STROKE_PX = cutRenderRawSvgScreenshotMinStrokePx(CUT_RENDER_STYLE_DEFAULT);

export type RenderPreset = keyof typeof RENDER_PRESETS;

// Candidate locations for the bundled font. __dirname is .../{src|dist}/modules/cut/render;
// the package root (holding assets/) is four levels up in both test and built layouts.
function fontCandidates(): string[] {
  return [
    resolve(__dirname, '../../../../assets/fonts', FONT_FILE),
    join(process.cwd(), 'assets/fonts', FONT_FILE),
    join(process.cwd(), 'backend/assets/fonts', FONT_FILE),
  ];
}

export function resolveFontPath(): string | null {
  return fontCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

/** Startup fail-fast: resvg renders blank text if the font is absent. */
export function assertFontAvailable(): void {
  if (!resolveFontPath()) {
    throw new Error(
      `Cut render font ${FONT_FILE} not found. Looked in: ${fontCandidates().join(', ')}. ` +
        'Ensure the Dockerfile COPY includes assets/.',
    );
  }
}

let cachedFontPath: string | null = null;

function requireFontPath(): string {
  if (!cachedFontPath) {
    assertFontAvailable();
    cachedFontPath = resolveFontPath() as string;
  }
  return cachedFontPath;
}

export interface RenderSheetPngInput {
  svg: string;
  /** longest-side cap in px (resolved from cut_render_presets config, not a literal) */
  targetPx: number;
  sheetWidthMm: number;
  sheetHeightMm: number;
}

export function renderSheetPng(input: RenderSheetPngInput): Buffer {
  const px = input.targetPx;
  // Cap the LONGEST side to the preset px (landscape -> width, portrait -> height).
  const fitTo =
    input.sheetWidthMm >= input.sheetHeightMm
      ? ({ mode: 'width', value: px } as const)
      : ({ mode: 'height', value: px } as const);

  // NOTE: resvg-js 2.6.2 honors fitTo only with fontFiles (a fontBuffers +
  // fitTo bug renders at intrinsic size). We load the bundled TTF by path with
  // loadSystemFonts:false, so there is still no system-font dependency.
  const resvg = new Resvg(input.svg, {
    fitTo,
    font: {
      fontFiles: [requireFontPath()],
      defaultFontFamily: FONT_FAMILY,
      loadSystemFonts: false,
    },
  });
  return Buffer.from(resvg.render().asPng());
}

export interface RenderRawSvgPngInput {
  svg: string;
  /** longest-side cap in px */
  targetPx: number;
  sheetWidthMm?: number | null;
  sheetHeightMm?: number | null;
  contrast?: number | null;
  renderStyle?: CutRenderStyleRef;
}

export function renderRawSvgPng(input: RenderRawSvgPngInput): Buffer {
  const width = input.sheetWidthMm;
  const height = input.sheetHeightMm;
  const fitTo = width != null && height != null && width > 0 && height > 0 && width < height
    ? ({ mode: 'height', value: input.targetPx } as const)
    : ({ mode: 'width', value: input.targetPx } as const);

  const resvg = new Resvg(prepareRawSvgForScreenshot(input.svg, input.targetPx, input.renderStyle), {
    fitTo,
    font: {
      fontFiles: [requireFontPath()],
      defaultFontFamily: FONT_FAMILY,
      loadSystemFonts: false,
    },
  });
  return enhanceRawSvgScreenshotContrast(Buffer.from(resvg.render().asPng()), input.contrast);
}

export function prepareRawSvgForScreenshot(
  svg: string,
  targetPx: number,
  renderStyle: CutRenderStyleRef = CUT_RENDER_STYLE_DEFAULT,
): string {
  const minStrokeWidth = rawSvgMinStrokeWidthUserUnits(svg, targetPx, renderStyle);
  if (minStrokeWidth === null) return svg;
  return widenRawSvgScreenshotStrokes(svg, minStrokeWidth);
}

export function normalizeRawSvgScreenshotContrast(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return RAW_SVG_SCREENSHOT_CONTRAST_DEFAULT;
  }
  const clamped = Math.min(RAW_SVG_SCREENSHOT_CONTRAST_MAX, Math.max(RAW_SVG_SCREENSHOT_CONTRAST_MIN, value));
  return Math.round(clamped * 100) / 100;
}

export function enhanceRawSvgScreenshotContrast(png: Buffer, contrast: number | null | undefined): Buffer {
  const factor = normalizeRawSvgScreenshotContrast(contrast);
  if (factor <= 1.0001) return png;

  const image = PNG.sync.read(png);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha <= 5) {
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = 255;
      continue;
    }
    const opacity = alpha / 255;
    const red = data[index] ?? 255;
    const green = data[index + 1] ?? 255;
    const blue = data[index + 2] ?? 255;
    data[index] = darkenAgainstWhite(red * opacity + 255 * (1 - opacity), factor);
    data[index + 1] = darkenAgainstWhite(green * opacity + 255 * (1 - opacity), factor);
    data[index + 2] = darkenAgainstWhite(blue * opacity + 255 * (1 - opacity), factor);
    data[index + 3] = 255;
  }
  return PNG.sync.write(image);
}

function darkenAgainstWhite(value: number, factor: number): number {
  return Math.max(0, Math.min(255, Math.round(255 - (255 - value) * factor)));
}

function rawSvgMinStrokeWidthUserUnits(
  svg: string,
  targetPx: number,
  renderStyle: CutRenderStyleRef,
): number | null {
  if (!Number.isFinite(targetPx) || targetPx <= 0) return null;
  const longSide = rawSvgLongSideUserUnits(svg);
  if (longSide === null) return null;
  const minStrokeWidth = longSide / targetPx * cutRenderRawSvgScreenshotMinStrokePx(renderStyle);
  return Number.isFinite(minStrokeWidth) && minStrokeWidth > 0 ? minStrokeWidth : null;
}

function rawSvgLongSideUserUnits(svg: string): number | null {
  const viewBoxMatch = svg.match(/\bviewBox\s*=\s*(["'])([^"']+)\1/i);
  if (viewBoxMatch?.[2]) {
    const values = viewBoxMatch[2]
      .trim()
      .split(/[\s,]+/)
      .map((value) => Number(value));
    const width = values[2] ?? 0;
    const height = values[3] ?? 0;
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return Math.max(width, height);
    }
  }

  const width = rawSvgRootLength(svg, 'width');
  const height = rawSvgRootLength(svg, 'height');
  if (width === null || height === null) return null;
  return Math.max(width, height);
}

function rawSvgRootLength(svg: string, attr: 'width' | 'height'): number | null {
  const svgOpenMatch = svg.match(/<svg\b[^>]*>/i);
  const attrMatch = svgOpenMatch?.[0].match(new RegExp(`\\b${attr}\\s*=\\s*(["'])([^"']+)\\1`, 'i'));
  if (!attrMatch?.[2]) return null;
  const lengthMatch = attrMatch[2].trim().match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
  if (!lengthMatch?.[0]) return null;
  const value = Number(lengthMatch[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function widenRawSvgScreenshotStrokes(svg: string, minStrokeWidth: number): string {
  const minStrokeWidthText = formatSvgNumber(minStrokeWidth);
  const svgNumber = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const cssStrokeWidth = new RegExp(`(\\bstroke-width\\s*:\\s*)(${svgNumber})(?!\\s*[a-zA-Z%])`, 'gi');
  const attrStrokeWidth = new RegExp(`(\\bstroke-width\\s*=\\s*)(["'])(${svgNumber})(?!\\s*[a-zA-Z%])\\2`, 'gi');

  return svg
    .replace(cssStrokeWidth, (match, prefix: string, rawWidth: string) =>
      rawSvgStrokeWidthReplacement(match, prefix, '', rawWidth, minStrokeWidth, minStrokeWidthText))
    .replace(attrStrokeWidth, (match, prefix: string, quote: string, rawWidth: string) =>
      rawSvgStrokeWidthReplacement(match, prefix, quote, rawWidth, minStrokeWidth, minStrokeWidthText));
}

function rawSvgStrokeWidthReplacement(
  match: string,
  prefix: string,
  quote: string,
  rawWidth: string,
  minStrokeWidth: number,
  minStrokeWidthText: string,
): string {
  const width = Number(rawWidth);
  if (!Number.isFinite(width) || width <= 0 || width >= minStrokeWidth) return match;
  return quote ? `${prefix}${quote}${minStrokeWidthText}${quote}` : `${prefix}${minStrokeWidthText}`;
}

function formatSvgNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}
