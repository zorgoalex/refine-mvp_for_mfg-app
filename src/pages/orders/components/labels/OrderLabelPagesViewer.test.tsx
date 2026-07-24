import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { clampLabelPageIndex, labelPageTitle, OrderLabelPagesViewer } from './OrderLabelPagesViewer';

describe('OrderLabelPagesViewer', () => {
  it('renders a navigable label list with print affordance', () => {
    const html = renderToStaticMarkup(
      <OrderLabelPagesViewer
        title="Сформированные бирки: 2 шт."
        svgPages={[
          '<svg viewBox="0 0 10 10"><text>1</text></svg>',
          '<svg viewBox="0 0 10 10"><text>2</text></svg>',
        ]}
      />,
    );

    expect(html).toContain('Список бирок');
    expect(html).toContain('2 шт.');
    expect(html).toContain('Список бирок слева');
    expect(html).toContain('Бирка 1');
    expect(html).toContain('Бирка 2');
    expect(html).toContain('Печать');
    expect(html).toContain('диапазон страниц');
    expect(html).toContain('label-svg-preview-frame__content');
  });

  it('clamps selected labels and formats page titles', () => {
    expect(clampLabelPageIndex(-10, 3)).toBe(0);
    expect(clampLabelPageIndex(9, 3)).toBe(2);
    expect(clampLabelPageIndex(1, 0)).toBe(0);
    expect(labelPageTitle(1, 3)).toBe('Бирка 2 из 3');
  });

  it('can be controlled by the selected label index', () => {
    const html = renderToStaticMarkup(
      <OrderLabelPagesViewer
        title="Последняя генерация: 2 шт."
        selectedIndex={1}
        svgPages={[
          '<svg viewBox="0 0 10 10"><text>page-one</text></svg>',
          '<svg viewBox="0 0 10 10"><text>page-two</text></svg>',
        ]}
      />,
    );

    expect(html).toContain('Бирка 2 из 2');
    expect(html).toContain('page-two');
    expect(html).not.toContain('page-one');
  });
});
