export const CUT_RENDER_STYLE_DEFAULT = 'default';
export const CUT_RENDER_STYLE_MDF_BOARD_PREVIEW = 'mdf_board_preview';
export const CUT_RENDER_STYLES_SETTING_KEY = 'render.styles';

export type CutRenderStyleName =
  | typeof CUT_RENDER_STYLE_DEFAULT
  | typeof CUT_RENDER_STYLE_MDF_BOARD_PREVIEW;

export interface CutRenderStyleProfile {
  piece: {
    defaultFill: string;
    stroke: string;
    strokeWidthMm: number;
    orderPalette: readonly string[];
  };
  label: {
    fillStrategy: 'fixed' | 'contrast';
    darkFill: string;
    darkTextStroke: string;
    darkTextStrokeWidthRatio: number;
    lightFill: string;
    lightTextStroke: string;
    lightTextStrokeWidthRatio: number;
    fontWeight: number;
  };
  sourceSvg: {
    minStrokePx: number | null;
    nonScalingStroke: boolean;
    strokeColorMode: 'preserve' | 'piece-pastel' | 'fixed';
    fixedStroke: string;
    strokeOpacity: number;
    pastelSaturationPercent: number;
    pastelLightnessPercent: number;
  };
  rawSvgScreenshot: {
    minStrokePx: number;
  };
}

export interface CutRenderStyleRule extends CutRenderStyleProfile {
  id: CutRenderStyleName;
}

export interface CutRenderStylesSetting {
  version: 1;
  profiles: Record<CutRenderStyleName, CutRenderStyleProfile>;
}

export class CutRenderStyleValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'CutRenderStyleValidationError';
  }
}

const ORDER_FILL_PALETTE = [
  '#d7e9ff',
  '#dff3d7',
  '#ffe6b8',
  '#f7d5e8',
  '#d9f0ef',
  '#eadcff',
  '#ffe0d2',
  '#e8edc9',
  '#d5e5f2',
  '#f2ddd5',
] as const;

const CUT_RENDER_STYLE_NAMES = [
  CUT_RENDER_STYLE_DEFAULT,
  CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
] as const;

const CUT_RENDER_STYLE_PROFILES = {
  [CUT_RENDER_STYLE_DEFAULT]: {
    piece: {
      defaultFill: '#eef3f8',
      stroke: '#1f2d3d',
      strokeWidthMm: 2,
      orderPalette: ORDER_FILL_PALETTE,
    },
    label: {
      fillStrategy: 'fixed',
      darkFill: '#1f2d3d',
      darkTextStroke: '#ffffff',
      darkTextStrokeWidthRatio: 0,
      lightFill: '#ffffff',
      lightTextStroke: '#111827',
      lightTextStrokeWidthRatio: 0,
      fontWeight: 500,
    },
    sourceSvg: {
      minStrokePx: null,
      nonScalingStroke: false,
      strokeColorMode: 'preserve',
      fixedStroke: '#111827',
      strokeOpacity: 1,
      pastelSaturationPercent: 55,
      pastelLightnessPercent: 58,
    },
    rawSvgScreenshot: {
      minStrokePx: 2.4,
    },
  },
  [CUT_RENDER_STYLE_MDF_BOARD_PREVIEW]: {
    piece: {
      defaultFill: '#eef3f8',
      stroke: '#1f2d3d',
      strokeWidthMm: 1.6,
      orderPalette: ORDER_FILL_PALETTE,
    },
    label: {
      fillStrategy: 'contrast',
      darkFill: '#111827',
      darkTextStroke: '#ffffff',
      darkTextStrokeWidthRatio: 0.08,
      lightFill: '#ffffff',
      lightTextStroke: '#111827',
      lightTextStrokeWidthRatio: 0.08,
      fontWeight: 800,
    },
    sourceSvg: {
      minStrokePx: 1.6,
      nonScalingStroke: true,
      strokeColorMode: 'piece-pastel',
      fixedStroke: '#6ea7c8',
      strokeOpacity: 0.72,
      pastelSaturationPercent: 56,
      pastelLightnessPercent: 56,
    },
    rawSvgScreenshot: {
      minStrokePx: 2,
    },
  },
} as const satisfies Record<CutRenderStyleName, CutRenderStyleProfile>;

