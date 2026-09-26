import React from 'react';
import { Modal, message } from 'antd';
import { buildMdfOrderConflictViewModel, type MdfOrderConflictViewModel } from './mdfOrderConflict';

/**
 * Renders the MDF board conflict view model as Modal.error content: the
 * server message, then one block per blocking card with its position lines,
 * then a note when some cards belong to orders the user cannot see.
 */
export function renderMdfOrderConflictContent(vm: MdfOrderConflictViewModel): React.ReactNode {
  return (
    <div>
      <p style={{ marginBottom: vm.cards.length ? 12 : 0 }}>{vm.message}</p>
      {vm.cards.map((card, index) => (
        <div key={`${card.sourceKind ?? 'card'}-${card.sourceId ?? index}`} style={{ marginBottom: 10 }}>
          <strong>{card.header}</strong>
          {card.positions.length > 0 && (
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              {card.positions.map((position, positionIndex) => (
                <li key={`${position.detailId ?? positionIndex}`}>{position.line}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {vm.hiddenOwnersNote && (
        <p style={{ marginTop: 8, color: 'var(--app-text-muted, rgba(0, 0, 0, 0.45))' }}>
          <em>{vm.hiddenOwnersNote}</em>
        </p>
      )}
    </div>
  );
}

export interface ShowMdfOrderConflictModalOptions {
  /**
   * Called when the user confirms a confirmable conflict (vm.confirmationDigest
   * is present). The caller must resend the identical request (same body, same
   * If-Match/Idempotency-Key) with header X-MDF-Confirmation: <digest>. Return
   * its promise so the AntD modal shows a loading state on the OK button while
   * the resend is in flight.
   */
  onConfirm?: (digest: string) => void | Promise<void>;
  /** Called when the user dismisses a confirmable dialog without confirming. */
  onCancel?: () => void;
}

/**
 * Detects an MDF board order-conflict error and surfaces it to the user:
 * a plain "retry later" message for the two retryable codes; a Modal.confirm
 * offering to resend with the confirmation header when the conflict carries
 * a confirmable digest and the caller passed onConfirm; otherwise a
 * Modal.error with the full per-card breakdown. Returns false (and does
 * nothing) when the error is not one of these codes, so callers can fall
 * back to their own generic error handling.
 */
export function showMdfOrderConflictModal(
  error: unknown,
  options?: ShowMdfOrderConflictModalOptions,
): boolean {
  const vm = buildMdfOrderConflictViewModel(error);
  if (!vm) return false;

  if (vm.retryable) {
    message.warning(`${vm.message} Повторите позже.`);
    return true;
  }

  if (vm.confirmationDigest && options?.onConfirm) {
    const digest = vm.confirmationDigest;
    const onConfirm = options.onConfirm;
    Modal.confirm({
      title: vm.title,
      content: renderMdfOrderConflictContent(vm),
      width: 560,
      okText: 'Подтвердить',
      cancelText: 'Отмена',
      onOk: () => onConfirm(digest),
      onCancel: () => options.onCancel?.(),
    });
    return true;
  }

  Modal.error({
    title: vm.title,
    content: renderMdfOrderConflictContent(vm),
    width: 560,
    okText: 'Понятно',
  });
  return true;
}
