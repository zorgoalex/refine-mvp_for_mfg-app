import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// sheet_material_types is backend-write-only. The generic Hasura mutation path in
// dataProvider must be unreachable for it (single write-path / COMMAND-OWNER).
const src = readFileSync(new URL('./dataProvider.ts', import.meta.url), 'utf8');

describe('dataProvider blocks Hasura writes for sheet_material_types', () => {
  it('registers sheet_material_types as backend-only write', () => {
    expect(src).toMatch(/BACKEND_ONLY_WRITE_RESOURCES\s*=\s*new Set<string>\(\[[^\]]*['"]sheet_material_types['"]/);
  });

  it('guards all three write methods (create/update/deleteOne)', () => {
    const callsInWrite = (method: string) => {
      // slice from the method declaration to the next dataProvider method/getOne boundary
      const start = src.indexOf(`${method}: async ({`);
      expect(start).toBeGreaterThan(-1);
      const slice = src.slice(start, start + 600);
      return /assertNotBackendOnlyWrite\(resource\)/.test(slice);
    };
    expect(callsInWrite('create')).toBe(true);
    expect(callsInWrite('update')).toBe(true);
    expect(callsInWrite('deleteOne')).toBe(true);
  });

  it('the guard throws a 403 (not a silent fall-through)', () => {
    expect(src).toMatch(/function assertNotBackendOnlyWrite[\s\S]*?statusCode:\s*403/);
  });
});