export const CUT_RENDER_STYLE_RULES: Record<CutRenderStyleName, CutRenderStyleRule> = {
  [CUT_RENDER_STYLE_DEFAULT]: cutRenderStyleRuleFromProfile(
    CUT_RENDER_STYLE_DEFAULT,
    CUT_RENDER_STYLE_PROFILES[CUT_RENDER_STYLE_DEFAULT],
  ),
  [CUT_RENDER_STYLE_MDF_BOARD_PREVIEW]: cutRenderStyleRuleFromProfile(
    CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
    CUT_RENDER_STYLE_PROFILES[CUT_RENDER_STYLE_MDF_BOARD_PREVIEW],
  ),
};

export const DEFAULT_CUT_RENDER_STYLES_SETTING: CutRenderStylesSetting = {
  version: 1,
  profiles: {
    [CUT_RENDER_STYLE_DEFAULT]: cutRenderStyleProfileJson(CUT_RENDER_STYLE_RULES[CUT_RENDER_STYLE_DEFAULT]),
    [CUT_RENDER_STYLE_MDF_BOARD_PREVIEW]: cutRenderStyleProfileJson(
      CUT_RENDER_STYLE_RULES[CUT_RENDER_STYLE_MDF_BOARD_PREVIEW],
    ),
  },
};

export type CutRenderStyleRef = string | CutRenderStyleRule | null | undefined;

export function normalizeCutRenderStyleName(value: string | null | undefined): CutRenderStyleName {
  const normalized = value?.trim().toLowerCase();
  return normalized === CUT_RENDER_STYLE_MDF_BOARD_PREVIEW
    ? CUT_RENDER_STYLE_MDF_BOARD_PREVIEW
    : CUT_RENDER_STYLE_DEFAULT;
}

export function resolveCutRenderStyle(value: CutRenderStyleRef): CutRenderStyleRule {
  if (isCutRenderStyleRule(value)) {
    return cutRenderStyleRuleFromProfile(value.id, value);
  }
  return CUT_RENDER_STYLE_RULES[normalizeCutRenderStyleName(value)];
}

export function resolveCutRenderStyleFromSetting(
  value: string | null | undefined,
  settingValue: unknown,
): CutRenderStyleRule {
  const styleName = normalizeCutRenderStyleName(value);
  const setting = settingValue === null || settingValue === undefined
    ? DEFAULT_CUT_RENDER_STYLES_SETTING
    : parseCutRenderStylesSetting(settingValue);
  return cutRenderStyleRuleFromProfile(styleName, setting.profiles[styleName]);
}

export function parseCutRenderStylesSetting(value: unknown): CutRenderStylesSetting {
  const root = requireObject(value, 'value');
  const version = root.version;
  if (version !== 1) {
    throw new CutRenderStyleValidationError('version', 'render.styles.version должен быть 1');
  }
  const profilesRoot = requireObject(root.profiles, 'profiles');
  const unknownKeys = Object.keys(profilesRoot).filter((key) => !isCutRenderStyleName(key));
  if (unknownKeys.length > 0) {
    throw new CutRenderStyleValidationError(
      'profiles',
      `render.styles.profiles содержит неизвестные профили: ${unknownKeys.join(', ')}`,
    );
  }

  return {
    version: 1,
    profiles: {
      [CUT_RENDER_STYLE_DEFAULT]: parseCutRenderStyleProfile(
        profilesRoot[CUT_RENDER_STYLE_DEFAULT],
        CUT_RENDER_STYLE_RULES[CUT_RENDER_STYLE_DEFAULT],
        `profiles.${CUT_RENDER_STYLE_DEFAULT}`,
      ),
      [CUT_RENDER_STYLE_MDF_BOARD_PREVIEW]: parseCutRenderStyleProfile(
        profilesRoot[CUT_RENDER_STYLE_MDF_BOARD_PREVIEW],
        CUT_RENDER_STYLE_RULES[CUT_RENDER_STYLE_MDF_BOARD_PREVIEW],
        `profiles.${CUT_RENDER_STYLE_MDF_BOARD_PREVIEW}`,
      ),
    },
  };
}

export function cutRenderStyleProfileJson(rule: CutRenderStyleRule | CutRenderStyleProfile): CutRenderStyleProfile {
  return {
    piece: {
      defaultFill: rule.piece.defaultFill,
      stroke: rule.piece.stroke,
      strokeWidthMm: rule.piece.strokeWidthMm,
      orderPalette: [...rule.piece.orderPalette],
    },
    label: {
      fillStrategy: rule.label.fillStrategy,
      darkFill: rule.label.darkFill,
      darkTextStroke: rule.label.darkTextStroke,
      darkTextStrokeWidthRatio: rule.label.darkTextStrokeWidthRatio,
      lightFill: rule.label.lightFill,
      lightTextStroke: rule.label.lightTextStroke,
      lightTextStrokeWidthRatio: rule.label.lightTextStrokeWidthRatio,
      fontWeight: rule.label.fontWeight,
    },
    sourceSvg: {
      minStrokePx: rule.sourceSvg.minStrokePx,
      nonScalingStroke: rule.sourceSvg.nonScalingStroke,
      strokeColorMode: rule.sourceSvg.strokeColorMode,
      fixedStroke: rule.sourceSvg.fixedStroke,
      strokeOpacity: rule.sourceSvg.strokeOpacity,
      pastelSaturationPercent: rule.sourceSvg.pastelSaturationPercent,
      pastelLightnessPercent: rule.sourceSvg.pastelLightnessPercent,
    },
    rawSvgScreenshot: {
      minStrokePx: rule.rawSvgScreenshot.minStrokePx,
    },
  };
}

