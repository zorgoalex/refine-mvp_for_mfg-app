import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Radio, Select, Space, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { isApiError } from '../../api/apiError';
import {
  bazisCutApi,
  type BazisCutMutationResultDto,
  type BazisCutSetCardDto,
  type BazisCutSetListItemDto,
} from '../../api/bazisCutApi';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
import {
  isWorkspaceOperationOwnershipLost,
  runPageOwnedWorkspaceOperation,
  type PageOwnedWorkspaceOperationContext,
} from '../../workspace/workspaceOperationPins';
import { BazisCutCompositionModal, type BazisCutCompositionRequest } from './BazisCutCompositionModal';
import { buildRefillRows, compositionUnavailableText } from './bazisCutComposition';

interface Props {
  open: boolean;
  orderId: number;
  detailIds?: number[];
  /** ACTUAL quantity (order_details.quantity) of every detail in `detailIds`, keyed by
   * detailId. Required for the refill path (adding details into an EXISTING set on the new
   * MDF engine): the server builds a brand-new row per added detail from this quantity, so a
   * missing entry must never be silently treated as 1 — see buildRefillRows. Not needed for
   * the legacy "new set" / "existing set, legacy engine" paths, which copy
   * order_details.quantity server-side. */
  detailQuantities?: Record<number, number>;
  hdfDetailIds?: number[];
  onClose: () => void;
  onDone?: () => void;
}

