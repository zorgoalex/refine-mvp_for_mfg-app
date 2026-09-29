import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, Modal, Space, Tag, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { broadcastsApi } from '../../../../api/broadcastsApi';
import type { Broadcast, BroadcastRun, BroadcastRunDetail, LegacyDigestRun } from '../../../../api/broadcastsApiTypes';
import { Table } from '../../../../ui/tooltipDelay';
import {
  MESSAGE_STATE_LABELS,
  RUN_STATE_LABELS,
  broadcastErrorMessage,
  canRetryAll,
  canRetryRemaining,
  clearPendingRetry,
  createUuid,
  formatArea,
  formatScheduleTime,
  formatTimestamp,
  isImageExpired,
  isKnownNotCreatedCommandError,
  persistPendingRetry,
  readPendingRetry,
  runPendingCommand,
  runReasonText,
  runStateColor,
  STORAGE_UNAVAILABLE_MESSAGE,
  weekdayDate,
  type PendingRetry,
} from './broadcastModel';
import './broadcasts.css';

const { Paragraph, Text } = Typography;
const KIND_LABELS = { auto: 'Авто', manual: 'Вручную', retry: 'Повтор' } as const;

export interface BroadcastHistoryProps {
  broadcast: Broadcast;
  actorId: string;
  runtimeAvailable: boolean;
  refreshToken: number;
}