export function cutRenderOrderFillPalette(value: CutRenderStyleRef): readonly string[] {
  return resolveCutRenderStyle(value).piece.orderPalette;
}

export function cutRenderLabelFillForBackground(
  backgroundFill: string,
  value: CutRenderStyleRef,
): string {
  const style = resolveCutRenderStyle(value);
  if (style.label.fillStrategy !== 'contrast') return style.label.darkFill;
  const darkContrast = contrastRatio(backgroundFill, style.label.darkFill);
  const lightContrast = contrastRatio(backgroundFill, style.label.lightFill);
  return lightContrast > darkContrast ? style.label.lightFill : style.label.darkFill;
}

export function cutRenderLabelStrokeForBackground(
  backgroundFill: string,
  fontMm: number,
  value: CutRenderStyleRef,
): { stroke: string; strokeWidthMm: number } | null {
  const style = resolveCutRenderStyle(value);
  const fill = cutRenderLabelFillForBackground(backgroundFill, style);
  const stroke = fill === style.label.lightFill ? style.label.lightTextStroke : style.label.darkTextStroke;
  const ratio = fill === style.label.lightFill
    ? style.label.lightTextStrokeWidthRatio
    : style.label.darkTextStrokeWidthRatio;
  if (ratio <= 0) return null;
  return {
    stroke,
    strokeWidthMm: fontMm * ratio,
  };
}

export function cutRenderLabelFontWeight(value: CutRenderStyleRef): number {
  return resolveCutRenderStyle(value).label.fontWeight;
}

export function cutRenderSourceSvgCss(value: CutRenderStyleRef, pieceFill?: string | null): string {
  const style = resolveCutRenderStyle(value);
  const minStrokePx = style.sourceSvg.minStrokePx;
  const declarations: string[] = [];
  if (minStrokePx !== null) declarations.push(`stroke-width:${formatNumber(minStrokePx)}px!important`);
  const sourceStroke = cutRenderSourceSvgStroke(style, pieceFill);
  if (sourceStroke) {
    declarations.push(`stroke:${sourceStroke}!important`);
    declarations.push('fill:none!important');
  }
  if (style.sourceSvg.strokeOpacity < 1) {
    declarations.push(`stroke-opacity:${formatNumber(style.sourceSvg.strokeOpacity)}!important`);
  }
  const vectorEffect = style.sourceSvg.nonScalingStroke
    ? 'vector-effect:non-scaling-stroke!important'
    : '';
  if (vectorEffect) declarations.push(vectorEffect);
  if (declarations.length === 0) return '';
  return `.cut-sheet-piece-source-svg *{${declarations.join(';')};}`;
}

export function cutRenderRawSvgScreenshotMinStrokePx(value: CutRenderStyleRef): number {
  return resolveCutRenderStyle(value).rawSvgScreenshot.minStrokePx;
}

function cutRenderSourceSvgStroke(style: CutRenderStyleRule, pieceFill: string | null | undefined): string | null {
  if (style.sourceSvg.strokeColorMode === 'preserve') return null;
  if (style.sourceSvg.strokeColorMode === 'fixed') return style.sourceSvg.fixedStroke;
  return sourceSvgPastelStrokeForPieceFill(pieceFill, style) ?? style.sourceSvg.fixedStroke;
}

function sourceSvgPastelStrokeForPieceFill(
  pieceFill: string | null | undefined,
  style: CutRenderStyleRule,
): string | null {
  if (!pieceFill) return null;
  const rgb = parseHexColor(pieceFill);
  if (!rgb) return null;
  const hsl = rgbToHsl(rgb);
  if (hsl.s < 0.03) return null;
  return hslToHex({
    h: hsl.h,
    s: style.sourceSvg.pastelSaturationPercent / 100,
    l: style.sourceSvg.pastelLightnessPercent / 100,
  });
}

