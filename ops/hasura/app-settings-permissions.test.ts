import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const metadata = JSON.parse(
  readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'),
);
const appSettings = metadata.sources
  .flatMap((source: any) => source.tables)
  .find((entry: any) => entry.table.name === 'app_settings');

describe('app_settings Hasura permissions', () => {
  it('keeps the admin settings UI aligned with app_settings metadata', () => {
    for (const permissionType of [
      'select_permissions',
      'insert_permissions',
      'update_permissions',
      'delete_permissions',
    ]) {
      expect(
        (appSettings[permissionType] ?? []).some((entry: any) => entry.role === 'admin'),
        `${permissionType} must include admin`,
      ).toBe(true);
    }
  });
});