export const BroadcastHistory: React.FC<BroadcastHistoryProps> = ({ broadcast, actorId, runtimeAvailable, refreshToken }) => {
  const [runs, setRuns] = useState<BroadcastRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<BroadcastRunDetail | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<number, string>>({});
  const [retryTarget, setRetryTarget] = useState<{ runId: string; mode: 'remaining' | 'all'; unknown: boolean; replay: boolean } | null>(null);
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const urlsRef = useRef<string[]>([]);
  const detailRequestRef = useRef(0);
  const loadRequestRef = useRef(0);
  const mountedRef = useRef(false);
  // An unconfirmed retry lives in localStorage until a definite answer: after a lost
  // response (even after a remount) the same key is replayed instead of a second retry.
  const pendingRetryRef = useRef<PendingRetry | null>(null);

  const clearImages = () => {
    urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    urlsRef.current = [];
    setImageUrls({});
  };

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await broadcastsApi.runs(broadcast.id);
      if (mountedRef.current && requestId === loadRequestRef.current) setRuns(result.runs);
    } catch (err) {
      if (mountedRef.current && requestId === loadRequestRef.current) setError(broadcastErrorMessage(err, 'Не удалось загрузить историю рассылки.'));
    } finally {
      if (mountedRef.current && requestId === loadRequestRef.current) setLoading(false);
    }
  }, [broadcast.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailRequestRef.current += 1;
      loadRequestRef.current += 1;
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    detailRequestRef.current += 1;
    clearImages();
    setDetail(null);
    setRuns([]);
    setRetryTarget(null);
    void load();
  }, [broadcast.id, refreshToken, load]);

  const openRun = async (run: BroadcastRun) => {
    const requestId = ++detailRequestRef.current;
    clearImages();
    setDetail(null);
    try {
      const next = await broadcastsApi.run(run.id);
      if (mountedRef.current && requestId === detailRequestRef.current) {
        pendingRetryRef.current = pendingRetryFor(next.run.id);
        setDetail(next);
      }
    } catch (err) {
      if (mountedRef.current && requestId === detailRequestRef.current) setError(broadcastErrorMessage(err, 'Не удалось открыть подробности запуска.'));
    }
  };

  const loadImage = async (seq: number, expiresAt: string) => {
    if (!detail || isImageExpired(expiresAt)) return;
    const requestId = detailRequestRef.current;
    try {
      const blob = await broadcastsApi.messageImage(detail.run.id, seq);
      if (blob.type !== 'image/png') throw new Error('Сервер вернул недопустимый формат изображения.');
      if (!mountedRef.current || requestId !== detailRequestRef.current) return;
      const url = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      setImageUrls((current) => ({ ...current, [seq]: url }));
    } catch (err) {
      if (mountedRef.current && requestId === detailRequestRef.current) setError(broadcastErrorMessage(err, 'Не удалось загрузить изображение.'));
    }
  };

  /** Stored request, else one still held in memory (storage may have refused the write). */
  const pendingRetryFor = (runId: string): PendingRetry | null => readPendingRetry(runId, actorId)
    ?? (pendingRetryRef.current?.runId === runId && pendingRetryRef.current.actorId === actorId ? pendingRetryRef.current : null);

  const startRetry = (mode: 'remaining' | 'all') => {
    if (!detail) return;
    const pending = pendingRetryFor(detail.run.id);
    pendingRetryRef.current = pending;
    if (!pending && !runtimeAvailable) return;
    setRiskConfirmed(false);
    setRetryTarget({ runId: detail.run.id, mode: pending?.payload.mode ?? mode, unknown: detail.messages.some((m) => m.state === 'unknown'), replay: Boolean(pending) });
  };

  const retryNow = async () => {
    if (!retryTarget || !riskConfirmed) return;
    const target = retryTarget;
    setRetrying(true);
    setError('');
    const outcome = await runPendingCommand<PendingRetry, unknown>({
      stored: pendingRetryFor(target.runId),
      fresh: () => ({ actorId, runId: target.runId, payload: { mode: target.mode, idempotencyKey: createUuid(), duplicateRiskConfirmed: true } }),
      persist: (request) => {
        pendingRetryRef.current = request;
        return persistPendingRetry(request);
      },
      clear: () => clearPendingRetry(target.runId),
      send: (request) => broadcastsApi.retry(request.runId, request.payload),
      isDefinite: isKnownNotCreatedCommandError,
    });
    if (outcome.status !== 'uncertain' && pendingRetryRef.current?.runId === target.runId) pendingRetryRef.current = null;
    if (!mountedRef.current) return;
    setRetrying(false);
    setRetryTarget(null);
    if (outcome.status === 'done') {
      message.success(outcome.replayed ? 'Повтор подтверждён.' : 'Повторная отправка поставлена в очередь.');
      void load();
    } else if (outcome.status === 'not-stored') {
      setError(STORAGE_UNAVAILABLE_MESSAGE);
    } else if (outcome.status === 'refused') {
      setError(broadcastErrorMessage(outcome.error, 'Не удалось повторить отправку.'));
    } else {
      setError('Не удалось подтвердить результат повтора. Следующая попытка проверит тот же запрос и не создаст второй повтор.');
    }
  };

  const columns = useMemo(() => [
    { title: 'Дата', dataIndex: 'businessDate', width: 110 },
    { title: 'Заказы на', dataIndex: 'targetDate', width: 110 },
    { title: 'Тип', dataIndex: 'kind', width: 100, render: (kind: BroadcastRun['kind']) => KIND_LABELS[kind] },
    { title: 'Плановое время', width: 120, render: (_: unknown, run: BroadcastRun) => run.scheduledAt ? formatScheduleTime(run.scheduledAt) : '—' },
    { title: 'Статус', dataIndex: 'state', width: 170, render: (state: BroadcastRun['state'], run: BroadcastRun) => <span><Tag color={runStateColor(state)}>{RUN_STATE_LABELS[state]}</Tag>{run.superseded ? <Tag>Заменён</Tag> : null}</span> },
    { title: 'Заказы', dataIndex: 'orderCount', width: 85 },
    { title: 'Страницы', width: 95, render: (_: unknown, run: BroadcastRun) => `${run.sentMessageCount}/${run.messageCount}` },
    { title: '', width: 120, render: (_: unknown, run: BroadcastRun) => <Button onClick={() => void openRun(run)}>Подробности</Button> },
  ], []);

  return <Card title="История отправок" extra={<Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>Обновить</Button>}>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    <Table<BroadcastRun> rowKey="id" loading={loading} dataSource={runs} columns={columns} pagination={false} scroll={{ x: 900 }} locale={{ emptyText: 'История этой рассылки пока пуста.' }} />
    {detail && <Card className="broadcast-run-detail" size="small" title={`Подробности · ${weekdayDate(detail.run.businessDate)}`} extra={<Button onClick={() => { clearImages(); setDetail(null); }}>Закрыть</Button>}>
      <Space wrap>
        <Tag color={runStateColor(detail.run.state)}>{RUN_STATE_LABELS[detail.run.state]}</Tag>
        <Text>Заказы на {weekdayDate(detail.run.targetDate)}: {detail.run.orderCount} · {formatArea(detail.run.totalArea)}</Text>
        <Text type="secondary">Группа {detail.run.destinationMasked}</Text>
      </Space>
      {detail.run.reason && <Paragraph type="secondary">{runReasonText(detail.run.reason)}</Paragraph>}
      {detail.run.superseded && <Alert type="info" showIcon message="Запуск заменён более новым — повтор недоступен." />}
      <div className="broadcast-history-pages">
        {detail.messages.map((item) => {
          const expired = !item.imageAvailable || isImageExpired(item.expiresAt);
          return <Card key={item.deliverySeq} size="small" title={`Сообщение ${item.deliverySeq}`} extra={<Tag color={item.state === 'sent' ? 'green' : item.state === 'unknown' ? 'orange' : 'default'}>{MESSAGE_STATE_LABELS[item.state] ?? item.state}</Tag>}>
            <Paragraph type="secondary">Заказы: {item.orderIds.map((id) => `#${id}`).join(', ')} · Попыток: {item.attemptCount}{item.sentAt ? ` · Отправлено ${formatTimestamp(item.sentAt)}` : ''}</Paragraph>
            {expired ? <Alert type="info" showIcon message="Изображение удалено: срок хранения истёк." />
              : imageUrls[item.deliverySeq] ? <img className="broadcast-preview-image" src={imageUrls[item.deliverySeq]} alt={`Сохранённое сообщение ${item.deliverySeq}`} />
                : <Button onClick={() => void loadImage(item.deliverySeq, item.expiresAt)}>Показать изображение</Button>}
          </Card>;
        })}
      </div>
      {detail.messages.some((m) => m.state === 'unknown') && <Alert style={{ marginTop: 12 }} type="warning" showIcon message="Результат одной из отправок неизвестен" description="WhatsApp мог уже получить сообщение. Любой повтор может создать дубликат." />}
      {pendingRetryRef.current && !retrying && <Alert style={{ marginTop: 12 }} type="warning" showIcon message="Результат повтора не подтверждён"
        description={`Повтор «${pendingRetryRef.current.payload.mode === 'all' ? 'все сообщения' : 'оставшиеся сообщения'}» мог уже выполниться. Проверка отправит тот же запрос и не создаст второй повтор.`}
        action={<Button size="small" onClick={() => startRetry(pendingRetryRef.current?.payload.mode ?? 'remaining')}>Проверить</Button>} />}
      <Space wrap style={{ marginTop: 12 }}>
        <Button onClick={() => startRetry('remaining')} disabled={Boolean(pendingRetryRef.current) || !runtimeAvailable || !canRetryRemaining(detail)}>Повторить оставшиеся</Button>
        <Button danger onClick={() => startRetry('all')} disabled={Boolean(pendingRetryRef.current) || !runtimeAvailable || !canRetryAll(detail)}>Повторить всё</Button>
      </Space>
    </Card>}
    <Modal open={Boolean(retryTarget)} title="Подтвердить повторную отправку" okText="Подтвердить риск и повторить" cancelText="Отмена" confirmLoading={retrying} okButtonProps={{ disabled: !riskConfirmed }} onCancel={() => setRetryTarget(null)} onOk={() => void retryNow()}>
      <Paragraph>{retryTarget?.replay
        ? `Будет проверен прежний запрос повтора «${retryTarget.mode === 'all' ? 'все сообщения' : 'оставшиеся сообщения'}»: если он уже выполнен, новый запуск не создаётся.`
        : `Будет создан новый запуск режима «${retryTarget?.mode === 'all' ? 'все сообщения' : 'оставшиеся сообщения'}» для сохранённого снимка.`}</Paragraph>
      {retryTarget?.unknown && <Alert type="warning" showIcon message="Есть сообщения с неизвестным результатом" description="Они могли уже попасть в группу; повтор создаёт риск дубликатов." />}
      <Checkbox checked={riskConfirmed} onChange={(event) => setRiskConfirmed(event.target.checked)}>Понимаю риск повторных сообщений и подтверждаю</Checkbox>
    </Modal>
  </Card>;
};