function parseCutRenderStyleProfile(
  value: unknown,
  fallback: CutRenderStyleRule,
  path: string,
): CutRenderStyleProfile {
  const input = value === undefined ? {} : requireObject(value, path);
  const piece = optionalObject(input.piece, `${path}.piece`);
  const label = optionalObject(input.label, `${path}.label`);
  const sourceSvg = optionalObject(input.sourceSvg, `${path}.sourceSvg`);
  const rawSvgScreenshot = optionalObject(input.rawSvgScreenshot, `${path}.rawSvgScreenshot`);
  return {
    piece: {
      defaultFill: parseHexColorField(piece.defaultFill, fallback.piece.defaultFill, `${path}.piece.defaultFill`),
      stroke: parseHexColorField(piece.stroke, fallback.piece.stroke, `${path}.piece.stroke`),
      strokeWidthMm: parseNumberField(
        piece.strokeWidthMm,
        fallback.piece.strokeWidthMm,
        `${path}.piece.strokeWidthMm`,
        0.1,
        20,
      ),
      orderPalette: parsePaletteField(piece.orderPalette, fallback.piece.orderPalette, `${path}.piece.orderPalette`),
    },
    label: {
      fillStrategy: parseFillStrategy(label.fillStrategy, fallback.label.fillStrategy, `${path}.label.fillStrategy`),
      darkFill: parseHexColorField(label.darkFill, fallback.label.darkFill, `${path}.label.darkFill`),
      darkTextStroke: parseHexColorField(
        label.darkTextStroke,
        fallback.label.darkTextStroke,
        `${path}.label.darkTextStroke`,
      ),
      darkTextStrokeWidthRatio: parseNumberField(
        label.darkTextStrokeWidthRatio,
        fallback.label.darkTextStrokeWidthRatio,
        `${path}.label.darkTextStrokeWidthRatio`,
        0,
        0.25,
      ),
      lightFill: parseHexColorField(label.lightFill, fallback.label.lightFill, `${path}.label.lightFill`),
      lightTextStroke: parseHexColorField(
        label.lightTextStroke,
        fallback.label.lightTextStroke,
        `${path}.label.lightTextStroke`,
      ),
      lightTextStrokeWidthRatio: parseNumberField(
        label.lightTextStrokeWidthRatio,
        fallback.label.lightTextStrokeWidthRatio,
        `${path}.label.lightTextStrokeWidthRatio`,
        0,
        0.25,
      ),
      fontWeight: parseIntegerField(label.fontWeight, fallback.label.fontWeight, `${path}.label.fontWeight`, 100, 1000),
    },
    sourceSvg: {
      minStrokePx: parseNullableNumberField(
        sourceSvg.minStrokePx,
        fallback.sourceSvg.minStrokePx,
        `${path}.sourceSvg.minStrokePx`,
        0.1,
        20,
      ),
      nonScalingStroke: parseBooleanField(
        sourceSvg.nonScalingStroke,
        fallback.sourceSvg.nonScalingStroke,
        `${path}.sourceSvg.nonScalingStroke`,
      ),
      strokeColorMode: parseSourceSvgStrokeColorMode(
        sourceSvg.strokeColorMode,
        fallback.sourceSvg.strokeColorMode,
        `${path}.sourceSvg.strokeColorMode`,
      ),
      fixedStroke: parseHexColorField(
        sourceSvg.fixedStroke,
        fallback.sourceSvg.fixedStroke,
        `${path}.sourceSvg.fixedStroke`,
      ),
      strokeOpacity: parseNumberField(
        sourceSvg.strokeOpacity,
        fallback.sourceSvg.strokeOpacity,
        `${path}.sourceSvg.strokeOpacity`,
        0.05,
        1,
      ),
      pastelSaturationPercent: parseNumberField(
        sourceSvg.pastelSaturationPercent,
        fallback.sourceSvg.pastelSaturationPercent,
        `${path}.sourceSvg.pastelSaturationPercent`,
        0,
        100,
      ),
      pastelLightnessPercent: parseNumberField(
        sourceSvg.pastelLightnessPercent,
        fallback.sourceSvg.pastelLightnessPercent,
        `${path}.sourceSvg.pastelLightnessPercent`,
        0,
        100,
      ),
    },
    rawSvgScreenshot: {
      minStrokePx: parseNumberField(
        rawSvgScreenshot.minStrokePx,
        fallback.rawSvgScreenshot.minStrokePx,
        `${path}.rawSvgScreenshot.minStrokePx`,
        0.1,
        20,
      ),
    },
  };
}

