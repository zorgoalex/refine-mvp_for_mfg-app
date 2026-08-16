import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const outlet = readFileSync(resolve(__dirname, 'KeepAliveOutlet.tsx'), 'utf8');
const policy = readFileSync(resolve(__dirname, 'keepAlive.ts'), 'utf8');

describe('KeepAliveOutlet guards', () => {
  it('renders cached tabs in <div hidden=...> keyed off active', () => {
    expect(outlet).toContain('hidden={key !== activeKey}');
  });
  it('exposes isActive via KeepAliveContext', () => {
    expect(outlet).toContain('KeepAliveContext.Provider');
    expect(outlet).toContain('isActive');
  });
  it('pins each mounted screen to the tab key that owns it', () => {
    expect(outlet).toContain('tabKey: key');
  });
  it('publishes workspace activity, visibility and activation revision', () => {
    expect(outlet).toContain('workspaceActive: key === activeKey');
    expect(outlet).toContain('activationRevision:');
    expect(outlet).toContain('documentVisible');
    expect(outlet).toContain('useAppActivitySnapshot');
    expect(outlet).not.toContain("document.addEventListener('visibilitychange'");
  });
  it('keeps an already cached route node instead of replacing it on return', () => {
    expect(outlet).toContain('!cacheRef.current.has(activeKey)');
    expect(outlet).toContain('cacheRef.current.set(activeKey, outlet)');
  });
  it('renders every active route through one stable cache owner before tab sync', () => {
    expect(outlet).toContain('const activeDirty = activeTab?.dirty ?? false');
    expect(outlet).toContain('if (outlet && !cacheRef.current.has(activeKey))');
    expect(outlet).toContain('tabsWithActive');
    expect(outlet).toContain("{ key: activeKey, dirty: activeDirty }");
  });
  it('keeps /calendar excluded by default and activates only exact operation pins', () => {
    expect(policy).toContain("'/calendar'");
    expect(outlet).toContain('.filter((key) => hasWorkspaceOperationPins(key))');
    expect(outlet).toContain('recordWorkspaceOperationEvictionPin(key)');
    expect(outlet).toContain('subscribeWorkspaceOperationPins');
  });
  it('adds no new keep-alive dependency (hand-rolled over useOutlet)', () => {
    expect(outlet).toContain('useOutlet');
    expect(outlet).not.toContain('react-activation');
  });
});
