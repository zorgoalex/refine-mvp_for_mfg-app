import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const host = readFileSync(resolve(__dirname, 'PersistentMdfBoardHost.tsx'), 'utf8');
const app = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');
const legacyLayout = readFileSync(resolve(__dirname, 'WorkspaceLayout.tsx'), 'utf8');
const modernLayout = readFileSync(
  resolve(__dirname, '../../ui-evolution/shell/EvolutionWorkspaceLayout.tsx'),
  'utf8',
);
const page = readFileSync(
  resolve(__dirname, '../../pages/orderStatusBoard/OrderStatusBoardPage.tsx'),
  'utf8',
);

describe('PersistentMdfBoardHost guards', () => {
  it('mounts the warmed MDF board in idle time and keeps it hidden off-route', () => {
    expect(host).toContain('isMdfBoardSnapshotReady()');
    expect(host).toContain('idleWindow.requestIdleCallback');
    expect(host).toContain("hidden={!active}");
    expect(host).toContain('data-persistent-mdf-board="true"');
    expect(host).toContain('const initiallyActiveRef = useRef(active)');
    expect(host).toContain('active={initiallyActiveRef.current}');
  });

  it('reveals the ready DOM on MDF navigation intent', () => {
    expect(host).toContain('MDF_BOARD_PREFETCH_EVENT');
    expect(host).toContain('hostRef.current.hidden = false');
    expect(host).toContain('window.removeEventListener(MDF_BOARD_PREFETCH_EVENT');
  });

  it('owns the MDF route in both workspace shells without duplicate route rendering', () => {
    expect(legacyLayout).toContain('<PersistentMdfBoardHost />');
    expect(modernLayout).toContain('<PersistentMdfBoardHost />');
    expect(app).toContain('<Route index element={null} />');
    expect(page).toContain('<OrderStatusBoardPage');
    expect(page).toContain('active={active}');
    expect(page).toContain('eagerFirstViewport');
    expect(page).toContain('memo(({ active = true }) =>');
    expect(page).toContain("active && fixedView === 'cnc_today'");
  });
});
