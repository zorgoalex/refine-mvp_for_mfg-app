import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useKeepAlive } from '../components/workspace/KeepAliveContext';
import {
  captureWorkspaceDomCheckpoint,
  type WorkspaceDomCheckpoint,
} from './workspaceDomCheckpoint';
import type { WorkspaceSerializableRecord } from './workspaceUiStateStore';

/**
 * Keeps the last interaction-time DOM snapshot while a workspace is active.
 * Route/layout capture may run after a subtree became hidden, so reading
 * document.activeElement only at deactivation time would lose cursor identity.
 */
export function useWorkspaceDomCheckpointCapture(
  workspaceKey: string,
  initialCheckpoint: WorkspaceSerializableRecord | null = null,
): () => WorkspaceDomCheckpoint {
  const { workspaceActive } = useKeepAlive();
  const activeRef = useRef(workspaceActive);
  activeRef.current = workspaceActive;
  const hadInitialCheckpointRef = useRef(initialCheckpoint !== null);
  const latestRef = useRef<WorkspaceDomCheckpoint>(readInitialCheckpoint(initialCheckpoint));

  const record = useCallback(() => {
    if (!activeRef.current) return;
    latestRef.current = captureWorkspaceDomCheckpoint(workspaceKey);
  }, [workspaceKey]);

  useLayoutEffect(() => {
    if (!hadInitialCheckpointRef.current) record();
  }, [record]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const documentEvents: Array<keyof DocumentEventMap> = [
      'focusin',
      'input',
      'selectionchange',
      'keyup',
      'pointerup',
    ];
    documentEvents.forEach((eventName) => document.addEventListener(eventName, record, true));
    window.addEventListener('scroll', record, { passive: true });
    return () => {
      documentEvents.forEach((eventName) => document.removeEventListener(eventName, record, true));
      window.removeEventListener('scroll', record);
    };
  }, [record]);

  return useCallback(() => ({
    ...latestRef.current,
    focus: latestRef.current.focus ? { ...latestRef.current.focus } : null,
  }), []);
}

function readInitialCheckpoint(
  checkpoint: WorkspaceSerializableRecord | null,
): WorkspaceDomCheckpoint {
  if (!checkpoint) return { scrollY: 0, focus: null };
  return {
    scrollY: typeof checkpoint.scrollY === 'number' && Number.isFinite(checkpoint.scrollY)
      ? Math.max(0, checkpoint.scrollY)
      : 0,
    focus: checkpoint.focus && typeof checkpoint.focus === 'object' && !Array.isArray(checkpoint.focus)
      ? checkpoint.focus as WorkspaceSerializableRecord
      : null,
  };
}
