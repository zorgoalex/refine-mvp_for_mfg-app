import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const showSource = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
const editTableSource = readFileSync(new URL('./components/tables/OrderDetailTable.tsx', import.meta.url), 'utf8');

describe('order Basis-project column links', () => {
  it('uses the shared link cell on the order view form', () => {
    expect(showSource).toContain('<BasisProjectLink');
    expect(showSource).toContain('bazisProjectId={detail.bazis_project_id}');
    expect(showSource).toContain("featureFlags.useBackendBazis && can('bazis.view')");
  });

  it('uses the shared link cell outside inline editing on the order edit form', () => {
    expect(editTableSource).toContain('<BasisProjectLink');
    expect(editTableSource).toContain("getDisplayedField(d, 'bazis_project_id')");
    expect(editTableSource).toContain("featureFlags.useBackendBazis && can('bazis.view')");
  });
});
