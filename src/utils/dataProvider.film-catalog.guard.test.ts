import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./dataProvider.ts', import.meta.url), 'utf8');

describe('films backend-owned payload guard', () => {
  it('strips canonical and catalog identity only from films create/update payloads', () => {
    expect(source).toContain('resource === "films" ? stripFilmCatalogOwnedFields(restVars) : restVars');
    expect(source).toContain('resource === "films" ? stripFilmCatalogOwnedFields(rest) : rest');
    expect(source).toMatch(/canonical_film_id:\s*_canonicalFilmId/);
    expect(source).toMatch(/catalog_key:\s*_catalogKey/);
    expect(source).toMatch(/ref_key_1c:\s*_refKey1c/);
  });

  it('does not force is_active=true when films are looked up by explicit id(s)', () => {
    expect(source).toContain('resource === "films"\n        && enhancedFilters.some((f: any) => f.field === "film_id" && (f.operator === "eq" || f.operator === "in"))');
    expect(source).toContain('if (ACTIVE_FILTERED_RESOURCES.includes(resource) && !isFilmIdLookup)');
  });

});
