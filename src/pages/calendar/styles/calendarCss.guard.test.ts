import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'calendar.css'), 'utf8');

describe('calendar material badges CSS', () => {
  it('keeps material badge text readable in dark theme on light material colors', () => {
    expect(css).toContain('[data-theme="dark"] .order-card__material-tag');
    expect(css).toMatch(/\[data-theme="dark"\]\s+\.order-card__material-tag\s*\{[^}]*color:\s*#111318\s*!important;/s);
  });
});
