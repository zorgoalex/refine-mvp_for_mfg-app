import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const metadata = JSON.parse(
  readFileSync(new URL('./metadata.json', import.meta.url), 'utf8'),
);
const appSettings = metadata.sources
  .flatMap((source: any) => source.tables)
  .find((entry: any) => entry.table.name === 'app_settings');

describe('app_settings Hasura permissions', () => {
  it('does not define permissions for Hasura reserved admin role', () => {
    for (const permissionType of [
      'select_permissions',
      'insert_permissions',
      'update_permissions',
      'delete_permissions',
    ]) {
      expect(
        (appSettings[permissionType] ?? []).some((entry: any) => entry.role === 'admin'),
        `${permissionType} cannot include reserved admin role`,
      ).toBe(false);
    }
  });

  it('lets restricted roles read only the navigation visibility row', () => {
    for (const role of ['operator', 'worker', 'packer', 'viewer']) {
      const selectPermission = appSettings.select_permissions.find(
        (entry: any) => entry.role === role,
      );

      expect(selectPermission?.permission).toMatchObject({
        columns: '*',
        filter: {
          setting_key: { _eq: 'navigation.resource_visibility_by_role' },
        },
      });

      for (const permissionType of [
        'insert_permissions',
        'update_permissions',
        'delete_permissions',
      ]) {
        expect(
          (appSettings[permissionType] ?? []).some((entry: any) => entry.role === role),
          `${permissionType} must not grant ${role} writes`,
        ).toBe(false);
      }
    }
  });
});
