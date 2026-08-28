import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');

describe('frontend version notice wiring', () => {
  it('renders in both workspace shells without touching route navigation', () => {
    const legacyLayout = read('./workspace/WorkspaceLayout.tsx');
    const evolutionLayout = read('../ui-evolution/shell/EvolutionWorkspaceLayout.tsx');
    const notice = read('./FrontendVersionNotice.tsx');

    expect(legacyLayout).toContain('<FrontendVersionNotice />');
    expect(evolutionLayout).toContain('<FrontendVersionNotice />');
    expect(notice).not.toMatch(/useNavigate|useBlocker|dataProvider|react-query/i);
    expect(notice).toContain('FRONTEND_VERSION_CHECK_INTERVAL_MS');
  });

  it('keeps hashed assets immutable and runtime config uncached', () => {
    const vercel = JSON.parse(read('../../vercel.json')) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const assets = vercel.headers.find((entry) => entry.source === '/assets/(.*)');
    const runtime = vercel.headers.find((entry) => entry.source === '/runtime-config.json');

    expect(assets?.headers).toContainEqual({
      key: 'Cache-Control',
      value: 'public, max-age=31536000, immutable',
    });
    expect(runtime?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store, max-age=0' });
  });
});
