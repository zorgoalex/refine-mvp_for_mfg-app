import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'App.tsx'), 'utf8');
const workspaceLayoutSource = readFileSync(
  resolve(__dirname, 'components/workspace/WorkspaceLayout.tsx'),
  'utf8',
);

// Guard: route/page components must be loaded via React.lazy so the root bundle
// ships only shell/providers/login. Regressing to static page imports re-inflates
// the entry chunk. (Vendor-chunk size is a separate concern; manual chunking is
// intentionally avoided because it previously caused runtime ordering issues.)
describe('App.tsx route-level code splitting', () => {
  it('lazy-loads page components (many lazy() boundaries)', () => {
    const lazyCount = (source.match(/=\s*lazy\(/g) || []).length;
    expect(lazyCount).toBeGreaterThan(50);
  });

  it('keeps the persistent workspace shell outside the route loading boundary', () => {
    expect(source).not.toContain('<Suspense');
    expect(workspaceLayoutSource).toMatch(
      /<WorkspaceTabs\s*\/>[\s\S]*<Suspense[\s\S]*<KeepAliveOutlet\s*\/>[\s\S]*<\/Suspense>[\s\S]*<AppFooter\s*\/>/,
    );
  });

  it('shows a content skeleton while a lazy route chunk loads', () => {
    expect(workspaceLayoutSource).toContain('<WorkspaceRouteSkeleton />');
    expect(workspaceLayoutSource).toContain('<Skeleton');
    expect(workspaceLayoutSource).toContain('aria-label="Загрузка страницы"');
  });

  it('does not statically import page components except the eager login page', () => {
    const staticPageImports = source
      .split('\n')
      .filter((line) => /^import\s.*from\s+["']\.\/pages\//.test(line))
      .filter((line) => !/\.\/pages\/login/.test(line));
    expect(staticPageImports).toEqual([]);
  });

  it('warms the shared status-board chunk before MDF navigation', () => {
    expect(source).toContain('const loadOrderStatusBoardModule = () => import("./pages/orderStatusBoard")');
    expect(source).toContain('void loadOrderStatusBoardModule()');
    expect(source).toContain('(await loadOrderStatusBoardModule()).MdfWorkBoardPage');
    expect(source).toContain('cncTelegramApi.prefetchToday(mdfDefaultDateRange())');
    expect(source).toContain('module.prefetchMdfOrderStatusBoard(response)');
  });
});
