import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PopconfirmContent } from './PopconfirmContent';

describe('PopconfirmContent', () => {
  it('renders both texts with wrapping and distinct emphasis', () => {
    const html = renderToStaticMarkup(<PopconfirmContent title="Удалить?" description="Это действие необратимо." />);
    expect(html).toContain('Удалить?');
    expect(html).toContain('Это действие необратимо.');
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain('white-space:normal');
    expect(html).toContain('font-weight:600');
    expect(html).toContain('font-weight:400');
  });

  it('escapes dynamic names instead of interpreting HTML', () => {
    const name = '<img src=x onerror=alert(1)>';
    const html = renderToStaticMarkup(<PopconfirmContent title={name} description={`«${name}» будет удалён`} />);
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img/g)).toHaveLength(2);
  });

  it('accepts React nodes without converting them to strings', () => {
    const html = renderToStaticMarkup(<PopconfirmContent title={<span>Заказ</span>} description={<>Позиция <strong>42</strong></>} />);
    expect(html).toContain('<span>Заказ</span>');
    expect(html).toContain('<strong>42</strong>');
    expect(html).not.toContain('[object Object]');
  });
});
