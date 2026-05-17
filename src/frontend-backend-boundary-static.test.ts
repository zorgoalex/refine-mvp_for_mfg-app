import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');
const ALLOWED_RAW_API_PATH_MODULES = new Set([
  'src/api/apiRoutes.ts',
  'src/api/legacyApiRoutes.ts',
]);

const ROOT_UNVERSIONED_API_PATH_PATTERN =
  /(?:^|[\s'"`(])(?<path>\/api\/(?!v1(?:$|[\/\s'"`?#),.;:!\]}]))[^\s'"`?#),.;:!\]]+)(?=$|[\s'"`?#),.;:!\]}])/gm;

describe('frontend backend boundary static guard', () => {
  it('keeps raw unversioned API path strings isolated to legacyApiRoutes', () => {
    const offenders = listSourceFiles(SRC_ROOT)
      .filter((filePath) => filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
      .filter((filePath) => !ALLOWED_RAW_API_PATH_MODULES.has(normalize(filePath)))
      .flatMap((filePath) => findRawUnversionedApiPathMatches(filePath));

    expect(offenders).toEqual([]);
  });

  it('flags any root unversioned raw API path while allowing backend routes and imports', () => {
    const rootApi = '/api/';
    const dynamicSegment = '${resource}';

    expect(hasRawUnversionedApiPath(rootApi + 'future-endpoint')).toBe(true);
    expect(hasRawUnversionedApiPath(`fetch("${rootApi}users/create")`)).toBe(
      true,
    );
    expect(
      hasRawUnversionedApiPath(`fetch(\`${rootApi}${dynamicSegment}\`)`),
    ).toBe(true);
    expect(
      hasRawUnversionedApiPath(`fetch(\`${rootApi}${dynamicSegment}/items\`)`),
    ).toBe(true);
    expect(hasRawUnversionedApiPath(`fetch("${rootApi}v1/users")`)).toBe(false);
    expect(hasRawUnversionedApiPath(rootApi + 'v1')).toBe(false);
    expect(hasRawUnversionedApiPath(rootApi + 'v10/users')).toBe(true);
    expect(
      hasRawUnversionedApiPath("import { usersApi } from '../api/usersApi';"),
    ).toBe(false);
    expect(
      hasRawUnversionedApiPath(
        "import { legacyApiRoutes } from './api/legacyApiRoutes';",
      ),
    ).toBe(false);
  });
});

function findRawUnversionedApiPathMatches(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  return findRawUnversionedApiPathMatchesInSource(source).map(
    (path) => `${normalize(filePath)} contains raw unversioned API path ${path}`,
  );
}

function findRawUnversionedApiPathMatchesInSource(source: string): string[] {
  return Array.from(source.matchAll(ROOT_UNVERSIONED_API_PATH_PATTERN), (match) =>
    String(match.groups?.path),
  );
}

function hasRawUnversionedApiPath(source: string): boolean {
  return findRawUnversionedApiPathMatchesInSource(source).length > 0;
}

function listSourceFiles(root: string): string[] {
  return readdirSync(root).sort().flatMap((entry) => {
    const fullPath = join(root, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      return listSourceFiles(fullPath);
    }

    return [fullPath];
  });
}

function normalize(filePath: string): string {
  return relative(process.cwd(), filePath).replaceAll('\\', '/');
}
