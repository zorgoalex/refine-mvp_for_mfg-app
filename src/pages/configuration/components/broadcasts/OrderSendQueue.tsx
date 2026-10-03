import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Popconfirm, Radio, Space, Table, Tag, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { ApiError } from '../../../../api/apiError';
import { authSession } from '../../../../api/authSession';
import { orderSendApi } from '../../../../api/orderSendApi';
import type { OrderSendQueue as QueueResponse, OrderSendQueueItem } from '../../../../api/orderSendApiTypes';
import { can } from '../../../../utils/permissions';
import {
  isOrderSendCancellable,
  orderSendMoment,
  orderSendRecipientText,
  orderSendStateColor,
  orderSendStateDetail,
  orderSendStateLabel,
  orderSendWhenText,
} from './orderSendQueueModel';

const { Text } = Typography;
const REFRESH_MS = 15_000;

/**
 * «Очередь отправок из карточки» (whatsapp.manage): what waits, when it is expected to leave and its
 * status; the finished sends of 7 days; a waiting send can be cancelled. Hidden on an older backend (404).
 */
export const OrderSendQueue: React.FC = () => {
  const allowed = can('whatsapp.manage', authSession.getUser());
  const [history, setHistory] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const requestRef = useRef(0);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!allowed) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const next = await orderSendApi.queue(history, page);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setData(next);
      setError('');
    } catch (err) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      if (err instanceof ApiError && err.status === 404) setUnsupported(true);
      else setError('Не удалось загрузить очередь отправок');
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [allowed, history, page]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    // The waiting list refreshes while the tab is visible; history only on demand.
    const timer = window.setInterval(() => {
      if (!history && document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => { mountedRef.current = false; window.clearInterval(timer); };
  }, [load, history]);

  const cancel = async (item: OrderSendQueueItem) => {
    setCancelling((keys) => new Set(keys).add(item.sendId));
    try {
      const result = await orderSendApi.cancel(item.sendId);
      if (result.send.state === 'cancelled') message.success('Отправка отменена');
      else message.info(`Отправка уже завершилась: ${orderSendStateLabel(result.send.state).toLowerCase()}`);
    } catch (err) {
      message.error(err instanceof ApiError && err.code === 'ORDER_SEND_NOT_CANCELLABLE'
        ? 'Отправка уже уходит в WhatsApp — отменить нельзя' : 'Не удалось отменить отправку');
    } finally {
      setCancelling((keys) => { const next = new Set(keys); next.delete(item.sendId); return next; });
      void load();
    }
  };

  if (!allowed || unsupported) return null;

  const paused = Boolean(data?.paused);
  const columns = [
    ...(!history ? [{ title: '№', dataIndex: 'position', key: 'position', width: 48 }] : []),
    { title: history ? 'Завершено' : '≈ Когда', key: 'when', width: 130,
      render: (_: unknown, item: OrderSendQueueItem) => <Text type={item.mayExpire ? 'warning' : undefined}>{orderSendWhenText(item, paused)}</Text> },
    { title: 'Заказ', key: 'order', render: (_: unknown, item: OrderSendQueueItem) =>
      <Link to={`/orders/show/${item.orderId}`}>{item.orderName ?? `#${item.orderId}`}</Link> },
    { title: 'Получатель', key: 'recipient', render: (_: unknown, item: OrderSendQueueItem) => orderSendRecipientText(item) },
    { title: 'Форма', key: 'form', render: (_: unknown, item: OrderSendQueueItem) =>
      item.partsTotal && item.partsTotal > 1 ? `${item.formTitle} (${item.partsTotal} изобр.)` : item.formTitle },
    { title: 'Автор', key: 'actor', render: (_: unknown, item: OrderSendQueueItem) => item.actor.username ?? `#${item.actor.id}` },
    { title: 'Поставлено', key: 'created', width: 110, render: (_: unknown, item: OrderSendQueueItem) => orderSendMoment(item.createdAt) },
    { title: 'Статус', key: 'state', render: (_: unknown, item: OrderSendQueueItem) => {
      const detail = orderSendStateDetail(item);
      return <Space size={4} wrap><Tag color={orderSendStateColor(item.state)}>{orderSendStateLabel(item.state)}</Tag>
        {detail && <Text type="secondary">{detail}</Text>}</Space>;
    } },
    ...(!history ? [{ title: '', key: 'actions', width: 110, render: (_: unknown, item: OrderSendQueueItem) => isOrderSendCancellable(item)
      ? <Popconfirm title="Отменить эту отправку?" okText="Отменить отправку" cancelText="Нет" onConfirm={() => void cancel(item)}>
        <Button size="small" danger loading={cancelling.has(item.sendId)}>Отменить</Button>
      </Popconfirm>
      : null }] : []),
  ];

  const summary = data && !history
    ? `В очереди: ${data.queueLength}${data.nextDeliveryAt ? `, следующая ≈ ${orderSendMoment(data.nextDeliveryAt)}` : ''}. Порог ${data.minIntervalMinutes} мин`
      + `${data.sendWindowMinutes ? `, окно ${data.sendWindowMinutes} мин` : ''}.`
    : null;

  return <Card title="Очередь отправок из карточки"
    extra={<Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>Обновить</Button>}>
    <Space direction="vertical" style={{ width: '100%' }}>
      <Radio.Group value={history ? 'history' : 'queue'} optionType="button" buttonStyle="solid"
        onChange={(event) => { setHistory(event.target.value === 'history'); setPage(1); }}
        options={[{ label: 'Ожидают', value: 'queue' }, { label: 'История (7 дней)', value: 'history' }]} />
      {error && <Alert type="error" showIcon message={error} />}
      {paused && !history && <Alert type="warning" showIcon message="Все рассылки остановлены: очередь ждёт, пока их не возобновят." />}
      {data && !data.enabled && !history && <Alert type="info" showIcon message="Отправка из карточки выключена." />}
      {summary && <Text type="secondary">{summary}</Text>}
      <Table<OrderSendQueueItem> size="small" rowKey="sendId" loading={loading && !data} dataSource={data?.items ?? []}
        columns={columns} scroll={{ x: true }}
        locale={{ emptyText: history ? 'За 7 дней отправок не было' : 'Очередь пуста' }}
        pagination={history ? { current: page, pageSize: data?.pageSize || 50, total: data?.total ?? 0, onChange: setPage, showSizeChanger: false } : false} />
    </Space>
  </Card>;
};
