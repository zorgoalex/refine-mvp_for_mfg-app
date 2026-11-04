import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Modal, Space, Spin, Typography, message } from 'antd';
import { isApiError } from '../../api/apiError';
import { bazisCutApi, type BazisCutSetCardDto } from '../../api/bazisCutApi';
import {
  buildDesiredRowsForEdit,
  describeCompositionPreview,
  CompositionCommandBuilder,
  type CompositionPreviewDisplay,
  type CompositionRowEdit,
} from './bazisCutComposition';

const { Text } = Typography;

export interface BazisCutCompositionRequest {
  edit: CompositionRowEdit;
  /** Human label shown above the preview, e.g. "Количество: 10 → 8" or "Удаление 1 детали". */
  summary: string;
  /** Message shown on a successful (queued) confirm; defaults to the generic composition-change
   * message. AddToBazisCutModal's refill flow uses this for its own "added" wording. */
  successMessage?: string;
}

interface Props {
  open: boolean;
  set: BazisCutSetCardDto | null;
  request: BazisCutCompositionRequest | null;
  onClose: () => void;
  /** Re-fetches the set from the backend (also updates the caller's own state); returns the
   * fresh card, or null on failure. */
  reload: () => Promise<BazisCutSetCardDto | null>;
  onQueued: (updatedSet: BazisCutSetCardDto) => void;
  /** Called instead of the generic error display when the backend rejects the request with
   * 409 MDF_BAZIS_REFILL_DISABLED (the refill producer flag is off) — the composition-add
   * feature is unavailable, not the set/version being stale. The caller (AddToBazisCutModal)
   * uses this to show its own guidance and fall back to "new set" while keeping the selection. */
  onRefillDisabled?: () => void;
}

type Phase = 'loading' | 'ready' | 'error';

/** Preview -> confirm modal for a production-safe composition change (new MDF engine):
 * quantity edit, single-row delete, or bulk delete on a set whose mdfComposition.available
 * is true. Always previews first; confirm reuses the previewed digest and one idempotency
 * key. A stale (409) response at either step asks the user to refresh the preview instead
 * of silently retrying, since the underlying set or production data changed underneath.
 *
 * Every async completion (preview, its retry/reload, and confirm) is bound to a request
 * GENERATION token from builderRef's CompositionCommandBuilder: opening a new request (or
 * closing this one) bumps the generation, so a late response from a superseded attempt
 * (e.g. open deletion A, cancel, open deletion B before A resolves) is ignored instead of
 * overwriting the builder/UI state for the request currently shown. */
