import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
const layout = readFileSync('src/ui-evolution/shell/EvolutionWorkspaceLayout.tsx', 'utf8');

describe('order card under the NewLine variant', () => {
  it('keeps the original five sections for every variant', () => {
    for (const key of ['groups', 'deadlines', 'finance', 'cut', 'additional']) {
      expect(show).toContain(`{ key: '${key}',`);
    }
  });

  it('adds the «Детали» tab only in NewLine and never drops a section', () => {
    expect(show).toContain("? [{ key: 'details', panel: null, label: 'Детали', color: 'inherit', count: details.length }, ...visibleOrderInfoTabs]");
    expect(show).toContain(': visibleOrderInfoTabs;');
  });

  it('keeps «Ход производства» collapsed by default', () => {
    expect(show).toContain('const [workbenchFlowOpen, setWorkbenchFlowOpen] = useState(false);');
    expect(show).toContain('aria-expanded={workbenchFlowOpen}');
  });

  it('keeps every page action reachable from the NewLine head', () => {
    for (const key of ['refresh', 'print', 'excel', 'pdf-production', 'excel-without-prices', 'json', 'move-project', 'delete-order']) {
      expect(show).toContain(`if (key === '${key}')`);
    }
    expect(show).toContain('Добавить платёж');
    expect(show).toContain('workbenchEditButton');
  });

  it('positions sticky elements below the app chrome, not under it', () => {
    expect(show).toContain("'--wb-order-sticky-top': `${workbenchChromeBottom}px`");
    expect(show).toContain('{ offsetHeader: workbenchChromeBottom + WORKBENCH_ORDER_BAR_HEIGHT }');
  });

  it('lets the right column be folded and remembers it per browser', () => {
    expect(show).toContain("const WORKBENCH_SIDE_COLLAPSED_KEY = 'erp.orderShow.sideCollapsed';");
    expect(show).toContain('hidden={workbenchSideCollapsed}');
    expect(show).toContain("isWorkbench && workbenchSideCollapsed ? 'order-show-page--workbench-wide' : ''");
  });

  it('keeps every block of «Дополнительная информация» under its class hook', () => {
    for (const hook of ['order-additional__summary', 'order-additional__materials', 'order-additional__files', 'order-additional__labels', 'order-additional__meta']) {
      expect(show).toContain(`className="${hook}"`);
    }
  });

  it('loads the orders stylesheet of the variant with the shell', () => {
    expect(layout).toContain("import '../styles/workbench-orders.css';");
  });
});
