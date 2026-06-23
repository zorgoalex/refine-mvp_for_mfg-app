import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('cut detail column', () => {
  it('order show page exposes the cut.view-gated Раскрой deep-link column', () => {
    const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
    expect(show).toContain("title: 'Раскрой'");
    expect(show).toContain('cutJobDeepLink');
    expect(show).toContain("can('cut.view')");
  });
});
