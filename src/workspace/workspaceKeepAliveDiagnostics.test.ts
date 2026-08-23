import { beforeEach, describe, expect, it } from 'vitest';
import { authSession } from '../api/authSession';
import {
  clearWorkspaceKeepAliveDiagnostics,
  getWorkspaceKeepAliveDiagnostics,
  recordMountedHeavyViewCount,
} from './workspaceKeepAliveDiagnostics';

describe('workspace keep-alive diagnostics', () => {
  beforeEach(() => {
    authSession.clear();
    clearWorkspaceKeepAliveDiagnostics();
    authSession.setUser({ id: 'A', username: 'a', role: 'admin', permissions: ['orders.view'] });
  });

  it('retains the session high-water mark when mounted DOM later shrinks', () => {
    recordMountedHeavyViewCount(1);
    recordMountedHeavyViewCount(5);
    expect(recordMountedHeavyViewCount(2)).toEqual({
      mountedHeavyViewCount: 2,
      peakMountedHeavyViewCount: 5,
    });
  });

  it('does not carry actor A peak into actor B namespace', () => {
    recordMountedHeavyViewCount(5);
    authSession.setUser({ id: 'B', username: 'b', role: 'admin', permissions: ['orders.view'] });
    expect(getWorkspaceKeepAliveDiagnostics()).toEqual({
      mountedHeavyViewCount: 0,
      peakMountedHeavyViewCount: 0,
    });
  });
});
