import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'App.tsx'), 'utf8');

// Guard: route/page components must be loaded via React.lazy so the root bundle
// ships only shell/providers/login. Regressing to static page imports re-inflates
// the entry chunk. (Vendor-chunk size is a separate concern; manual chunking is
// intentionally avoided because it previously caused runtime ordering issues.)
describe('App.tsx route-level code splitting', () => {
  it('lazy-loads page components (many lazy() boundaries)', () => {
    const lazyCount = (source.match(/=\s*lazy\(/g) || []).length;
    expect(lazyCount).toBeGreaterThan(50);
  });

  it('wraps routes in a Suspense boundary', () => {
    expect(source).toContain('Suspense');
  });

  it('does not statically import page components except the eager login page', () => {
    const staticPageImports = source
      .split('\n')
      .filter((line) => /^import\s.*from\s+["']\.\/pages\//.test(line))
      .filter((line) => !/\.\/pages\/login/.test(line));
    expect(staticPageImports).toEqual([]);
  });
});
