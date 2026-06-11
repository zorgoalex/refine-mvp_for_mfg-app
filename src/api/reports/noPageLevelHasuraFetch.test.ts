import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') || p.endsWith('.ts') ? [p] : [];
  });
}

describe('no page-level Hasura fetch', () => {
  it('src/pages contains no direct fetch to VITE_HASURA_GRAPHQL_URL', () => {
    const offenders = walk('src/pages').filter((file) => {
      const src = readFileSync(file, 'utf8');
      // a direct page-level Hasura fetch is fetch(...) referencing the Hasura URL env
      return /fetch\(\s*`?\$\{?\s*import\.meta\.env\.VITE_HASURA_GRAPHQL_URL/.test(src)
        || /VITE_HASURA_GRAPHQL_URL[\s\S]{0,200}?fetch\(/.test(src);
    });
    expect(offenders, `Move these Hasura reads into src/api/reports/*: ${offenders.join(', ')}`).toEqual([]);
  });
});
