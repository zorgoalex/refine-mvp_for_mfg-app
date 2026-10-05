import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./CatalogImportPage.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../../api/filmCatalogImportApi.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../../App.tsx', import.meta.url), 'utf8');

describe('film catalog import frontend guard', () => {
  it('keeps all catalog writes behind backend API and sends idempotency keys', () => {
    expect(page).toContain("from '../../../api/filmCatalogImportApi'");
    expect(page).not.toMatch(/hasura|graphql|dataProvider/i);
    expect(api).toContain("'Idempotency-Key': key");
    expect(api).toContain("source: 'file'");
    expect(readFileSync(new URL('./catalogImportHelpers.ts', import.meta.url), 'utf8')).toContain('crypto.subtle.digest');
    expect(page).toContain("await import('xlsx')");
  });

  it('gates import on runtime flag and literal references.manage; mirror on onec.view', () => {
    expect(page).toContain('features?.filmCatalogImport === true');
    expect(page).toContain('if (!featureEnabled)');
    expect(page).toContain('importManageAllowed(permissions)');
    expect(page).toContain('onecMirrorAllowed(permissions)');
    expect(app).toContain('catalog-import/:id');
  });

  it('uses shared delayed-tooltip table wrapper', () => {
    expect(page).toContain("from '../../../ui/tooltipDelay'");
    expect(page).not.toMatch(/\bTable\b[^\n]*from ['"]antd['"]/);
  });
});
