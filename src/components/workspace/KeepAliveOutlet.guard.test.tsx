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
    expect(outlet).toContain('tabKey: activeKey');
  });
  it('publishes workspace activity, visibility and activation revision', () => {
    expect(outlet).toContain('workspaceActive: key === activeKey');
    expect(outlet).toContain('activationRevision:');
    expect(outlet).toContain('documentVisible');
    expect(outlet).toContain("document.addEventListener('visibilitychange', update)");
  });
  it('keeps an already cached route node instead of replacing it on return', () => {
    expect(outlet).toContain('!cacheRef.current.has(activeKey)');
    expect(outlet).toContain('cacheRef.current.set(activeKey, outlet)');
  });
  it('can cache always-keep routes before tab sync opens their workspace tab', () => {
    expect(outlet).toContain('const activeDirty = activeTab?.dirty ?? false');
    expect(outlet).toContain('const eligible = isKeepAliveEligible(activeKey, { dirty: activeDirty })');
    expect(outlet).toContain('tabsWithActive');
    expect(outlet).toContain("{ key: activeKey, dirty: activeDirty }");
  });
  it('excludes /calendar from keep-alive (B7)', () => {
    expect(policy).toContain("'/calendar'");
  });
  it('adds no new keep-alive dependency (hand-rolled over useOutlet)', () => {
    expect(outlet).toContain('useOutlet');
    expect(outlet).not.toContain('react-activation');
  });
});
