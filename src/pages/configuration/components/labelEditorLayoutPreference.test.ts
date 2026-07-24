import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LABEL_EDITOR_LAYOUT_MODE,
  labelEditorLayoutGeometry,
  labelEditorLayoutPreferenceKey,
  loadLabelEditorLayoutMode,
  parseLabelEditorLayoutMode,
  resolveLabelPreviewWidth,
  saveLabelEditorLayoutMode,
} from './labelEditorLayoutPreference';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('label editor layout preference', () => {
  it('uses a versioned user-scoped storage key', () => {
    expect(labelEditorLayoutPreferenceKey(42)).toBe('labels:template-editor-layout:v1:42');
    expect(labelEditorLayoutPreferenceKey('manager')).toBe('labels:template-editor-layout:v1:manager');
  });

  it('accepts only supported layout modes', () => {
    expect(parseLabelEditorLayoutMode('balanced')).toBe('balanced');
    expect(parseLabelEditorLayoutMode('large-preview')).toBe('large-preview');
    expect(parseLabelEditorLayoutMode('wide')).toBeNull();
  });

  it('makes the large preview column twice as wide and fits the canvas to it', () => {
    expect(labelEditorLayoutGeometry('balanced')).toEqual({
      leftColumnSpan: 14,
      rightColumnSpan: 10,
      initialZoom: 0.6,
      fitPreviewToColumn: false,
    });
    expect(labelEditorLayoutGeometry('large-preview')).toEqual({
      leftColumnSpan: 8,
      rightColumnSpan: 16,
      initialZoom: 1,
      fitPreviewToColumn: true,
    });
    expect(resolveLabelPreviewWidth({
      intrinsicWidth: 595,
      availableWidth: 880,
      zoom: 1,
      fitToContainer: true,
    })).toBe(880);
    expect(resolveLabelPreviewWidth({
      intrinsicWidth: 595,
      availableWidth: 880,
      zoom: 0.6,
      fitToContainer: false,
    })).toBe(357);
  });

  it('loads and saves the last layout for one user without affecting another', () => {
    const storage = memoryStorage();

    saveLabelEditorLayoutMode(7, 'large-preview', storage);

    expect(loadLabelEditorLayoutMode(7, storage)).toBe('large-preview');
    expect(loadLabelEditorLayoutMode(8, storage)).toBe(DEFAULT_LABEL_EDITOR_LAYOUT_MODE);
  });

  it('falls back safely when storage is unavailable or corrupt', () => {
    const invalid = memoryStorage({ [labelEditorLayoutPreferenceKey(7)]: 'broken' });
    const unavailable = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };

    expect(loadLabelEditorLayoutMode(7, invalid)).toBe(DEFAULT_LABEL_EDITOR_LAYOUT_MODE);
    expect(loadLabelEditorLayoutMode(7, unavailable)).toBe(DEFAULT_LABEL_EDITOR_LAYOUT_MODE);
    expect(() => saveLabelEditorLayoutMode(7, 'large-preview', unavailable)).not.toThrow();
  });
});
