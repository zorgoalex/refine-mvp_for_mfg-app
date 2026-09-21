import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, DatePicker, Descriptions, Drawer, Empty, Input, InputNumber, Modal, Select, Space, Switch, Tag, Timeline, Typography } from 'antd';
import { Table } from '../../ui/tooltipDelay';
import { inboundSignalsApi as api, type SignalDetail, type SignalList, type SignalPreview, type SignalRow } from '../../api/inboundSignalsApi';
import { can } from '../../utils/permissions';
import { signalLabel, signalLabels } from './labels';

const states = ['needs_review','pending','processing','retry_wait','succeeded','no_action','failed','dismissed'];
const date = (value: string) => new Date(value).toLocaleString('ru-RU');
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось загрузить данные. Повторите попытку.';
export function InboundSignalsList() {
  const allowed = can('message_signals.view'), resolve = can('message_signals.resolve'), technicalAllowed = can('message_signals.technical');
  const [query, setQuery] = useState<Record<string, string | number | undefined>>({ page: 1, pageSize: 50 });
  const [data, setData] = useState<SignalList>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [lastLoaded, setLastLoaded] = useState('');
  const [technical, setTechnical] = useState(false), [selected, setSelected] = useState<string>(), [detail, setDetail] = useState<SignalDetail>();
  const [detailError, setDetailError] = useState(''), [acting, setActing] = useState(false);
  const [order, setOrder] = useState<string>(), [orders, setOrders] = useState<{ id: string; name: string }[]>([]);
  const [preview, setPreview] = useState<SignalPreview>(), [reason, setReason] = useState('false_match');
  const listGeneration = useRef(0), detailGeneration = useRef(0), searchGeneration = useRef(0);
  const commandKey = useRef<{ intent: string; key: string }>();
  const load = useCallback(async () => {
    if (!allowed) return;
    const generation = ++listGeneration.current;
    setBusy(true);
    try { const next = await api.list(query); if (generation === listGeneration.current) { setData(next); setError(''); setLastLoaded(new Date().toLocaleTimeString('ru-RU')); } }
    catch (e) { if (generation === listGeneration.current) setError(errorText(e)); }
    finally { if (generation === listGeneration.current) setBusy(false); }
  }, [allowed, query]);
  const loadDetail = useCallback(async () => {
    if (!selected) return;
    const generation = ++detailGeneration.current;
    try { const next = await api.detail(selected); if (generation === detailGeneration.current) { setDetail(next); setDetailError(''); } }
    catch (e) { if (generation === detailGeneration.current) setDetailError(errorText(e)); }
  }, [selected]);
  useEffect(() => { void load(); return () => { listGeneration.current++; }; }, [load]);
  useEffect(() => { setDetail(undefined); setPreview(undefined); setOrder(undefined); setDetailError(''); void loadDetail(); return () => { detailGeneration.current++; }; }, [loadDetail]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') { void load(); if (!acting) void loadDetail(); } };
    const timer = window.setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [load, loadDetail, acting]);
  const filter = (key: string, value: string | number | undefined) => { setData(undefined); setQuery(q => ({ ...q, [key]: value, page: 1 })); };
  const searchOrders = async (text: string) => {
    const generation = ++searchGeneration.current;
    try { const result = await api.orders(text); if (generation === searchGeneration.current) setOrders(result); }
    catch (e) { setDetailError(errorText(e)); }
  };
  const execute = async (action: 'resolve'|'dismiss'|'retry') => {
    if (!detail) return;
    setActing(true); setDetailError('');
    const body = { version: detail.version, ...(action === 'resolve' ? { orderId: Number(order), previewHash: preview?.previewHash } : {}), ...(action === 'dismiss' ? { reason } : {}) };
    const intent = JSON.stringify([detail.id, action, body]);
    if (commandKey.current?.intent !== intent) commandKey.current = { intent, key: crypto.randomUUID() };
    try { await api.command(detail.id, action, body, commandKey.current.key); setPreview(undefined); await Promise.all([load(), loadDetail()]); }
    catch (e) { setDetailError(errorText(e)); }
    finally { setActing(false); }
  };
  if (!allowed) return <Alert type="warning" message="Нет доступа к входящим сигналам" />;
  const columns = [
    { title: 'Получено', dataIndex: 'received_at', width: 165, render: (v: string) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{date(v)}</span> },
    { title: 'Источник', dataIndex: 'source_name', width: 160, render: (v: string, r: SignalRow) => <><div>{v}</div><Typography.Text type="secondary">{r.channel === 'whatsapp' ? 'WhatsApp' : r.channel}</Typography.Text></> },
    { title: 'Сообщение', dataIndex: 'message_text', render: (v: string) => <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: 500 }}>{v}</div> },
    { title: 'Сигнал', dataIndex: 'signal_name', width: 170, render: (v: string | null) => v ?? 'Нет совпадения' },
    { title: 'Заказ', dataIndex: 'order_name', width: 140, render: (v: string | null, r: SignalRow) => v ?? (r.order_id ? `№${r.order_id}` : 'Не определён') },
    { title: 'Результат', dataIndex: 'state', width: 220, render: (v: string | null, r: SignalRow) => <><Tag color={v === 'succeeded' ? 'green' : ['failed','needs_review'].includes(v ?? '') ? 'orange' : undefined}>{technical ? v ?? 'unmatched' : signalLabel(v)}</Tag>{r.reason_code && <div>{technical ? r.reason_code : signalLabel(r.reason_code)}</div>}</> },
    { title: '', key: 'open', width: 110, render: (_: unknown, r: SignalRow) => r.id && <Button style={{ minHeight: 40 }} onClick={() => setSelected(r.id!)}>Подробнее</Button> },
  ];
  return <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <Typography.Title level={2}>Входящие сигналы</Typography.Title>
    <Typography.Paragraph type="secondary">Ключевые сообщения из подключённых каналов, найденные заказы и результат действий системы. История хранится 90 дней.</Typography.Paragraph>
    {error && <Alert type="error" showIcon message="Не удалось обновить журнал" description={error} action={<Button onClick={() => void load()}>Повторить</Button>} />}
    {data && (!data.relayEnabled || !data.automationEnabled) && <Alert type="warning" showIcon message="Сообщения принимаются, действия приостановлены" description={!data.relayEnabled ? 'Обработчик очереди выключен. Сигналы будут ожидать запуска.' : 'Автостатусы выключены. Сигналы будут ожидать включения.'} />}
    <Card><Space wrap>
      <Input.Search aria-label="Поиск в сообщениях" placeholder="Текст сообщения" allowClear onSearch={v => filter('q', v)} style={{ width: 240 }} />
      <Select aria-label="Состояние сигнала" placeholder="Все состояния" allowClear style={{ width: 240 }} options={states.map(value => ({ value, label: signalLabel(value) }))} onChange={v => filter('state', v)} />
      <Select aria-label="Канал" placeholder="Все каналы" allowClear style={{ width: 150 }} options={[{ value: 'whatsapp', label: 'WhatsApp' }]} onChange={v => filter('channel', v)} />
      <Input.Search aria-label="Код источника" placeholder="Код источника" onSearch={v => filter('source', v)} style={{ width: 170 }} />
      <Input.Search aria-label="Код сигнала" placeholder="Код сигнала" onSearch={v => filter('signal', v)} style={{ width: 170 }} />
      <InputNumber aria-label="ID заказа" placeholder="ID заказа" min={1} onChange={v => filter('orderId', v ?? undefined)} />
      <DatePicker.RangePicker onChange={v => setQuery(q => ({ ...q, page: 1, from: v?.[0]?.startOf('day').toISOString(), to: v?.[1]?.endOf('day').toISOString() }))} />
      {resolve && <Space><Switch aria-label="Включая сообщения без совпадений" onChange={v => filter('diagnostic', String(v))} />Включая сообщения без совпадений</Space>}
    </Space></Card>
    <Space wrap>
      <Button loading={busy} onClick={() => { void load(); void loadDetail(); }}>Обновить</Button>
      <Typography.Text type="secondary">{lastLoaded ? `Обновлено ${lastLoaded} · каждые 15 сек.` : 'Загружаем журнал…'}</Typography.Text>
      {data && <Typography.Text>Найдено: {data.total} · Нужно проверить: {data.attention} · Обработано: {data.completed}</Typography.Text>}
      {technicalAllowed && <Space><Switch aria-label="Технический вид" checked={technical} onChange={setTechnical} />Технический вид</Space>}
    </Space>
    <Table<SignalRow> rowKey={r => r.id ?? `message-${r.message_id}`} loading={busy} dataSource={data?.items ?? []} columns={columns} scroll={{ x: 1100 }}
      locale={{ emptyText: <Empty description="Сигналов пока нет. Проверьте подключённые группы, правила и выбранные фильтры." /> }}
      pagination={{ current: Number(query.page), pageSize: 50, total: data?.total ?? 0, showSizeChanger: false, onChange: page => setQuery(q => ({ ...q, page })) }} />
    <Drawer title="История сигнала" open={Boolean(selected)} width={720} onClose={() => setSelected(undefined)}>
      {detailError && <Alert type="error" message={detailError} action={<Button onClick={() => void loadDetail()}>Обновить</Button>} />}
      {!detail && !detailError && <Typography.Text>Загрузка…</Typography.Text>}
      {detail && <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Descriptions column={1}>{[
          { key: 'signal', label: 'Сигнал', children: detail.signalName }, { key: 'state', label: 'Результат', children: signalLabel(detail.state) },
          { key: 'source', label: 'Источник', children: detail.message.source_name }, { key: 'sender', label: 'Автор', children: detail.message.sender || 'Не указан каналом' },
          { key: 'date', label: 'Отправлено', children: date(detail.message.sent_at) }, { key: 'order', label: 'ID заказа', children: detail.orderId ?? 'Нужно уточнить' },
        ].map(item => <Descriptions.Item key={item.key} label={item.label}>{item.children}</Descriptions.Item>)}</Descriptions>
        <Card title="Исходное сообщение"><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{detail.message.message_text}</div></Card>
        <Timeline>{detail.steps.map((step, i) => <Timeline.Item key={i}><div>{technical ? step.event_code : signalLabel(step.event_code)}</div><Typography.Text type="secondary">{date(step.occurred_at)}</Typography.Text>{typeof step.details.reason === 'string' && <div>{signalLabel(step.details.reason)}</div>}{technical && <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(step.details, null, 2)}</pre>}</Timeline.Item>)}</Timeline>
        <Card title="Правила автостатусов">{detail.actions.length ? detail.actions.map((a, i) => <p key={i}>{a.rule_name} — {a.event.endsWith('rule_applied') ? 'Действие выполнено' : 'Условия не выполнены'}{technical && ` (${a.reason ?? a.action_type})`}</p>) : 'Действий пока нет.'}</Card>
        {technical && detail.technical && <Card title="Диагностика"><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(detail.technical, null, 2)}</pre></Card>}
        {resolve && detail.state === 'needs_review' && <Card title="Уточнить заказ"><Space direction="vertical" style={{ width: '100%' }}>
          <Select aria-label="Заказ для сигнала" showSearch filterOption={false} placeholder="Найдите заказ по имени или ID" style={{ width: '100%' }} value={order}
            onSearch={v => void searchOrders(v)} onFocus={() => void searchOrders('')} options={orders.map(o => ({ value: String(o.id), label: `${o.name} · ID ${o.id}` }))}
            onChange={v => { setOrder(v); setPreview(undefined); }} />
          <Button disabled={!order || acting} onClick={async () => { setActing(true); try { setPreview(await api.preview(detail.id, detail.version, Number(order))); setDetailError(''); } catch (e) { setDetailError(errorText(e)); } finally { setActing(false); } }}>Проверить действия</Button>
          {preview && <><Alert type="info" message={`Заказ: ${preview.order.order_name}`} description={preview.applied.length ? `Сработают правила: ${preview.applied.map(r => r.name).join(', ')}` : 'Подходящих правил автостатусов нет. Сигнал будет обработан без изменений.'} />
            <Button type="primary" loading={acting} disabled={preview.version !== detail.version} onClick={() => Modal.confirm({ title: 'Привязать сигнал и запустить обработку?', content: 'Система сможет изменить статусы выбранного заказа по показанным правилам.', okText: 'Привязать и обработать', cancelText: 'Отмена', onOk: () => execute('resolve') })}>Привязать и обработать</Button></>}
        </Space></Card>}
        {resolve && ['needs_review','failed'].includes(detail.state) && <Space wrap>
          <Select aria-label="Причина исключения" value={reason} onChange={setReason} style={{ width: 230 }} options={['false_match','irrelevant','duplicate','other'].map(value => ({ value, label: signalLabels[value] }))} />
          <Button disabled={acting} onClick={() => Modal.confirm({ title: 'Не учитывать этот сигнал?', content: signalLabels[reason], okText: 'Не учитывать', cancelText: 'Отмена', onOk: () => execute('dismiss') })}>Не учитывать</Button>
          {detail.state === 'failed' && <Button loading={acting} onClick={() => void execute('retry')}>Повторить обработку</Button>}
        </Space>}
      </Space>}
    </Drawer>
  </Space>;
}
