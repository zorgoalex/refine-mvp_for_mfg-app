export type LabelEditorLayoutMode = 'balanced' | 'large-preview';

export const DEFAULT_LABEL_EDITOR_LAYOUT_MODE: LabelEditorLayoutMode = 'balanced';

export interface LabelEditorLayoutGeometry {
  leftColumnSpan: number;
  rightColumnSpan: number;
  initialZoom: number;
  fitPreviewToColumn: boolean;
}

const LABEL_EDITOR_LAYOUT_GEOMETRY: Record<LabelEditorLayoutMode, LabelEditorLayoutGeometry> = {
  balanced: {
    leftColumnSpan: 14,
    rightColumnSpan: 10,
    initialZoom: 0.6,
    fitPreviewToColumn: false,
  },
  'large-preview': {
    leftColumnSpan: 8,
    rightColumnSpan: 16,
    initialZoom: 1,
    fitPreviewToColumn: true,
  },
};

interface LayoutPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function labelEditorLayoutPreferenceKey(userId: string | number): string {
  return `labels:template-editor-layout:v1:${userId}`;
}

export function parseLabelEditorLayoutMode(value: unknown): LabelEditorLayoutMode | null {
  return value === 'balanced' || value === 'large-preview' ? value : null;
}

export function labelEditorLayoutGeometry(mode: LabelEditorLayoutMode): LabelEditorLayoutGeometry {
  return LABEL_EDITOR_LAYOUT_GEOMETRY[mode];
}

export function resolveLabelPreviewWidth(input: {
  intrinsicWidth: number;
  availableWidth: number;
  zoom: number;
  fitToContainer: boolean;
}): number {
  const baseWidth = input.fitToContainer && input.availableWidth > 0
    ? input.availableWidth
    : input.intrinsicWidth;
  return Math.max(1, Math.round(baseWidth * input.zoom));
}

export function loadLabelEditorLayoutMode(
  userId: string | number,
  storage?: LayoutPreferenceStorage,
): LabelEditorLayoutMode {
  try {
    const targetStorage = storage ?? globalThis.localStorage;
    return parseLabelEditorLayoutMode(targetStorage?.getItem(labelEditorLayoutPreferenceKey(userId)))
      ?? DEFAULT_LABEL_EDITOR_LAYOUT_MODE;
  } catch {
    return DEFAULT_LABEL_EDITOR_LAYOUT_MODE;
  }
}

export function saveLabelEditorLayoutMode(
  userId: string | number,
  mode: LabelEditorLayoutMode,
  storage?: LayoutPreferenceStorage,
): void {
  try {
    const targetStorage = storage ?? globalThis.localStorage;
    targetStorage?.setItem(labelEditorLayoutPreferenceKey(userId), mode);
  } catch {
    // Private mode or exhausted quota: keep current in-memory choice.
  }
}
