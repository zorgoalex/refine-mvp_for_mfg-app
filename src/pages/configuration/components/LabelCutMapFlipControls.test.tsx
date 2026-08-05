import React, { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LabelCutMapFlipControls } from './LabelCutMapFlipControls';
import type { LabelCutMapStyle } from './labelCutMapStyle';

const style = (flipHorizontal: boolean, flipVertical: boolean): LabelCutMapStyle => ({
  version: 1,
  fit: 'contain',
  highlightFill: '#ffd666',
  highlightStroke: '#d4380d',
  flipHorizontal,
  flipVertical,
});

function flipButtons(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(flipButtons);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const current = element.props['data-label-cut-map-flip'] ? [element] : [];
  return [...current, ...flipButtons(element.props.children as ReactNode)];
}

describe('LabelCutMapFlipControls', () => {
  it('exposes independent pressed states and dispatches both axes', () => {
    const onToggle = vi.fn();
    const controls = LabelCutMapFlipControls({
      cutMapStyle: style(true, false),
      disabled: false,
      variant: 'icons',
      onToggle,
    });
    const [horizontal, vertical] = flipButtons(controls);

    expect(horizontal.props).toMatchObject({
      'aria-pressed': true,
      'data-label-cut-map-flip': 'horizontal',
      type: 'primary',
      disabled: false,
    });
    expect(vertical.props).toMatchObject({
      'aria-pressed': false,
      'data-label-cut-map-flip': 'vertical',
      type: 'default',
      disabled: false,
    });

    (horizontal.props.onClick as () => void)();
    (vertical.props.onClick as () => void)();
    expect(onToggle.mock.calls).toEqual([['horizontal'], ['vertical']]);
  });

  it('disables both controls for locked or read-only surfaces', () => {
    const controls = LabelCutMapFlipControls({
      cutMapStyle: style(false, true),
      disabled: true,
      variant: 'words',
      onToggle: vi.fn(),
    });
    expect(flipButtons(controls).map((button) => button.props.disabled)).toEqual([true, true]);
  });
});
