import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldCompactOrderToolbar } from './OrderDetailsToolbar';

describe('order details adaptive toolbar', () => {
  it('keeps labels when expanded content fits with the rounding tolerance', () => {
    expect(shouldCompactOrderToolbar(800, 800)).toBe(false);
    expect(shouldCompactOrderToolbar(801, 800)).toBe(false);
  });

  it('hides adaptive labels when expanded content does not fit', () => {
    expect(shouldCompactOrderToolbar(802, 800)).toBe(true);
  });

  it('keeps the measurement clone outside the accessibility tree and strips ids', () => {
    const source = readFileSync(new URL('./OrderDetailsToolbar.tsx', import.meta.url), 'utf8');
    expect(source).toContain("clone.setAttribute('aria-hidden', 'true')");
    expect(source).toContain("clone.setAttribute('inert', '')");
    expect(source).toContain("querySelectorAll('[id]')");
  });
});
