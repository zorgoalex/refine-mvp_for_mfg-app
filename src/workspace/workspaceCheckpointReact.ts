import { useEffect, useRef } from 'react';
import {
  registerWorkspaceCheckpointAdapter,
  type WorkspaceCheckpointAdapter,
} from './workspaceCheckpointRegistry';

export function useWorkspaceCheckpointAdapter(
  workspaceKey: string,
  adapterKey: string,
  adapter: WorkspaceCheckpointAdapter,
): void {
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  // Passive cleanup intentionally keeps the previous adapter registered through
  // the parent outlet's layout-phase route capture, before the old subtree is gone.
  useEffect(() => registerWorkspaceCheckpointAdapter(workspaceKey, adapterKey, {
    canCapture: () => adapterRef.current.canCapture?.() !== false,
    capture: () => adapterRef.current.capture(),
  }), [adapterKey, workspaceKey]);
}
