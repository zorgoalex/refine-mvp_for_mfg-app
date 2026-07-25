import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string =>
  readFileSync(resolve(__dirname, '../..', relativePath), 'utf8');

describe('workspace tab ownership guards', () => {
  it('keeps order title and dirty updates bound to the owning tab', () => {
    const form = readSource('pages/orders/components/OrderForm.tsx');
    const show = readSource('pages/orders/show.tsx');

    expect(form).toContain('useWorkspaceTabKey(location.pathname)');
    expect(form).toContain('useTabDirty(tabKey, isDirty)');
    expect(form).toContain('setTabTitle(tabKey, resolveOrderTabLabel(header.order_name))');
    expect(show).toContain('useWorkspaceTabKey(location.pathname)');
    expect(show).toContain('setTabTitle(tabKey, resolveOrderTabLabel(record.order_name))');
  });

  it('keeps generic record titles and configuration dirty state bound to their tabs', () => {
    const recordTitle = readSource('utils/recordTitle.ts');
    const workflow = readSource('pages/configuration/components/ProductionWorkflowTab.tsx');

    expect(recordTitle).toContain('const tabKey = useWorkspaceTabKey(location.pathname)');
    expect(recordTitle).toContain('setTabTitle(tabKey, title)');
    expect(workflow).toContain(
      'useTabDirty(tabKey, isDirty || isDeadlineDirty)',
    );
  });
});
