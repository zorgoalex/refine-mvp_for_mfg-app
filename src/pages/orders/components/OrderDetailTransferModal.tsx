import React from 'react';
import { Alert, Input, Modal, Radio, Select, Space, Spin, Typography, message } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import { ordersApi } from '../../../api/ordersApi';
import type {
  OrderTransferTarget,
  TransferOrderDetailsResponse,
} from '../../../api/types/orderApi.types';

interface OrderDetailTransferModalProps {
  open: boolean;
  sourceOrderId: number;
  sourceOrderName: string;
  sourceVersion: number;
  detailIds: number[];
  canCreateTarget?: boolean;
  onClose: () => void;
  onDone: (response: TransferOrderDetailsResponse) => void;
}

type TargetMode = 'new' | 'existing';

export const OrderDetailTransferModal: React.FC<OrderDetailTransferModalProps> = ({
  open,
  sourceOrderId,
  sourceOrderName,
  sourceVersion,
  detailIds,
  canCreateTarget = true,
  onClose,
  onDone,
}) => {
  const [mode, setMode] = React.useState<TargetMode>('new');
  const [orderName, setOrderName] = React.useState('');
  const [targets, setTargets] = React.useState<OrderTransferTarget[]>([]);
  const [targetId, setTargetId] = React.useState<number | null>(null);
  const [search, setSearch] = React.useState('');
  const [loadingTargets, setLoadingTargets] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setMode(canCreateTarget ? 'new' : 'existing');
    setOrderName(nextSplitName(sourceOrderName));
    setTargetId(null);
    setSearch('');
    setTargets([]);
  }, [canCreateTarget, open, sourceOrderName]);

  const loadTargets = React.useCallback(async (value: string) => {
    setLoadingTargets(true);
    try {
      const response = await ordersApi.listTransferTargets(sourceOrderId, {
        search: value,
        limit: 20,
      });
      setTargets(response.data);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось загрузить заказы');
    } finally {
      setLoadingTargets(false);
    }
  }, [sourceOrderId]);

  React.useEffect(() => {
    if (!open || mode !== 'existing') return;
    const handle = window.setTimeout(() => {
      void loadTargets(search);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [loadTargets, mode, open, search]);

  const selectedTarget = React.useMemo(
    () => targets.find((target) => target.orderId === targetId) ?? null,
    [targetId, targets],
  );

  const canSubmit =
    detailIds.length > 0 &&
    !submitting &&
    (mode === 'new' ? canCreateTarget && orderName.trim().length > 0 : selectedTarget !== null);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const response = await ordersApi.transferDetails(sourceOrderId, {
        sourceVersion,
        detailIds,
        target:
          mode === 'new'
            ? { mode: 'new', orderName: orderName.trim() }
            : {
                mode: 'existing',
                orderId: selectedTarget!.orderId,
                version: selectedTarget!.version,
              },
      });
      onDone(response);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось перенести детали');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Перенести детали"
      okText="Перенести"
      cancelText="Отмена"
      okButtonProps={{ disabled: !canSubmit, icon: <SwapOutlined /> }}
      confirmLoading={submitting}
      onOk={handleSubmit}
      onCancel={submitting ? undefined : onClose}
      destroyOnClose
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={
            <span>
              {sourceOrderName}: <strong>{detailIds.length}</strong> поз.
            </span>
          }
        />

        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          value={mode}
          onChange={(event) => setMode(event.target.value as TargetMode)}
          options={[
            { label: 'Новый заказ', value: 'new', disabled: !canCreateTarget },
            { label: 'Существующий', value: 'existing' },
          ]}
        />

        {mode === 'new' ? (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Typography.Text type="secondary">Номер заказа</Typography.Text>
            <Input
              value={orderName}
              maxLength={200}
              onChange={(event) => setOrderName(event.target.value)}
              autoFocus
            />
          </Space>
        ) : (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Typography.Text type="secondary">Целевой заказ</Typography.Text>
            <Select
              showSearch
              value={targetId ?? undefined}
              placeholder="Найти заказ"
              filterOption={false}
              onSearch={setSearch}
              onChange={(value) => setTargetId(value)}
              notFoundContent={loadingTargets ? <Spin size="small" /> : null}
              options={targets.map((target) => ({
                value: target.orderId,
                label: `${target.orderName}${target.projectCode ? ` · ${target.projectCode}` : ''}`,
              }))}
              style={{ width: '100%' }}
            />
            {selectedTarget && (
              <Typography.Text type="secondary">
                Версия {selectedTarget.version}
                {selectedTarget.orderStatusName ? ` · ${selectedTarget.orderStatusName}` : ''}
                {selectedTarget.productionStatusName ? ` · ${selectedTarget.productionStatusName}` : ''}
              </Typography.Text>
            )}
          </Space>
        )}
      </Space>
    </Modal>
  );
};

function nextSplitName(sourceOrderName: string): string {
  const base = sourceOrderName.trim();
  if (!base) return '';
  return `${base}-1`;
}
