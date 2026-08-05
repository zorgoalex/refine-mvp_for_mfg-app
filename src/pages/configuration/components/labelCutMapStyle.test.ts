import { describe, expect, it } from 'vitest';
import type { LabelTemplateElement } from '../../../api/types/labelsApi.types';
import {
  labelCutMapPreviewTransform,
  readLabelCutMapStyle,
  toggleLabelCutMapFlip,
  withLabelCutMapFlip,
} from './labelCutMapStyle';

const element = (cutMap: Record<string, unknown>): LabelTemplateElement => ({
  elementKey: 'cut-map',
  kind: 'cut_map',
  sourceField: null,
  staticText: null,
  xMm: 2,
  yMm: 3,
  widthMm: 40,
  heightMm: 28,
  style: { locked: true, cutMap },
});

describe('label cut-map style', () => {
  it('keeps historical templates unflipped by default', () => {
    expect(readLabelCutMapStyle(element({
      version: 1,
      fit: 'contain',
      highlightFill: '#ffd666',
      highlightStroke: '#d4380d',
    }))).toMatchObject({ flipHorizontal: false, flipVertical: false });
  });

  it('updates axes independently while preserving other element style metadata', () => {
    const horizontal = withLabelCutMapFlip(element({
      version: 1,
      fit: 'contain',
      highlightFill: '#ffd666',
      highlightStroke: '#d4380d',
      flipVertical: true,
    }), { flipHorizontal: true });

    expect(horizontal.style?.locked).toBe(true);
    expect(readLabelCutMapStyle(horizontal)).toMatchObject({
      flipHorizontal: true,
      flipVertical: true,
      highlightFill: '#ffd666',
      highlightStroke: '#d4380d',
    });
  });

  it('toggles and persists each axis without changing outer element geometry', () => {
    const original = element({
      version: 1,
      fit: 'contain',
      highlightFill: '#ffd666',
      highlightStroke: '#d4380d',
    });
    const horizontal = toggleLabelCutMapFlip(original, 'horizontal');
    const both = toggleLabelCutMapFlip(horizontal, 'vertical');

    expect(both).toMatchObject({ xMm: 2, yMm: 3, widthMm: 40, heightMm: 28 });
    expect(readLabelCutMapStyle(both)).toMatchObject({ flipHorizontal: true, flipVertical: true });
  });

  it('mirrors only inner canvas content around its final bounds', () => {
    expect(labelCutMapPreviewTransform({ flipHorizontal: false, flipVertical: false }, 40, 28))
      .toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
    expect(labelCutMapPreviewTransform({ flipHorizontal: true, flipVertical: false }, 40, 28))
      .toEqual({ x: 40, y: 0, scaleX: -1, scaleY: 1 });
    expect(labelCutMapPreviewTransform({ flipHorizontal: false, flipVertical: true }, 40, 28))
      .toEqual({ x: 0, y: 28, scaleX: 1, scaleY: -1 });
    expect(labelCutMapPreviewTransform({ flipHorizontal: true, flipVertical: true }, 40, 28))
      .toEqual({ x: 40, y: 28, scaleX: -1, scaleY: -1 });
  });
});
