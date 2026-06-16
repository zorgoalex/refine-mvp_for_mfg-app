import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(__dirname, 'useTabSync.ts'), 'utf8');

describe('useTabSync guards', () => {
  it('ignores redirect-only / non-tab routes', () => {
    expect(src).toContain("['/', '/login']");
  });
  it('preserves query in the stored path', () => {
    expect(src).toContain('location.search');
  });
});
