import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Modal, Space, Typography, message } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { broadcastsApi } from '../../../../api/broadcastsApi';
import type { Broadcast, BroadcastPreview } from '../../../../api/broadcastsApiTypes';
import {
  broadcastErrorMessage,
  clearPendingManualSend,
  createUuid,
  formatArea,
  isKnownNotQueuedError,
  isVersionConflict,
  persistPendingManualSend,
  readPendingManualSend,
  runPendingCommand,
  STORAGE_UNAVAILABLE_MESSAGE,
  weekdayDate,
  type PendingManualSend,
} from './broadcastModel';
import { WhatsAppGroupLabel } from '../WhatsAppGroupLabel';
import './broadcasts.css';

const { Paragraph, Text } = Typography;

export interface BroadcastPreviewSendProps {
  broadcast: Broadcast;
  actorId: string;
  /** Unsaved edits in the editor: preview/send use saved settings only. */
  dirty: boolean;
  runtimeAvailable: boolean;
  paused: boolean;
  onSent: () => void;
  onConflict: () => void;
}

export const BroadcastPreviewSend: React.FC<BroadcastPreviewSendProps> = ({ broadcast, actorId, dirty, runtimeAvailable, paused, onSent, onConflict }) => {
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [, setTick] = useState(0);
  const pendingRef = useRef<PendingManualSend | null>(readPendingManualSend(broadcast.id, actorId));
  const previewRequestRef = useRef(0);
  const broadcastIdRef = useRef(broadcast.id);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; previewRequestRef.current += 1; };
  }, []);

  useEffect(() => {
    // Switching broadcast: drop the view state and pick up that broadcast's own pending key.
    pendingRef.current = readPendingManualSend(broadcast.id, actorId);
    broadcastIdRef.current = broadcast.id;
    previewRequestRef.current += 1;
    setPreview(null);
    setConfirmSend(false);
    setError('');
    setTick((n) => n + 1);
  }, [broadcast.id, actorId]);

  const pending = pendingRef.current;
  const uncertain = Boolean(pending?.ambiguous) && !sending;
  const canSend = Boolean(pending) || (!dirty && runtimeAvailable && !paused && Boolean(broadcast.groupChatId) && preview !== null && !preview.empty);

  const createPreview = async () => {
    const requestId = ++previewRequestRef.current;
    setPreviewLoading(true);
    setError('');
    setPreview(null);
    try {
      const result = await broadcastsApi.preview(broadcast.id);
      if (mountedRef.current && requestId === previewRequestRef.current) setPreview(result);
    } catch (err) {
      if (mountedRef.current && requestId === previewRequestRef.current) setError(broadcastErrorMessage(err, 'Не удалось сформировать предпросмотр.'));
    } finally {
      if (mountedRef.current && requestId === previewRequestRef.current) setPreviewLoading(false);
    }
  };

  const sendNow = async () => {
    if (!pendingRef.current && !canSend) return;
    const broadcastId = broadcast.id;
    setSending(true);
    setError('');
    const outcome = await runPendingCommand<PendingManualSend, unknown>({
      stored: pendingRef.current,
      fresh: () => ({ actorId, payload: { settingsVersion: broadcast.version, idempotencyKey: createUuid(), confirmed: true } }),
      persist: (request) => {
        pendingRef.current = request;
        return persistPendingManualSend(broadcastId, request);
      },
      clear: () => clearPendingManualSend(broadcastId),
      send: (request) => broadcastsApi.send(broadcastId, request.payload),
      isDefinite: isKnownNotQueuedError,
    });
    // The component may have switched to another broadcast meanwhile: touch only this one's key.
    const current = broadcastIdRef.current === broadcastId;
    if (current && outcome.status !== 'uncertain') pendingRef.current = null;
    if (!mountedRef.current) return;
    setSending(false);
    setConfirmSend(false);
    if (!current) return;
    if (outcome.status === 'done') {
      message.success(outcome.replayed ? 'Ручная рассылка подтверждена.' : 'Ручная рассылка поставлена в очередь.');
      onSent();
    } else if (outcome.status === 'not-stored') {
      setError(STORAGE_UNAVAILABLE_MESSAGE);
    } else if (outcome.status === 'refused') {
      if (isVersionConflict(outcome.error)) onConflict();
      setError(broadcastErrorMessage(outcome.error, 'Не удалось поставить рассылку в очередь.'));
    } else {
      setError('Не удалось подтвердить результат. При повторе будет проверен тот же запрос, без создания нового запуска.');
    }
    setTick((n) => n + 1);
  };

  return <Card title="Предпросмотр и ручная отправка" extra={<Text type="secondary">Ручные действия не зависят от переключателя расписания.</Text>}>
    {error && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={error} closable onClose={() => setError('')} />}
    {dirty && <Alert style={{ marginBottom: 12 }} type="info" showIcon message="Сначала сохраните изменения" description="Предпросмотр и ручная отправка используют только сохранённые настройки." />}
    {paused && <Alert style={{ marginBottom: 12 }} type="warning" showIcon message="Все рассылки остановлены" description="Ручная отправка недоступна, пока не снята общая остановка." />}
    <Space wrap>
      <Button onClick={() => void createPreview()} loading={previewLoading} disabled={dirty}>Показать предпросмотр</Button>
      <Button type="primary" icon={<SendOutlined />} onClick={() => setConfirmSend(true)} disabled={!canSend}>Отправить сейчас</Button>
    </Space>
    {preview && <div style={{ marginTop: 16 }}>
      <Alert type={preview.empty ? 'info' : 'success'} showIcon message={preview.empty
        ? 'На выбранную дату заказов нет — сообщение не отправится.'
        : `Заказы на ${weekdayDate(preview.targetDate)} · ${preview.orderCount} заказов · ${formatArea(preview.totalArea)}`} />
      {preview.caption && <Paragraph style={{ marginTop: 8 }}>Подпись: <Text code>{preview.caption}</Text></Paragraph>}
      {preview.pages.length > 0 && <div className="broadcast-preview-pages">
        {preview.pages.map((page) => <Card key={page.pageIndex} size="small" title={`Сообщение ${page.pageIndex}`}>
          <img className="broadcast-preview-image" src={page.imageDataUrl} alt={`Предпросмотр, сообщение ${page.pageIndex}`} />
          <Text type="secondary">Заказы: {page.orderIds.map((id) => `#${id}`).join(', ')}</Text>
        </Card>)}
      </div>}
    </div>}
    <Modal open={confirmSend} title="Подтвердить ручную рассылку" okText={uncertain ? 'Проверить тот же запрос' : 'Поставить в очередь'} cancelText="Отмена" confirmLoading={sending} onCancel={() => setConfirmSend(false)} onOk={() => void sendNow()}>
      {uncertain
        ? <Alert type="warning" showIcon message="Предыдущий результат неизвестен" description="Повтор использует прежний идентификатор и исходные параметры; новый запуск создан не будет." />
        : <>
          <Paragraph>Отправить рассылку «{broadcast.name}» в группу <WhatsAppGroupLabel id={broadcast.groupChatId} />?</Paragraph>
          {preview && <Paragraph>{preview.orderCount} заказов, общий метраж {formatArea(preview.totalArea)}.</Paragraph>}
          <Alert type="warning" showIcon message="Состав может измениться" description="Предпросмотр фиксирует текущее состояние. Перед отправкой сервер заново соберёт заказы." />
        </>}
    </Modal>
  </Card>;
};
