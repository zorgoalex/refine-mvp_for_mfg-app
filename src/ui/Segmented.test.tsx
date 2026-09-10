import React from 'react';
import { Segmented as NativeSegmented, type SegmentedProps } from 'antd';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Segmented } from './Segmented';

describe('Segmented runtime compatibility', () => {
  it('is the native component, not a wrapper or a new forwardRef', () => {
    expect(Segmented).toBe(NativeSegmented);
  });

  const cases: SegmentedProps[] = [
    { options: ['Тест A', 'Тест B'], value: 'Тест B' },
    { options: [1, 2], defaultValue: 2 },
    { options: ['Тест A', 'Тест B'], disabled: true },
    { options: [{ value: 'A', label: <strong>Тест A</strong> }, { value: 'B', label: 'Тест B', disabled: true }] },
    { options: [{ value: 'A', icon: <span>Тест</span> }], block: true, size: 'small' },
    { options: ['Тест'], size: 'large', 'aria-label': 'Тест', className: 'test-control' },
  ];
  it.each(cases)('preserves native HTML for %j', props => {
    // createElement's runtime path lets us compare the broken native declaration
    // without adding fake handlers or weakening the public adapter contract.
    const native = React.createElement(NativeSegmented, props as React.ComponentProps<typeof NativeSegmented>);
    expect(renderToStaticMarkup(<Segmented {...props} />)).toBe(renderToStaticMarkup(native));
  });
});
