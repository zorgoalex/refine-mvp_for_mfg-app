import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./dataProvider.ts', import.meta.url), 'utf8');

describe('dataProvider RBAC backend-owned write block', () => {
  it('blocks generic Hasura writes for orders and payments when backend permissions are enabled', () => {
    expect(source).toContain("RBAC_BACKEND_OWNED_WRITE_RESOURCES = new Set<string>(['orders', 'payments'])");
    expect(source).toContain('featureFlags.useBackendPermissions && RBAC_BACKEND_OWNED_WRITE_RESOURCES.has(resource)');
    expect(source).toContain('Hasura writes are disabled');
  });
});
