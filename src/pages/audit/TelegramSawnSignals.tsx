import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Empty, Form, InputNumber, Modal, Select, Space, Switch, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Table } from '../../ui/tooltipDelay';
import { cncSawnSignalsApi } from '../../api/cncSawnSignalsApi';
import { ApiError } from '../../api/httpClient';
import type {
  CncSawnApplyConfirmResult,
  CncSawnApplyPreviewItem,
  CncSawnSignalItem,
  CncSawnSignalSettings,
  CncSawnSignalsQuery,
} from '../../api/types/cncSawnSignals.types';
import { can } from '../../utils/permissions';
import {
  buildSawnConfirmItems,
  buildSawnSignalsQuery,
  sawnEligibleIds,
  sawnReactorText,
  SAWN_APPLY_RESULT_COLORS,
  SAWN_APPLY_RESULT_LABELS,
  SAWN_APPLY_STATE_COLORS,
  SAWN_APPLY_STATE_LABELS,
  SAWN_APPLY_STATE_OPTIONS,
  SAWN_BLOCKED_REASON_LABELS,
  SAWN_ORIGIN_LABELS,
  SAWN_ROLE_LABELS,
  type SawnFilterValues,
} from './sawnSignals';

const { Text } = Typography;

function formatDateTime(value: string | null | undefined): string {
  return value ? dayjs(value).format('DD.MM.YYYY HH:mm:ss') : '—';
}

function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError && caught.status === 403) return 'Недостаточно прав.';
  return caught instanceof Error ? caught.message : fallback;
}

function PreviewEffect({ item }: { item: CncSawnApplyPreviewItem }) {
  const { details, orders, events } = item.effect;
  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      {details.map((d) => (
        <Text key={d.detailId} className="tg-audit-num">
          Заказ {d.orderName}, деталь {d.detailNumber ?? `#${d.detailId}`}: {d.statusBefore ?? '—'} → {d.statusAfter ?? '—'}
        </Text>
      ))}
      {orders.map((o) => (
        <Text key={`o${o.orderId}`} type="secondary" className="tg-audit-num">
          Заказ {o.orderName}: статус {o.orderStatusBefore ?? '—'} → {o.orderStatusAfter ?? '—'}; производство {o.productionStatusBefore ?? '—'} → {o.productionStatusAfter ?? '—'}
        </Text>
      ))}
      {events.length > 0 && <Text type="secondary">События: {events.join(', ')}</Text>}
      {details.length === 0 && orders.length === 0 && <Text type="secondary">Изменений деталей нет</Text>}
    </Space>
  );
}

