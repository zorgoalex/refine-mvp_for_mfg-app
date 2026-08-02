import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pagesRoot = join(__dirname, '..', 'pages');

describe('persistent pagination coverage', () => {
  it('routes every Refine list using useTable through the persistent wrapper', () => {
    const listFiles = readdirSync(pagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(pagesRoot, entry.name, 'list.tsx'))
      .filter((path) => {
        try {
          return readFileSync(path, 'utf8').includes('useTable(');
        } catch {
          return false;
        }
      });

    expect(listFiles.length).toBeGreaterThan(25);
    for (const path of listFiles) {
      expect(readFileSync(path, 'utf8'), path).toContain('usePersistentTable as useTable');
    }
  });

  it('keeps independent keys on manually paginated screens', () => {
    const expected: Record<string, string> = {
      'audit/list.tsx': 'audit:list',
      'bazis-cut/BazisCutListPage.tsx': 'bazis-cut:list',
      'bazis/BazisPage.tsx': 'bazis:projects',
      'bazis/MaterialsSummaryTab.tsx': 'bazis:materials-summary',
      'configuration/components/FinancialLayerAccessMatrix.tsx': 'configuration:financial-layer-users',
      'configuration/components/OrgStructureConfig.tsx': 'configuration:org-directions',
      'groups/GroupsPage.tsx': 'groups:list',
      'order_resource_requirements/list.tsx': 'order-resource-requirements:list',
      'orders/trash.tsx': 'orders:trash',
      'orders/components/tables/OrderDetailTable.tsx': 'orders:details-edit',
      'projects/ProjectsList.tsx': 'projects:list',
    };

    for (const [relativePath, key] of Object.entries(expected)) {
      const source = readFileSync(join(pagesRoot, relativePath), 'utf8');
      expect(source, relativePath).toContain('usePageSizePreference');
      expect(source, relativePath).toContain(key);
      expect(source, relativePath).toContain('showSizeChanger: true');
    }
  });

  it('resets Refine lists to the first page when size changes', () => {
    const source = readFileSync(join(__dirname, 'usePersistentTable.ts'), 'utf8');
    expect(source).toContain('result.setCurrent(1)');
    expect(source).toContain("current: 1");
  });
});
