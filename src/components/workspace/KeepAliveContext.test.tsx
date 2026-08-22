import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  activateWorkspace,
  isWorkspaceOrdinaryReadActive,
  KeepAliveContext,
  OrderReadSurface,
  useKeepAlive,
  type KeepAliveState,
  type WorkspaceActivationTracker,
} from './KeepAliveContext';

const activeWorkspace: KeepAliveState = {
  isActive: true,
  tabKey: '/orders/edit/42',
  workspaceActive: true,
  activationRevision: 1,
  documentVisible: true,
  surfaceActive: true,
};

describe('workspace activity contract', () => {
  it('requires active workspace, surface and document for ordinary reads', () => {
    expect(isWorkspaceOrdinaryReadActive(activeWorkspace)).toBe(true);
    expect(isWorkspaceOrdinaryReadActive({ ...activeWorkspace, workspaceActive: false })).toBe(false);
    expect(isWorkspaceOrdinaryReadActive({ ...activeWorkspace, surfaceActive: false })).toBe(false);
    expect(isWorkspaceOrdinaryReadActive({ ...activeWorkspace, documentVisible: false })).toBe(false);
  });

  it('composes nested inactive surfaces without changing workspace identity', () => {
    let observed: KeepAliveState | null = null;
    const Probe = () => {
      observed = useKeepAlive();
      return null;
    };

    renderToStaticMarkup(
      <KeepAliveContext.Provider value={activeWorkspace}>
        <OrderReadSurface active={false}><Probe /></OrderReadSurface>
      </KeepAliveContext.Provider>,
    );

    expect(observed).toEqual({ ...activeWorkspace, surfaceActive: false });
  });

  it('increments revision once per workspace activation', () => {
    const tracker: WorkspaceActivationTracker = {
      lastActiveKey: '',
      nextRevision: 0,
      revisionByKey: new Map(),
    };

    expect(activateWorkspace(tracker, '/orders')).toBe(1);
    expect(activateWorkspace(tracker, '/orders')).toBe(1);
    expect(activateWorkspace(tracker, '/orders/show/42')).toBe(2);
    expect(activateWorkspace(tracker, '/orders')).toBe(3);
  });
});
