import { useLayoutEffect, useRef } from 'react';
import type { FormInstance } from 'antd';
import { useKeepAlive } from '../components/workspace/KeepAliveContext';
import { readWorkspaceCheckpointAdapterState } from './workspaceCheckpointRegistry';
import { useWorkspaceCheckpointAdapter } from './workspaceCheckpointReact';
import { captureAntFormCheckpoint, restoreAntFormCheckpoint } from './workspaceFormCheckpoint';

export function useWorkspaceModalFormCheckpoint(
  adapterKey: string,
  open: boolean,
  form: FormInstance,
  fallbackWorkspaceKey = '/orders/create',
): string {
  const { tabKey } = useKeepAlive();
  const workspaceKey = tabKey || fallbackWorkspaceKey;
  const restored = useRef(
    readWorkspaceCheckpointAdapterState(workspaceKey, adapterKey),
  ).current;
  const restorePendingRef = useRef(restored?.open === true);

  useWorkspaceCheckpointAdapter(workspaceKey, adapterKey, {
    capture: () => ({ open, form: captureAntFormCheckpoint(form) }),
  });

  useLayoutEffect(() => {
    if (!open || !restorePendingRef.current) return;
    restorePendingRef.current = false;
    restoreAntFormCheckpoint(form, restored?.form);
  }, [form, open, restored]);

  return workspaceKey;
}
