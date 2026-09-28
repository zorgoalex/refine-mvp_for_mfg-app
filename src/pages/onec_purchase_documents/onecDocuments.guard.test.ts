import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const listSource = readFileSync(new URL('./list.tsx', import.meta.url), 'utf8');
const showSource = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
const allocationModalSource = readFileSync(new URL('./AllocationModal.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const navigationMenuConfigSource = readFileSync(new URL('../../utils/navigationMenuConfig.ts', import.meta.url), 'utf8');
const navigationPermissionsSource = readFileSync(new URL('../../utils/navigationPermissions.ts', import.meta.url), 'utf8');
const apiRoutesSource = readFileSync(new URL('../../api/apiRoutes.ts', import.meta.url), 'utf8');

const HASURA_PATTERN = /hasura|graphql|dataProvider/i;

describe('onec purchase documents screen — backend ownership guard', () => {
  it('never talks to Hasura/GraphQL/dataProvider directly (NestJS-owned command/read API only)', () => {
    expect(listSource).not.toMatch(HASURA_PATTERN);
    expect(showSource).not.toMatch(HASURA_PATTERN);
    expect(allocationModalSource).not.toMatch(HASURA_PATTERN);
  });

  it('reads and writes only through onecDocumentsApi/ordersApi', () => {
    expect(listSource).toContain("from '../../api/onecDocumentsApi'");
    expect(showSource).toContain("from '../../api/onecDocumentsApi'");
    expect(allocationModalSource).toContain("from '../../api/onecDocumentsApi'");
  });
});

describe('onec purchase documents screen — shared UI wrappers', () => {
  it('uses the delayed-tooltip Table wrapper, not antd Table directly', () => {
    expect(listSource).toContain("import { Table } from '../../ui/tooltipDelay'");
    expect(showSource).toContain("import { Table } from '../../ui/tooltipDelay'");
    expect(listSource).not.toMatch(/\{[^}]*\bTable\b[^}]*\}\s*from\s*['"]antd['"]/);
    expect(showSource).not.toMatch(/\{[^}]*\bTable\b[^}]*\}\s*from\s*['"]antd['"]/);
  });

  it('uses the shared Segmented adapter for the tab switch', () => {
    expect(listSource).toContain("import { Segmented } from '../../ui/Segmented'");
    expect(listSource).toContain('<Segmented');
  });
});

describe('onec purchase documents screen — empty state and gating', () => {
  it('shows the pre-ETL empty state text', () => {
    expect(listSource).toContain('Документы появятся после подключения 1С');
  });

  it('shows an info alert when procurement is disabled on the backend', () => {
    expect(listSource).toContain('PROCUREMENT_DISABLED');
    expect(listSource).toContain('Документы 1С пока не включены');
    expect(showSource).toContain('PROCUREMENT_DISABLED');
  });

  it('hides the amount column/field without finance.view (amountsVisible=false)', () => {
    expect(listSource).toContain('amountsVisible &&');
    expect(showSource).toContain('amountsVisible &&');
  });

  it('shows an orders-grouped summary on the document card', () => {
    expect(showSource).toContain('Заказы, для которых закуплено');
  });
});

describe('onec purchase documents navigation wiring', () => {
  it('registers the resource and both routes in App.tsx', () => {
    expect(appSource).toContain('name: "onec_purchase_documents"');
    expect(appSource).toContain('list: "/procurement/onec-documents"');
    expect(appSource).toContain('show: "/procurement/onec-documents/show/:documentId"');
    expect(appSource).toContain('<Route path="/procurement/onec-documents"');
    expect(appSource).toContain('<Route path="show/:documentId" element={<OnecPurchaseDocumentShow />} />');
  });

  it('places the screen in a dedicated "Закупки" menu section', () => {
    expect(navigationMenuConfigSource).toContain("onec_purchase_documents: 'Закупки'");
    expect(navigationMenuConfigSource).toContain("'Закупки'");
  });

  it('gates the menu item and API access behind procurement.view', () => {
    expect(navigationPermissionsSource).toContain("onec_purchase_documents: ['procurement.view']");
  });

  it('exposes the 4 documented backend routes', () => {
    expect(apiRoutesSource).toContain("list: backendApiPath('/procurement/onec-documents')");
    expect(apiRoutesSource).toContain('/procurement/onec-documents/${documentId}');
    expect(apiRoutesSource).toContain('/procurement/onec-documents/${documentId}/lines/${lineId}/allocations');
    expect(apiRoutesSource).toContain('/procurement/onec-documents/${documentId}/lines/${lineId}/allocations/${allocationId}');
  });
});