function ApplyPendingModal({ open, onClose, onApplied }: { open: boolean; onClose: () => void; onApplied: () => void }) {
  const [items, setItems] = useState<CncSawnApplyPreviewItem[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [results, setResults] = useState<CncSawnApplyConfirmResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true); setError(null); setResults(null);
    try {
      const response = await cncSawnSignalsApi.applyPreview();
      setItems(response.items);
      setSelected(sawnEligibleIds(response.items));
    } catch (caught) {
      setItems([]); setSelected([]);
      setError(errorText(caught, 'Не удалось получить предпросмотр.'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open) void loadPreview(); }, [open, loadPreview]);

  const confirmItems = buildSawnConfirmItems(items, selected);
  const apply = async () => {
    if (confirmItems.length === 0) return;
    setApplying(true); setError(null);
    try {
      const response = await cncSawnSignalsApi.applyConfirm(confirmItems);
      setResults(response.results);
      onApplied();
    } catch (caught) {
      setError(errorText(caught, 'Не удалось применить сигналы.'));
    } finally { setApplying(false); }
  };
  const resultById = new Map((results ?? []).map((r) => [r.packetSignalId, r]));

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="Применить накопленные сигналы «Распилено»"
      width={900}
      destroyOnClose
      footer={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void loadPreview()} disabled={loading || applying}>Обновить предпросмотр</Button>,
        <Button key="close" onClick={onClose}>Закрыть</Button>,
        <Button key="apply" type="primary" loading={applying} disabled={confirmItems.length === 0 || results !== null} onClick={() => void apply()}>
          Применить{confirmItems.length > 0 ? ` (${confirmItems.length})` : ''}
        </Button>,
      ]}
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Table<CncSawnApplyPreviewItem>
        rowKey="packetSignalId"
        size="small"
        loading={loading}
        dataSource={items}
        pagination={false}
        scroll={{ y: 420 }}
        locale={{ emptyText: <Empty description="Накопленных сигналов нет" /> }}
        columns={[
          {
            title: '', key: 'select', width: 44,
            render: (_, item) => (
              <Checkbox
                disabled={!item.eligible || results !== null}
                checked={selected.includes(item.packetSignalId)}
                onChange={(event) => setSelected((current) => event.target.checked
                  ? [...current, item.packetSignalId]
                  : current.filter((id) => id !== item.packetSignalId))}
                aria-label={`Применить сигнал раскроя ${item.cuttingSequenceNo ?? item.packetSignalId}`}
              />
            ),
          },
          { title: '№ раскроя', key: 'seq', width: 100, render: (_, item) => <Text className="tg-audit-num">{item.cuttingSequenceNo ?? '—'}</Text> },
          { title: 'Состояние', key: 'state', width: 210, render: (_, item) => <Tag color={SAWN_APPLY_STATE_COLORS[item.applyState]}>{SAWN_APPLY_STATE_LABELS[item.applyState] ?? item.applyState}</Tag> },
          {
            title: 'Что изменится', key: 'effect',
            render: (_, item) => item.eligible
              ? <PreviewEffect item={item} />
              : <Text type="danger">{item.blockedReason ? SAWN_BLOCKED_REASON_LABELS[item.blockedReason] ?? item.blockedReason : 'Нельзя применить'}</Text>,
          },
          {
            title: 'Результат', key: 'result', width: 200,
            render: (_, item) => {
              const result = resultById.get(item.packetSignalId);
              if (!result) return null;
              return (
                <Space direction="vertical" size={0}>
                  <Tag color={SAWN_APPLY_RESULT_COLORS[result.result]}>{SAWN_APPLY_RESULT_LABELS[result.result] ?? result.result}</Tag>
                  {result.reason && <Text type="secondary">{SAWN_BLOCKED_REASON_LABELS[result.reason] ?? result.reason}</Text>}
                </Space>
              );
            },
          },
        ]}
      />
    </Modal>
  );
}

