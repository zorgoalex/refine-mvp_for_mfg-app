import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./trash.tsx', import.meta.url), 'utf8');

describe('order trash guards', () => {
  it('pins backend trash list fetch, page gate, and restore wiring', () => {
    expect(source).toContain('deleted: true');
    expect(source).toContain("sortBy: 'deletedAt'");
    expect(source).toMatch(/canManageOrderTrash\s*=\s*!featureFlags\.useBackendPermissions\s*\|\|\s*can\('orders\.delete'\)/);
    expect(source).toContain('featureFlags.useBackendOrdersRead');
    expect(source).toContain('featureFlags.useBackendOrdersWrite');
    expect(source).toContain('Popconfirm');
    expect(source).toContain('ordersApi.restore');
  });
});