export const LegacyDigestHistory: React.FC = () => {
  const [runs, setRuns] = useState<LegacyDigestRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await broadcastsApi.legacyDigestRuns();
      if (mountedRef.current) setRuns(result.runs);
    } catch (err) {
      if (mountedRef.current) setError(broadcastErrorMessage(err, 'Не удалось загрузить историю до перехода.'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const columns = [
    { title: 'Дата', dataIndex: 'businessDate', width: 110 },
    { title: 'Тип', dataIndex: 'kind', width: 100, render: (kind: LegacyDigestRun['kind']) => KIND_LABELS[kind] },
    { title: 'Плановое время', width: 120, render: (_: unknown, run: LegacyDigestRun) => run.scheduledAt ? formatScheduleTime(run.scheduledAt) : '—' },
    { title: 'Статус', dataIndex: 'state', width: 170, render: (state: LegacyDigestRun['state']) => <Tag color={runStateColor(state)}>{RUN_STATE_LABELS[state]}</Tag> },
    { title: 'Заказы', dataIndex: 'orderCount', width: 85 },
    { title: 'Страницы', width: 95, render: (_: unknown, run: LegacyDigestRun) => `${run.sentPageCount}/${run.pageCount}` },
    { title: 'Группа', dataIndex: 'destinationMasked', width: 130, ellipsis: true },
  ];

  return <Collapse ghost onChange={(keys) => { if (keys.length > 0 && runs === null && !loading) void load(); }}>
    <Collapse.Panel key="legacy" header="История до перехода">
      {error && <Alert type="error" showIcon message={error} />}
      <Table<LegacyDigestRun> rowKey="id" loading={loading} dataSource={runs ?? []} columns={columns} pagination={false} scroll={{ x: 800 }} locale={{ emptyText: 'Записей до перехода нет.' }} />
    </Collapse.Panel>
  </Collapse>;
};
