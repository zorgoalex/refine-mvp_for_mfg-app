import { authSession } from '../api/authSession';
import { clearAllOrderDraftStores } from '../stores/orderFormStore';
import { clearWorkspaceAttachments } from './workspaceAttachmentRegistry';
import { clearWorkspaceCheckpointRegistry } from './workspaceCheckpointRegistry';
import { clearWorkspaceOperationPins } from './workspaceOperationPins';
import { clearWorkspaceUiState } from './workspaceUiStateStore';
import { clearWorkspaceKeepAliveDiagnostics } from './workspaceKeepAliveDiagnostics';

let unsubscribeBeforeClear: (() => void) | null = null;

export function installWorkspaceStateLifecycle(): void {
  if (unsubscribeBeforeClear) return;
  unsubscribeBeforeClear = authSession.subscribeBeforeClear(clearWorkspaceSessionState);
}

export function clearWorkspaceSessionState(): void {
  clearWorkspaceCheckpointRegistry();
  clearWorkspaceOperationPins();
  clearWorkspaceUiState();
  clearWorkspaceKeepAliveDiagnostics();
  clearWorkspaceAttachments();
  clearAllOrderDraftStores();
}