export const AddToBazisCutModal: React.FC<Props> = ({
  open, orderId, detailIds = [], detailQuantities = {}, hdfDetailIds = [], onClose, onDone,
}) => {
  const { tabKey } = useKeepAlive();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [search, setSearch] = useState('');
  const [sets, setSets] = useState<BazisCutSetListItemDto[]>([]);
  const [setId, setSetId] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refillNotConnected, setRefillNotConnected] = useState(false);
  const [unavailableText, setUnavailableText] = useState<string | null>(null);
  // Set fetched via GET right before an "existing set" submit, on the new MDF engine with
  // composition.available; kept around so the composition sub-modal (opened below) has a
  // current card to preview/confirm against and to reload from.
  const [compositionSet, setCompositionSet] = useState<BazisCutSetCardDto | null>(null);
  const [compositionRequest, setCompositionRequest] = useState<BazisCutCompositionRequest | null>(null);
  const selectedCount = detailIds.length + hdfDetailIds.length;

  useEffect(() => {
    if (!open) return;
    setMode('new'); setSetId(undefined); setSearch(''); setRefillNotConnected(false);
    setUnavailableText(null); setCompositionSet(null); setCompositionRequest(null);
  }, [open]);

  const changeMode = useCallback((next: 'new' | 'existing') => {
    setMode(next);
    setRefillNotConnected(false);
    setUnavailableText(null);
  }, []);

  useEffect(() => {
    if (!open || mode !== 'existing') return;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      bazisCutApi.list({ search: search || undefined, pageSize: 50 })
        .then((response) => setSets(response.items))
        .catch((error) => message.error(error instanceof Error ? error.message : 'Не удалось загрузить наборы'))
        .finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [mode, open, search]);

  const options = useMemo(() => sets.map((set) => ({
    value: set.bazisCutSetId,
    label: `#${set.bazisCutSetId} · ${set.name} · ${new Intl.DateTimeFormat('ru-RU').format(new Date(set.createdAt))}`,
  })), [sets]);

  const finishLegacySuccess = useCallback((result: BazisCutMutationResultDto) => {
    message.success(result.addedCount === 0 ? 'Эти детали уже есть в наборе' : `Добавлено деталей: ${result.addedCount ?? selectedCount}`);
    onDone?.(); onClose();
    Modal.confirm({
      title: 'Набор обновлён', content: result.set.name,
      okText: 'Открыть набор', cancelText: 'Остаться в заказе',
      onOk: () => navigate(`/bazis-cut/${result.set.bazisCutSetId}`),
    });
  }, [navigate, onClose, onDone, selectedCount]);

  const submit = useCallback(async () => {
    if (selectedCount === 0) return;
    setUnavailableText(null);
    setSubmitting(true);
    try {
      if (mode === 'new') {
        const idempotencyKey = commandKey('bazis-cut-add');
        const result = await runPageOwnedWorkspaceOperation(
          tabKey || `/orders/show/${orderId}`,
          'order-bazis-cut',
          () => bazisCutApi.create({ orderId, detailIds, hdfDetailIds }, { idempotencyKey }),
        );
        finishLegacySuccess(result);
        return;
      }
      if (!setId) return;
      const current = await runPageOwnedWorkspaceOperation(
        tabKey || `/orders/show/${orderId}`,
        'order-bazis-cut',
        async (owner) => {
          const fetched = await bazisCutApi.get(setId);
          owner.assertOwnerCurrent();
          return fetched;
        },
      );
      if (!current.mdfComposition) {
        // Legacy engine (no composition readiness reported): unchanged addDetails path.
        const idempotencyKey = commandKey('bazis-cut-add');
        const result = await runPageOwnedWorkspaceOperation(
          tabKey || `/orders/show/${orderId}`,
          'order-bazis-cut',
          (owner) => addToExisting(current, orderId, detailIds, hdfDetailIds, idempotencyKey, owner),
        );
        finishLegacySuccess(result);
        return;
      }
      if (!current.mdfComposition.available) {
        setUnavailableText(compositionUnavailableText(current.mdfComposition.reason));
        return;
      }
      if (hdfDetailIds.length > 0) {
        // The composition (refill) command only builds new rows from ordinary order details;
        // HDF details have no equivalent on the new engine yet.
        setUnavailableText('Детали ХДФ нельзя добавить в этот набор (новый производственный учёт поддерживает только обычные детали) — создайте новый набор');
        return;
      }
      const { alreadyInSet, invalidQuantity } = buildRefillRows(
        current.details,
        current.mdfComposition.eligibleRowIds,
        detailIds.map((detailId) => ({ detailId, quantity: detailQuantities[detailId] })),
      );
      if (invalidQuantity.length > 0) {
        setUnavailableText(
          `Не удалось определить количество для ${invalidQuantity.length} дет. — добавление отменено`,
        );
        return;
      }
      const newDetailIds = detailIds.filter((detailId) => !alreadyInSet.includes(detailId));
      if (newDetailIds.length === 0) {
        message.info('Эти детали уже есть в наборе');
        onDone?.(); onClose();
        return;
      }
      if (alreadyInSet.length > 0) {
        message.info(`Уже есть в наборе и не будут добавлены повторно: ${alreadyInSet.length} дет.`);
      }
      setCompositionSet(current);
      setCompositionRequest({
        edit: {
          kind: 'refill',
          addedDetails: newDetailIds.map((detailId) => ({ detailId, quantity: detailQuantities[detailId] })),
        },
        summary: `Добавление деталей в набор: ${newDetailIds.length}`,
        successMessage: 'Детали добавлены в набор — изменение поставлено в обработку',
      });
    } catch (error) {
      if (isWorkspaceOperationOwnershipLost(error)) return;
      if (isApiError(error, 'MDF_SET_REFILL_NOT_CONNECTED')) {
        setRefillNotConnected(true);
        setMode('new');
        return;
      }
      message.error(error instanceof Error ? error.message : 'Не удалось добавить детали');
    } finally { setSubmitting(false); }
  }, [detailIds, detailQuantities, finishLegacySuccess, hdfDetailIds, mode, onClose, onDone, orderId, selectedCount, setId, tabKey]);

  const reloadCompositionSet = useCallback(async (): Promise<BazisCutSetCardDto | null> => {
    if (!compositionSet) return null;
    try {
      const fresh = await bazisCutApi.get(compositionSet.bazisCutSetId);
      setCompositionSet(fresh);
      return fresh;
    } catch {
      return null;
    }
  }, [compositionSet]);

  const closeCompositionModal = useCallback(() => setCompositionRequest(null), []);

  const handleCompositionRefillDisabled = useCallback(() => {
    setCompositionRequest(null);
    setCompositionSet(null);
    setRefillNotConnected(true);
    setMode('new');
  }, []);

  const handleCompositionQueued = useCallback((updatedSet: BazisCutSetCardDto) => {
    setCompositionRequest(null);
    setCompositionSet(null);
    onDone?.(); onClose();
    Modal.confirm({
      title: 'Набор обновлён', content: updatedSet.name,
      okText: 'Открыть набор', cancelText: 'Остаться в заказе',
      onOk: () => navigate(`/bazis-cut/${updatedSet.bazisCutSetId}`),
    });
  }, [navigate, onClose, onDone]);

  return (
    <>
      <Modal title={`Добавить в Базис раскрой (${selectedCount})`} open={open && compositionRequest === null}
        onOk={() => void submit()} onCancel={onClose} confirmLoading={submitting}
        okText="Добавить" cancelText="Отмена"
        okButtonProps={{ disabled: selectedCount === 0 || (mode === 'existing' && !setId) }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {refillNotConnected && (
            <Alert showIcon type="warning"
              message="Добавление деталей в существующий набор пока недоступно в новом производственном учёте — создайте новый набор" />
          )}
          {unavailableText && (
            <Alert showIcon type="warning" message={unavailableText} />
          )}
          <Radio.Group value={mode} onChange={(event) => changeMode(event.target.value)}>
            <Radio value="new">Новый набор</Radio>
            <Radio value="existing">Существующий набор</Radio>
          </Radio.Group>
          {mode === 'new' ? (
            <Alert showIcon type="info" message="Новый набор получит название «БР-<номер набора>»." />
          ) : (
            <Select showSearch allowClear filterOption={false} value={setId} onChange={setSetId}
              onSearch={setSearch} options={options} loading={loading} placeholder="Найти набор"
              notFoundContent={loading ? 'Загрузка…' : 'Наборы не найдены'} style={{ width: '100%' }} />
          )}
          <Alert showIcon type="info" message="В набор сохраняется снимок выбранных деталей. Поздние изменения заказа его не изменят." />
        </Space>
      </Modal>
      <BazisCutCompositionModal
        open={compositionRequest !== null}
        set={compositionSet}
        request={compositionRequest}
        onClose={closeCompositionModal}
        reload={reloadCompositionSet}
        onQueued={handleCompositionQueued}
        onRefillDisabled={handleCompositionRefillDisabled}
      />
    </>
  );
};

async function addToExisting(
  current: BazisCutSetCardDto,
  orderId: number,
  detailIds: number[],
  hdfDetailIds: number[],
  idempotencyKey: string,
  owner: PageOwnedWorkspaceOperationContext,
) {
  owner.assertOwnerCurrent();
  return bazisCutApi.addDetails(current.bazisCutSetId, { orderId, detailIds, hdfDetailIds, expectedVersion: current.version }, { idempotencyKey });
}

function commandKey(prefix: string): string {
  return `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
}
