import type { LabelTemplateElement } from '../../../api/types/labelsApi.types';

export interface LabelCutMapStyle {
  version: 1;
  fit: 'contain';
  highlightFill: string;
  highlightStroke: string;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

const DEFAULT_CUT_MAP_STYLE: LabelCutMapStyle = {
  version: 1,
  fit: 'contain',
  highlightFill: '#ffd666',
  highlightStroke: '#d4380d',
  flipHorizontal: false,
  flipVertical: false,
};

export function readLabelCutMapStyle(element: LabelTemplateElement): LabelCutMapStyle {
  const raw = asRecord(asRecord(element.style)?.cutMap);
  return {
    version: 1,
    fit: 'contain',
    highlightFill: typeof raw?.highlightFill === 'string'
      ? raw.highlightFill
      : DEFAULT_CUT_MAP_STYLE.highlightFill,
    highlightStroke: typeof raw?.highlightStroke === 'string'
      ? raw.highlightStroke
      : DEFAULT_CUT_MAP_STYLE.highlightStroke,
    flipHorizontal: raw?.flipHorizontal === true,
    flipVertical: raw?.flipVertical === true,
  };
}

export function withLabelCutMapFlip(
  element: LabelTemplateElement,
  patch: Partial<Pick<LabelCutMapStyle, 'flipHorizontal' | 'flipVertical'>>,
): LabelTemplateElement {
  const cutMap = { ...readLabelCutMapStyle(element), ...patch };
  return {
    ...element,
    style: {
      ...(element.style ?? {}),
      cutMap,
    },
  };
}

export function toggleLabelCutMapFlip(
  element: LabelTemplateElement,
  axis: 'horizontal' | 'vertical',
): LabelTemplateElement {
  const cutMap = readLabelCutMapStyle(element);
  return withLabelCutMapFlip(element, axis === 'horizontal'
    ? { flipHorizontal: !cutMap.flipHorizontal }
    : { flipVertical: !cutMap.flipVertical });
}

export function labelCutMapPreviewTransform(
  style: Pick<LabelCutMapStyle, 'flipHorizontal' | 'flipVertical'>,
  width: number,
  height: number,
): { x: number; y: number; scaleX: 1 | -1; scaleY: 1 | -1 } {
  return {
    x: style.flipHorizontal ? width : 0,
    y: style.flipVertical ? height : 0,
    scaleX: style.flipHorizontal ? -1 : 1,
    scaleY: style.flipVertical ? -1 : 1,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
