import { getWorkspaceStateNamespaceForUser } from './workspaceStateNamespace';
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
  unsubscribeBeforeClear = authSession.subscribeBeforeClear((transition) => {
    // F5 restores an identity into an empty JS document. Keep only persisted
    // drafts owned by that confirmed actor/scope; all later boundaries discard.
    const restoredNamespace = transition.initialIdentity && transition.nextUser
      ? getWorkspaceStateNamespaceForUser(transition.nextUser, transition.nextSessionGeneration)
      : undefined;
    clearWorkspaceSessionState(restoredNamespace);
  });
}

export function clearWorkspaceSessionState(restoredDraftNamespace?: string): void {
  clearWorkspaceCheckpointRegistry();
  clearWorkspaceOperationPins();
  clearWorkspaceUiState();
  clearWorkspaceKeepAliveDiagnostics();
  clearWorkspaceAttachments();
  clearAllOrderDraftStores(restoredDraftNamespace);
}
