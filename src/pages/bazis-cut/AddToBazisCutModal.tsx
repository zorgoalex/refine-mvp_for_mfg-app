import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Radio, Select, Space, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { bazisCutApi, type BazisCutSetListItemDto } from '../../api/bazisCutApi';

interface Props {
  open: boolean;
  orderId: number;
  detailIds?: number[];
  hdfDetailIds?: number[];
  onClose: () => void;
  onDone?: () => void;
}

export const AddToBazisCutModal: React.FC<Props> = ({ open, orderId, detailIds = [], hdfDetailIds = [], onClose, onDone }) => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [search, setSearch] = useState('');
  const [sets, setSets] = useState<BazisCutSetListItemDto[]>([]);
  const [setId, setSetId] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const selectedCount = detailIds.length + hdfDetailIds.length;

  useEffect(() => {
    if (!open) return;
    setMode('new'); setSetId(undefined); setSearch('');
  }, [open]);

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

  const submit = useCallback(async () => {
    if (selectedCount === 0) return;
    setSubmitting(true);
    try {
      const idempotencyKey = commandKey('bazis-cut-add');
      const result = mode === 'new'
        ? await bazisCutApi.create({ orderId, detailIds, hdfDetailIds }, { idempotencyKey })
        : await addToExisting(setId, orderId, detailIds, hdfDetailIds, idempotencyKey);
      message.success(result.addedCount === 0 ? 'Эти детали уже есть в наборе' : `Добавлено деталей: ${result.addedCount ?? selectedCount}`);
      onDone?.(); onClose();
      Modal.confirm({
        title: 'Набор обновлён', content: result.set.name,
        okText: 'Открыть набор', cancelText: 'Остаться в заказе',
        onOk: () => navigate(`/bazis-cut/${result.set.bazisCutSetId}`),
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось добавить детали');
    } finally { setSubmitting(false); }
  }, [detailIds, hdfDetailIds, mode, onClose, onDone, orderId, navigate, selectedCount, setId]);

  return (
    <Modal title={`Добавить в Базис раскрой (${selectedCount})`} open={open}
      onOk={() => void submit()} onCancel={onClose} confirmLoading={submitting}
      okText="Добавить" cancelText="Отмена"
      okButtonProps={{ disabled: selectedCount === 0 || (mode === 'existing' && !setId) }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)}>
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
  );
};

async function addToExisting(setId: number | undefined, orderId: number, detailIds: number[], hdfDetailIds: number[], idempotencyKey: string) {
  if (!setId) throw new Error('Выберите набор');
  const current = await bazisCutApi.get(setId);
  return bazisCutApi.addDetails(setId, { orderId, detailIds, hdfDetailIds, expectedVersion: current.version }, { idempotencyKey });
}

function commandKey(prefix: string): string {
  return `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
}
