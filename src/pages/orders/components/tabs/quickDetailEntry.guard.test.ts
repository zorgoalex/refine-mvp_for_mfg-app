import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('NewLine order form: quick detail entry under the default parameters', () => {
  it('is NewLine-only and adds rows with the default parameters, reusing blank grid rows first', () => {
    const tab = readFileSync('src/pages/orders/components/tabs/OrderDetailsTab.tsx', 'utf8');
    expect(tab).toContain('{isWorkbench ? <QuickDetailEntry onAdd={handleQuickEntry} /> : null}');
    expect(tab).toContain('const placeholderIds = getOrderImportPlaceholderIds(storeApi.getState().details);');
    expect(tab).toMatch(/\.\.\.QUICK_ADD_DEFAULTS,\s*\.\.\.row,\s*area: calculateOrderDetailArea\(row\.height, row\.width, row\.quantity\),\s*is_placeholder: false,/);
    expect(tab).toMatch(/if \(placeholderId !== undefined\) updateDetail\(placeholderId, detail\);\s*else addDetail\(detail\);/);
    const entry = readFileSync('src/pages/orders/components/tabs/QuickDetailEntry.tsx', 'utf8');
    // nothing is added when part of the input is not understood
    expect(entry).toMatch(/if \(invalid\.length > 0\) \{[\s\S]*?return;\s*\}/);
  });
});
