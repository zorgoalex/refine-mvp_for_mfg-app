import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const show = readFileSync('src/pages/orders/show.tsx', 'utf8');
const layout = readFileSync('src/ui-evolution/shell/EvolutionWorkspaceLayout.tsx', 'utf8');

describe('order card under the workbench variant', () => {
  it('adds «Ход производства» without replacing the original sections', () => {
    for (const key of ['groups', 'deadlines', 'finance', 'cut', 'additional']) {
      expect(show).toContain(`{ key: '${key}',`);
    }
    expect(show).toContain("{ key: 'flow', label: 'Ход производства'");
  });

  it('shows the spoiler only in workbench and never restores it elsewhere', () => {
    expect(show).toContain(".filter((tab) => isWorkbench || tab.panel !== WORKBENCH_ORDER_INFO_PANEL)");
    expect(show).toContain('&& (workbench || value !== WORKBENCH_ORDER_INFO_PANEL)');
    expect(show).toContain('readOrderInfoPanelCheckpoint(restoredShowCheckpoint?.activeInfoPanel, isWorkbench)');
  });

  it('keeps every section collapsed by default (no panel opened on first render)', () => {
    expect(show).not.toMatch(/useState<OrderInfoPanelKey \| null>\(\s*WORKBENCH_ORDER_INFO_PANEL/);
    expect(show).toContain('setActiveInfoPanel(isActive ? null : tab.panel)');
  });

  it('loads the orders stylesheet of the variant with the shell', () => {
    expect(layout).toContain("import '../styles/workbench-orders.css';");
  });
});