export const BazisCutCompositionModal: React.FC<Props> = ({
  open, set, request, onClose, reload, onQueued, onRefillDisabled,
}) => {
  const [phase, setPhase] = useState<Phase>('loading');
  const [display, setDisplay] = useState<CompositionPreviewDisplay | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const builderRef = useRef(new CompositionCommandBuilder());

  const handleFailure = useCallback((error: unknown, action: string) => {
    if (isApiError(error, 'MDF_BAZIS_REFILL_DISABLED')) {
      onRefillDisabled?.();
      return;
    }
    if (isApiError(error) && error.status === 409) {
      setPhase('error');
      setErrorText('Набор изменился — обновите предпросмотр');
      message.warning('Набор изменился — обновите предпросмотр');
      return;
    }
    setPhase('error');
    setErrorText(error instanceof Error ? error.message : `Не удалось выполнить: ${action}`);
  }, [onRefillDisabled]);

  const runPreview = useCallback(async (current: BazisCutSetCardDto, generation: number) => {
    if (!request) return;
    const sourceToken = current.mdfComposition?.sourceToken;
    if (!current.mdfComposition?.available || !sourceToken) {
      if (!builderRef.current.isCurrentAttempt(generation)) return;
      setPhase('error');
      setErrorText('Изменение состава набора сейчас недоступно');
      return;
    }
    setPhase('loading');
    setErrorText(null);
    try {
      const eligibleRowIds = current.mdfComposition.eligibleRowIds ?? [];
      const desiredRows = buildDesiredRowsForEdit(current.details, request.edit, eligibleRowIds);
      const previewRequest = builderRef.current.buildPreviewRequest(String(current.version), sourceToken, desiredRows);
      const response = await bazisCutApi.previewComposition(current.bazisCutSetId, previewRequest);
      if (!builderRef.current.registerPreview(generation, previewRequest, response)) return; // superseded, ignore
      setDisplay(describeCompositionPreview(response, current.details));
      setPhase('ready');
    } catch (error) {
      if (!builderRef.current.isCurrentAttempt(generation)) return; // superseded, ignore
      handleFailure(error, 'предпросмотр состава');
    }
  }, [handleFailure, request]);

  useEffect(() => {
    if (!open || !set || !request) return;
    const generation = builderRef.current.reset();
    setDisplay(null);
    void runPreview(set, generation);
    // Invalidate this attempt's generation when the modal closes, the requested edit
    // changes, or the component unmounts — a still-in-flight response from it must never
    // be applied afterwards (registerPreview()/isCurrentAttempt() reject it).
    return () => {
      builderRef.current.invalidate();
    };
    // Intentionally re-runs only when the modal opens for a new request/set; refreshing the
    // preview afterwards goes through the explicit "Обновить предпросмотр" retry action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request, set?.bazisCutSetId]);

  const retryPreview = useCallback(async () => {
    const generation = builderRef.current.beginAttempt();
    setPhase('loading');
    const refreshed = await reload();
    if (!builderRef.current.isCurrentAttempt(generation)) return; // superseded, ignore
    if (!refreshed) {
      setPhase('error');
      setErrorText('Не удалось обновить набор');
      return;
    }
    await runPreview(refreshed, generation);
  }, [reload, runPreview]);

  const confirm = useCallback(async () => {
    if (!set || !builderRef.current.confirmable) return;
    const { request: confirmRequest, idempotencyKey, generation } = builderRef.current.buildConfirmRequest();
    setConfirming(true);
    try {
      const response = await bazisCutApi.confirmComposition(set.bazisCutSetId, confirmRequest, idempotencyKey);
      if (!builderRef.current.isCurrentAttempt(generation)) return; // superseded, ignore
      if (response.status === 'unchanged') {
        message.info('Изменений нет — состав уже соответствует запросу');
      } else {
        message.success(request?.successMessage ?? 'Изменение состава поставлено в обработку');
      }
      const refreshed = await reload();
      if (!builderRef.current.isCurrentAttempt(generation)) return; // superseded, ignore
      if (refreshed) onQueued(refreshed);
      onClose();
    } catch (error) {
      if (builderRef.current.isCurrentAttempt(generation)) {
        handleFailure(error, 'подтверждение состава');
      }
    } finally {
      setConfirming(false);
    }
  }, [handleFailure, onClose, onQueued, reload, request, set]);

  const blocked = display?.status === 'blocked';
  const canConfirm = phase === 'ready' && display !== null && !blocked;

  const title = request?.edit.kind === 'refill' ? 'Добавление деталей в набор' : 'Изменение состава набора';

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      destroyOnClose
      confirmLoading={confirming}
      footer={[
        <Button key="cancel" onClick={onClose}>Отмена</Button>,
        phase === 'error'
          ? <Button key="retry" onClick={() => void retryPreview()}>Обновить предпросмотр</Button>
          : <Button key="confirm" type="primary" disabled={!canConfirm} loading={confirming}
              onClick={() => void confirm()}>Подтвердить</Button>,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {request && <Text strong>{request.summary}</Text>}
        <Alert type="info" showIcon message="Распил и резервы ванн сохраняются, статусы деталей не меняются." />
        {phase === 'loading' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}><Spin /></div>
        )}
        {phase === 'error' && errorText && (
          <Alert type="error" showIcon message={errorText} />
        )}
        {phase === 'ready' && display && (
          blocked ? (
            <Alert type="error" showIcon message="Изменение нельзя подтвердить"
              description={<Space direction="vertical" size={4}>
                {display.blockerLines.map((line) => <Text key={line}>{line}</Text>)}
              </Space>} />
          ) : (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {!display.hasChanges && <Alert type="info" showIcon message="Изменений в назначениях нет" />}
              {display.assignmentLines.length > 0 && (
                <Card size="small" title="Изменения назначений">
                  <Space direction="vertical" size={2}>
                    {display.assignmentLines.map((line) => <Text key={line}>{line}</Text>)}
                  </Space>
                </Card>
              )}
              {display.retainedLines.length > 0 && (
                <Card size="small" title="Сохраняемый физический распил">
                  <Space direction="vertical" size={2}>
                    {display.retainedLines.map((line) => <Text key={line}>{line}</Text>)}
                  </Space>
                </Card>
              )}
              {display.preservedLines.length > 0 && (
                <Card size="small" title="Сохраняемые резервы ванн">
                  <Space direction="vertical" size={2}>
                    {display.preservedLines.map((line) => <Text key={line}>{line}</Text>)}
                  </Space>
                </Card>
              )}
            </Space>
          )
        )}
      </Space>
    </Modal>
  );
};
