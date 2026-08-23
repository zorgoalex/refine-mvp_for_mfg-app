import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');

describe('order show realtime guard', () => {
  it('uses snapshot-first realtime only with backend order reads', () => {
    expect(source).toContain('featureFlags.orderRealtime && useBackendOrdersRead');
    expect(source).toContain('useOrderDetailLiveState({');
    expect(source).toContain('active: isWorkspaceTabActive');
    expect(source).toContain('authScopeKey: authCacheNamespace');
  });

  it('disables both legacy full-order status polling and cut polling', () => {
    expect(source).toMatch(/refreshLiveDetailProductionStatuses = useCallback[\s\S]*if \(!ordinaryReadActive \|\| orderRealtimeEnabled\) return/);
    expect(source).toContain('enabled: cutColumnEnabled && !orderRealtimeEnabled');
    expect(source).toContain('active: ordinaryReadActive');
    expect(source).toMatch(/refreshLiveDetailProductionStatuses = useCallback[\s\S]*showAsyncReadGuard\.capture\(\)/);
    expect(source).toMatch(/setLiveDetailProductionStatusState[\s\S]*showAsyncReadGuard\.isCurrent\(token\)/);
    expect(source).toContain('liveDetailProductionStatusState?.scopeKey === showAsyncReadScopeKey');
  });

  it('versions only the changed live cell while preserving other row references', () => {
    expect(source).toContain('const orderShowDetailsDataSource = useMemo(() => {');
    expect(source).toContain("previous?.detail === detail");
    expect(source).toContain("column.key === 'production_status_id'");
    expect(source).toContain('return row?.[liveVersionKey] !== previousRow?.[liveVersionKey]');
    expect(source).toMatch(/orderShowCutRefVersion[\s\S]*ref\.paramProfileId[\s\S]*ref\.profileName[\s\S]*ref\.profileIsActive/);
    expect(source).not.toContain('return isLiveExternalColumn || row !== previousRow');
    expect(source).toContain('dataSource={orderShowDetailsDataSource as any}');
  });
});
