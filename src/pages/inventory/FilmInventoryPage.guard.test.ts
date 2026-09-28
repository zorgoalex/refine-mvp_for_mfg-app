import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./FilmInventoryPage.tsx', import.meta.url), 'utf8');

describe('film inventory page guards', () => {
  it('uses inventory permissions and API only, with no direct Hasura writes', () => {
    expect(source).toContain("can('inventory.view')");
    expect(source).toContain("can('inventory.manage')");
    expect(source).toContain('inventoryApi.createImport');
    expect(source).not.toMatch(/hasura.*mutation|mutation.*hasura/i);
  });

  it('shows review states, before/after preview and negative stock confirmation', () => {
    expect(source).toContain('STOCK_WOULD_GO_NEGATIVE');
    expect(source).toContain('STOCK_DOCUMENT_UNRESOLVED');
    expect(source).toContain('Было → станет → Δ');
    expect(source).toContain('Подтвердить количество');
    expect(source).toContain('Пропустить');
  });
});
