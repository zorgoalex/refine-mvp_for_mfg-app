import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusColorPicker, StatusColorSwatch } from './StatusColor';
import { normalizeStatusColor } from './statusColorUtils';

const STATUS_REFERENCE_PAGES = [
  'order_statuses',
  'payment_statuses',
  'production_statuses',
];

describe('status color UI', () => {
  it('keeps form values as normalized hexadecimal strings', () => {
    expect(normalizeStatusColor('#ff5733')).toBe('#FF5733');
    expect(normalizeStatusColor('  #1677ff  ')).toBe('#1677FF');
    expect(normalizeStatusColor('#fff')).toBeUndefined();
    expect(normalizeStatusColor('red')).toBeUndefined();
    expect(normalizeStatusColor(null)).toBeUndefined();
  });

  it('renders a native color picker backed by the string value', () => {
    const markup = renderToStaticMarkup(<StatusColorPicker value="#ff5733" />);

    expect(markup).toContain('type="color"');
    expect(markup).toContain('value="#FF5733"');
    expect(markup).toContain('#FF5733');
  });

  it('renders a compact circular swatch with an accessible color label', () => {
    const markup = renderToStaticMarkup(<StatusColorSwatch value="#ff5733" />);
    const styles = readFileSync('src/components/StatusColor.css', 'utf8');

    expect(markup).toContain('status-color-swatch');
    expect(markup).toContain('background-color:#FF5733');
    expect(markup).toContain('Цвет статуса #FF5733');
    expect(styles).toMatch(/\.status-color-swatch\s*\{[^}]*border-radius:\s*50%/s);
  });

  it.each(STATUS_REFERENCE_PAGES)('%s uses shared color UI on all CRUD pages', (directory) => {
    const base = `src/pages/${directory}`;

    expect(readFileSync(`${base}/create.tsx`, 'utf8')).toContain('StatusColorFormItem');
    expect(readFileSync(`${base}/edit.tsx`, 'utf8')).toContain('StatusColorFormItem');
    expect(readFileSync(`${base}/list.tsx`, 'utf8')).toContain('StatusColorSwatch');
    expect(readFileSync(`${base}/show.tsx`, 'utf8')).toContain('StatusColorSwatch');
  });
});

