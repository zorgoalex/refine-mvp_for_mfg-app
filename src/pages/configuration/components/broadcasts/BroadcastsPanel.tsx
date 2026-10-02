import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Modal, Space, Switch, Typography, message } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { broadcastsApi } from '../../../../api/broadcastsApi';
import type {
  BroadcastCaptionVariable,
  BroadcastControl,
  BroadcastEnvelope,
  BroadcastsListResponse,
} from '../../../../api/broadcastsApiTypes';
import { authSession } from '../../../../api/authSession';
import { BroadcastEditor } from './BroadcastEditor';
import { CalendarSendSettings } from './CalendarSendSettings';
import { OrderSendSettings } from './OrderSendSettings';
import { useCalendarSendSupport } from './calendarSendSupport';
import { BroadcastHistory, LegacyDigestHistory } from './BroadcastHistory';
import { BroadcastList } from './BroadcastList';
import { BroadcastPreviewSend } from './BroadcastPreviewSend';
import { broadcastErrorMessage, canCreateBroadcast, runtimeReasonText } from './broadcastModel';
import './broadcasts.css';

const { Paragraph, Text, Title } = Typography;

export interface BroadcastsPanelProps {
  initial: BroadcastsListResponse;
}

export const BroadcastsPanel: React.FC<BroadcastsPanelProps> = ({ initial }) => {
  const actorId = authSession.getUser()?.id ?? '';
  const [data, setData] = useState<BroadcastsListResponse>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | 'new' | null>(null);
  const [envelope, setEnvelope] = useState<BroadcastEnvelope | null>(null);
  const [catalog, setCatalog] = useState<BroadcastCaptionVariable[]>([]);
  const [dirty, setDirty] = useState(false);
  const [historyToken, setHistoryToken] = useState(0);
  const [confirmPause, setConfirmPause] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const { support: calendarSendSupport } = useCalendarSendSupport();
  const mountedRef = useRef(false);
  const catalogRequestedRef = useRef(false);
  const selectRequestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; selectRequestRef.current += 1; };
  }, []);

  const reloadList = useCallback(async () => {
    setLoading(true);
    try {
      const next = await broadcastsApi.list();
      if (mountedRef.current) { setData(next); setError(''); }
    } catch (err) {
      if (mountedRef.current) setError(broadcastErrorMessage(err, 'Не удалось обновить список рассылок.'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const loadEnvelope = useCallback(async (id: number) => {
    const requestId = ++selectRequestRef.current;
    try {
      const next = await broadcastsApi.get(id);
      if (mountedRef.current && requestId === selectRequestRef.current) setEnvelope(next);
    } catch (err) {
      if (mountedRef.current && requestId === selectRequestRef.current) {
        setError(broadcastErrorMessage(err, 'Не удалось загрузить рассылку.'));
        setSelected(null);
        setEnvelope(null);
      }
    }
  }, []);

  const ensureCatalog = useCallback(() => {
    if (catalogRequestedRef.current) return;
    catalogRequestedRef.current = true;
    broadcastsApi.catalog()
      .then((result) => { if (mountedRef.current) setCatalog(result.captionVariables); })
      .catch(() => { catalogRequestedRef.current = false; });
  }, []);

  useEffect(() => {
    if (calendarSendSupport === 'supported') ensureCatalog();
  }, [calendarSendSupport, ensureCatalog]);

  const select = (id: number) => {
    if (id === selected) return;
    if (dirty && !window.confirm('Есть несохранённые изменения. Открыть другую рассылку?')) return;
    ensureCatalog();
    setError('');
    setEnvelope(null);
    setSelected(id);
    void loadEnvelope(id);
  };

  const startCreate = () => {
    ensureCatalog();
    selectRequestRef.current += 1;
    setEnvelope(null);
    setSelected('new');
  };

  const close = () => {
    selectRequestRef.current += 1;
    setSelected(null);
    setEnvelope(null);
    setDirty(false);
  };

  const reloadSelected = () => {
    void reloadList();
    if (typeof selected === 'number') void loadEnvelope(selected);
  };

  const applyControl = async (paused: boolean) => {
    setControlBusy(true);
    try {
      const control = await broadcastsApi.setControl({ version: data.control.version, paused });
      if (!mountedRef.current) return;
      setData((current) => ({ ...current, control }));
      setConfirmPause(false);
      message.success(paused ? 'Все рассылки остановлены.' : 'Рассылки возобновлены.');
    } catch (err) {
      if (!mountedRef.current) return;
      setConfirmPause(false);
      setError(broadcastErrorMessage(err, 'Не удалось изменить состояние рассылок.'));
      void reloadList();
    } finally {
      if (mountedRef.current) setControlBusy(false);
    }
  };

  const runtime = envelope?.runtime ?? data.runtime;
  const runtimeAvailable = runtime.enabled && runtime.relayAvailable;
  const paused = data.control.paused;
  const createAllowed = canCreateBroadcast(data.broadcasts, data.limits.maxActive);
  const current = envelope?.broadcast ?? null;

  return <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <header>
      <Title level={4}>Рассылки</Title>
      <Paragraph type="secondary">Регулярные рассылки заказов в группы WhatsApp. Время рассчитывается по Asia/Almaty.</Paragraph>
    </header>
    <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
      <Space wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={startCreate} disabled={selected === 'new'}>Создать рассылку</Button>
        <Button icon={<ReloadOutlined />} onClick={() => void reloadList()} loading={loading}>Обновить</Button>
        {!createAllowed && <Text type="secondary">Включено {data.limits.maxActive} из {data.limits.maxActive} — новые включённые рассылки недоступны.</Text>}
      </Space>
      <Space>
        <Text>Остановить все рассылки</Text>
        <Switch checked={paused} loading={controlBusy} onChange={(checked) => { if (checked) setConfirmPause(true); else void applyControl(false); }} />
      </Space>
    </Space>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    {paused && <Alert type="warning" showIcon message="Все рассылки остановлены" description={`Автоматическая и ручная отправка не выполняются, пока остановка не снята.${pausedByText(data.control)}`} />}
    {!runtimeAvailable && <Alert type="warning" showIcon message="Автоматическая и ручная отправка сейчас недоступна" description={runtimeReasonText(runtime.unavailableReason)} />}
    <Card title="Список рассылок">
      <BroadcastList broadcasts={data.broadcasts} selectedId={typeof selected === 'number' ? selected : null} loading={loading} onSelect={select} />
    </Card>
    {selected === 'new' && <BroadcastEditor
      key="new"
      broadcast={null}
      todaySchedule={null}
      captionVariables={catalog}
      actorId={actorId}
      createDisabled={!createAllowed}
      onSaved={(saved) => {
        void reloadList();
        selectRequestRef.current += 1;
        setEnvelope(saved);
        setSelected(saved.broadcast.id);
      }}
      onEnvelope={() => undefined}
      onArchived={close}
      onConflict={() => void reloadList()}
      onDirtyChange={setDirty}
      onClose={close}
    />}
    {typeof selected === 'number' && !current && <Card loading />}
    {typeof selected === 'number' && current && <>
      <BroadcastEditor
        key={current.id}
        broadcast={current}
        todaySchedule={envelope?.todaySchedule ?? null}
        captionVariables={catalog}
        actorId={actorId}
        onSaved={(saved) => { setEnvelope(saved); void reloadList(); }}
        onEnvelope={(next) => { setEnvelope(next); }}
        onArchived={() => { close(); void reloadList(); }}
        onConflict={reloadSelected}
        onDirtyChange={setDirty}
        onClose={close}
      />
      <BroadcastPreviewSend
        broadcast={current}
        actorId={actorId}
        dirty={dirty}
        runtimeAvailable={runtimeAvailable}
        paused={paused}
        onSent={() => { setHistoryToken((n) => n + 1); void reloadList(); }}
        onConflict={reloadSelected}
      />
      <BroadcastHistory broadcast={current} actorId={actorId} runtimeAvailable={runtimeAvailable && !paused} refreshToken={historyToken} />
    </>}
    {calendarSendSupport === 'supported' && <CalendarSendSettings captionVariables={catalog} paused={paused} />}
    <OrderSendSettings />
    <LegacyDigestHistory />
    <Modal open={confirmPause} title="Остановить все рассылки" okText="Остановить" cancelText="Отмена" okButtonProps={{ danger: true }} confirmLoading={controlBusy} onCancel={() => setConfirmPause(false)} onOk={() => void applyControl(true)}>
      <Paragraph>Отправка всех рассылок — автоматических и ручных — будет остановлена немедленно. Сообщения, которые ещё не ушли, не будут отправлены, пока остановку не снимут.</Paragraph>
    </Modal>
  </Space>;
};

function pausedByText(control: BroadcastControl): string {
  const who = control.pausedBy?.username ?? (control.pausedBy ? `#${control.pausedBy.id}` : '');
  const when = control.pausedAt ? new Date(control.pausedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }) : '';
  return who || when ? ` Остановил: ${[who, when].filter(Boolean).join(', ')}.` : '';
}
