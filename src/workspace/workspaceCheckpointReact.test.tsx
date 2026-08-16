import React, { useLayoutEffect, useRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceCheckpointAdapter } from './workspaceCheckpointReact';
import {
  captureWorkspaceCheckpoint,
  clearWorkspaceCheckpointRegistry,
  readWorkspaceCheckpointAdapterState,
} from './workspaceCheckpointRegistry';
import { clearWorkspaceUiState } from './workspaceUiStateStore';

const WORKSPACE_A = '/orders/show/1';

function AdapterOwner() {
  useWorkspaceCheckpointAdapter(WORKSPACE_A, 'show', {
    capture: () => ({ selectedIds: [11, 12], rawInput: '12,' }),
  });
  return <div>show A</div>;
}

function RouteCaptureHarness({ activeKey }: { activeKey: string }) {
  const previousKeyRef = useRef(activeKey);
  useLayoutEffect(() => {
    const previousKey = previousKeyRef.current;
    previousKeyRef.current = activeKey;
    if (previousKey !== activeKey) captureWorkspaceCheckpoint(previousKey);
  }, [activeKey]);
  return activeKey === WORKSPACE_A ? <AdapterOwner /> : <div>show B</div>;
}

describe('React checkpoint adapter lifecycle', () => {
  beforeEach(() => {
    clearWorkspaceCheckpointRegistry();
    clearWorkspaceUiState();
  });

  it('stays registered through parent layout capture before old route unmount cleanup', async () => {
    let view!: ReturnType<typeof TestRenderer.create>;
    await act(async () => {
      view = TestRenderer.create(<RouteCaptureHarness activeKey={WORKSPACE_A} />);
    });
    await act(async () => {
      view.update(<RouteCaptureHarness activeKey="/orders/show/2" />);
    });

    expect(readWorkspaceCheckpointAdapterState(WORKSPACE_A, 'show')).toEqual({
      selectedIds: [11, 12],
      rawInput: '12,',
    });
  });
});