export const TelegramSawnSignals: React.FC = () => {
  const [form] = Form.useForm<SawnFilterValues>();
  const [query, setQuery] = useState<CncSawnSignalsQuery>(() => buildSawnSignalsQuery({}));
  const [data, setData] = useState<CncSawnSignalItem[]>([]);
  const [settings, setSettings] = useState<CncSawnSignalSettings | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const canManage = can('cut.manage');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await cncSawnSignalsApi.list(query);
      setData(response.items); setTotal(response.total); setSettings(response.settings);
    } catch (caught) {
      setData([]); setTotal(0);
      setError(errorText(caught, 'Не удалось загрузить сигналы.'));
    } finally { setLoading(false); }
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ padding: '0 8px 16px' }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {settings && (
          <Alert
            type={settings.applyToPacket ? 'success' : 'info'}
            showIcon
            message={`Перенос в «Распилено» по 👍: ${settings.applyToPacket ? 'включён' : 'выключен'}`}
            description="Сигнал из чата фиксируется в журнале всегда. Переключатель находится в «Настройки → Автостатусы»."
          />
        )}
        {error && <Alert type="error" showIcon message={error} />}
        <Form
          form={form}
          layout="inline"
          className="tg-audit-controls"
          initialValues={{ openOnly: false }}
          onFinish={(values) => setQuery(buildSawnSignalsQuery(values, 1, query.pageSize ?? 50))}
        >
          <Form.Item name="period"><DatePicker.RangePicker allowClear /></Form.Item>
          <Form.Item name="cuttingSequenceNo"><InputNumber min={1} precision={0} placeholder="№ раскроя" style={{ width: 130 }} /></Form.Item>
          <Form.Item name="applyState"><Select allowClear placeholder="Применение" style={{ width: 280 }} options={SAWN_APPLY_STATE_OPTIONS} /></Form.Item>
          <Form.Item name="openOnly" valuePropName="checked" label="Только открытые"><Switch /></Form.Item>
          <Form.Item>
            <Space wrap>
              <Button type="primary" htmlType="submit">Показать</Button>
              <Button icon={<ReloadOutlined />} onClick={() => void load()}>Обновить</Button>
              {canManage && <Button onClick={() => setApplyOpen(true)}>Применить накопленные…</Button>}
            </Space>
          </Form.Item>
        </Form>
        <Table<CncSawnSignalItem>
          rowKey="signalId"
          size="middle"
          loading={loading}
          dataSource={data}
          scroll={{ x: 1300 }}
          locale={{ emptyText: <Empty description="Сигналов нет" /> }}
          pagination={{ current: query.page ?? 1, pageSize: query.pageSize ?? 50, total, showSizeChanger: true }}
          onChange={(next) => setQuery((current) => ({ ...current, page: next.current ?? 1, pageSize: next.pageSize ?? 50 }))}
          columns={[
            { title: 'ERP увидела', dataIndex: 'firstObservedAt', key: 'firstObservedAt', width: 150, render: (v: string) => <Text className="tg-audit-num">{formatDateTime(v)}</Text> },
            {
              title: '№ раскроя', key: 'seq', width: 110,
              render: (_, r) => r.cuttingSequenceNo == null && !r.cutJobDisplayNumber ? '—' : (
                <Text className="tg-audit-num">{r.cuttingSequenceNo ?? '—'}{r.cutJobDisplayNumber ? ` (${r.cutJobDisplayNumber})` : ''}</Text>
              ),
            },
            {
              title: 'Сообщение', key: 'message', width: 170,
              render: (_, r) => (
                <Space size={4}><Text className="tg-audit-num">#{r.messageId}</Text><Tag>{SAWN_ROLE_LABELS[r.messageRole] ?? r.messageRole}</Tag></Space>
              ),
            },
            { title: 'Кто', key: 'reactor', width: 180, render: (_, r) => r.reactor ? <Text>{sawnReactorText(r.reactor)}</Text> : <Text type="secondary">скрыто Telegram</Text> },
            { title: 'Поставлен', key: 'reactedAt', width: 160, render: (_, r) => r.reactedAt ? <Text className="tg-audit-num">{formatDateTime(r.reactedAt)}</Text> : <Text type="secondary">≈ при наблюдении</Text> },
            { title: 'Снят (замечено)', dataIndex: 'clearedObservedAt', key: 'clearedObservedAt', width: 150, render: (v: string | null) => <Text className="tg-audit-num">{formatDateTime(v)}</Text> },
            { title: 'Сообщение удалено', dataIndex: 'messageMissingObservedAt', key: 'messageMissingObservedAt', width: 150, render: (v: string | null) => <Text className="tg-audit-num">{formatDateTime(v)}</Text> },
            { title: 'Источник', dataIndex: 'origin', key: 'origin', width: 110, render: (v: CncSawnSignalItem['origin']) => <Tag>{SAWN_ORIGIN_LABELS[v] ?? v}</Tag> },
            {
              title: 'Применение', key: 'apply', width: 260,
              render: (_, r) => r.packetSignal ? (
                <Space size={4} wrap>
                  <Tag color={SAWN_APPLY_STATE_COLORS[r.packetSignal.applyState]}>{SAWN_APPLY_STATE_LABELS[r.packetSignal.applyState] ?? r.packetSignal.applyState}</Tag>
                  {r.packetSignal.freshness === 'late' && <Tag color="orange">поздний</Tag>}
                  {r.packetSignal.appliedAt && <Text type="secondary" className="tg-audit-num">{formatDateTime(r.packetSignal.appliedAt)}</Text>}
                </Space>
              ) : <Text type="secondary">—</Text>,
            },
          ]}
        />
      </Space>
      {canManage && <ApplyPendingModal open={applyOpen} onClose={() => setApplyOpen(false)} onApplied={() => void load()} />}
    </div>
  );
};