function cutRenderStyleRuleFromProfile(
  id: CutRenderStyleName,
  profile: CutRenderStyleProfile,
): CutRenderStyleRule {
  return {
    id,
    ...cutRenderStyleProfileJson(profile),
  };
}

function isCutRenderStyleName(value: string): value is CutRenderStyleName {
  return (CUT_RENDER_STYLE_NAMES as readonly string[]).includes(value);
}

function isCutRenderStyleRule(value: unknown): value is CutRenderStyleRule {
  return typeof value === 'object' && value !== null && 'id' in value && 'piece' in value && 'label' in value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CutRenderStyleValidationError(field, `${field} должен быть объектом`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  return requireObject(value, field);
}

function parseHexColorField(value: unknown, fallback: string, field: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !parseHexColor(value)) {
    throw new CutRenderStyleValidationError(field, `${field} должен быть HEX-цветом`);
  }
  return normalizeHexColor(value);
}

function parsePaletteField(value: unknown, fallback: readonly string[], field: string): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    throw new CutRenderStyleValidationError(field, `${field} должен быть массивом 1..24 HEX-цветов`);
  }
  return value.map((item, index) => {
    if (item === undefined) {
      throw new CutRenderStyleValidationError(`${field}.${index}`, `${field}.${index} должен быть HEX-цветом`);
    }
    return parseHexColorField(item, '#000000', `${field}.${index}`);
  });
}

function parseFillStrategy(
  value: unknown,
  fallback: CutRenderStyleProfile['label']['fillStrategy'],
  field: string,
): CutRenderStyleProfile['label']['fillStrategy'] {
  if (value === undefined) return fallback;
  if (value !== 'fixed' && value !== 'contrast') {
    throw new CutRenderStyleValidationError(field, `${field} должен быть fixed или contrast`);
  }
  return value;
}

function parseSourceSvgStrokeColorMode(
  value: unknown,
  fallback: CutRenderStyleProfile['sourceSvg']['strokeColorMode'],
  field: string,
): CutRenderStyleProfile['sourceSvg']['strokeColorMode'] {
  if (value === undefined) return fallback;
  if (value !== 'preserve' && value !== 'piece-pastel' && value !== 'fixed') {
    throw new CutRenderStyleValidationError(field, `${field} должен быть preserve, piece-pastel или fixed`);
  }
  return value;
}

function parseNumberField(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new CutRenderStyleValidationError(field, `${field} должен быть числом ${min}..${max}`);
  }
  return Number(value.toFixed(3));
}

function parseIntegerField(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new CutRenderStyleValidationError(field, `${field} должен быть целым числом ${min}..${max}`);
  }
  return value;
}

function parseNullableNumberField(
  value: unknown,
  fallback: number | null,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  return parseNumberField(value, fallback ?? min, field, min, max);
}

function parseBooleanField(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new CutRenderStyleValidationError(field, `${field} должен быть boolean`);
  }
  return value;
}

function contrastRatio(left: string, right: string): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  const bright = Math.max(leftLuminance, rightLuminance);
  const dark = Math.min(leftLuminance, rightLuminance);
  return (bright + 0.05) / (dark + 0.05);
}

function relativeLuminance(value: string): number {
  const rgb = parseHexColor(value);
  if (!rgb) return 1;
  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function parseHexColor(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (!match?.[1]) return null;
  const hex = match[1].length === 3
    ? match[1].split('').map((char) => `${char}${char}`).join('')
    : match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function normalizeHexColor(value: string): string {
  const trimmed = value.trim();
  const hex = trimmed.length === 4
    ? trimmed.slice(1).split('').map((char) => `${char}${char}`).join('')
    : trimmed.slice(1);
  return `#${hex.toLowerCase()}`;
}

function rgbToHsl(rgb: [number, number, number]): { h: number; s: number; l: number } {
  const [rawR, rawG, rawB] = rgb;
  const r = rawR / 255;
  const g = rawG / 255;
  const b = rawB / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}

function hslToHex(hsl: { h: number; s: number; l: number }): string {
  const hueToRgb = (p: number, q: number, rawT: number): number => {
    let t = rawT;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = hsl.l < 0.5
    ? hsl.l * (1 + hsl.s)
    : hsl.l + hsl.s - hsl.l * hsl.s;
  const p = 2 * hsl.l - q;
  const rgb: [number, number, number] = hsl.s === 0
    ? [hsl.l, hsl.l, hsl.l]
    : [
        hueToRgb(p, q, hsl.h + 1 / 3),
        hueToRgb(p, q, hsl.h),
        hueToRgb(p, q, hsl.h - 1 / 3),
      ];
  return `#${rgb.map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}
