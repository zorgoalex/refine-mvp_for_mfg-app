import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LabelSvgPreviewFrame } from './LabelSvgPreviewFrame';

describe('LabelSvgPreviewFrame', () => {
  it('renders SVG inside a neutral inset outline without changing dimensions', () => {
    const html = renderToStaticMarkup(
      <LabelSvgPreviewFrame svg='<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' />,
    );

    expect(html).toContain('label-svg-preview-frame');
    expect(html).toContain('outline:1px solid var(--label-preview-outline, rgba(0,0,0,0.1))');
    expect(html).toContain('outline-offset:-1px');
    expect(html).toContain('<svg viewBox="0 0 10 10">');
  });
});
