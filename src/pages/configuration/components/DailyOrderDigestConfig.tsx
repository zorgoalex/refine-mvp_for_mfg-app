import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  TimePicker,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { ReloadOutlined, SendOutlined } from '@ant-design/icons';
import { dailyOrderDigestApi } from '../../../api/dailyOrderDigestApi';
import { ApiError } from '../../../api/apiError';
import './DailyOrderDigestConfig.css';
import type {
  DailyDigestPreview,
  DailyDigestRun,
  DailyDigestRunDetail,
  DailyDigestRunState,
  DailyDigestSettings,
  DailyDigestSettingsEnvelope,
  DailyDigestSettingsInput,
} from '../../../api/dailyOrderDigestTypes';
import { authSession } from '../../../api/authSession';
import { getUserAuthorizationScopeKey } from '../../../api/authScopeIdentity';
import { Table } from '../../../ui/tooltipDelay';

const { Paragraph, Text, Title } = Typography;
export const DAILY_DIGEST_REQUIRED_PERMISSIONS = [
  'whatsapp.manage',
  'calendar.view',
  'orders.view',
  'orders.view_financials',
] as const;

type SettingsFormValues = Omit<DailyDigestSettings, 'sendTime' | 'catchUpDeadline'> & {
  sendTime: Dayjs;
  catchUpDeadline: Dayjs;
};

const DEFAULT_SETTINGS: SettingsFormValues = {
  version: 1,
  enabled: false,
  groupChatId: null,
  sendTime: dayjs().hour(8).minute(45).second(0).millisecond(0),
  timeZone: 'Asia/Almaty',
  catchUpPolicy: 'until_deadline',
  catchUpDeadline: dayjs().hour(10).minute(0).second(0).millisecond(0),
  cardsPerMessage: 2,
  partialPolicy: 'remaining',
};

const PENDING_MANUAL_SEND_KEY = 'daily-order-digest.pending-manual-send.v1';
interface PendingManualSend {
  actorId: string;
  payload: { settingsVersion: number; idempotencyKey: string; confirmed: true };
  ambiguous: boolean;
}

const RUN_STATE_LABELS: Record<DailyDigestRunState, string> = {
  queued: 'Ожидает отправки',
  sending: 'Отправляется',
  sent: 'Отправлено',
  partial: 'Отправлено частично',
  failed: 'Ошибка',
  unknown: 'Результат неизвестен',
  cancelled: 'Отменено',
  expired: 'Срок хранения истёк',
  empty: 'Нет заказов',
  skipped: 'Пропущено',
};

const PAGE_STATE_LABELS: Record<string, string> = {
  pending: 'Ожидает', sending: 'Отправляется', sent: 'Отправлено', failed: 'Ошибка',
  unknown: 'Результат неизвестен', cancelled: 'Отменено', expired: 'Срок хранения истёк',
};

export const dailyDigestTabVisible = (
  permissions: readonly string[] | null | undefined,
): boolean => DAILY_DIGEST_REQUIRED_PERMISSIONS.every((permission) => permissions?.includes(permission));

export const formatDigestArea = (area: number): string =>
  `${Number.isFinite(area) ? area.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0,00'} кв.м.`;

export const isDigestImageExpired = (expiresAt: string, now = Date.now()): boolean => {
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= now;
};

export const digestRuntimeReason = (reason: string | null): string => {
  if (!reason) return 'Отправка сейчас недоступна. Проверьте подключение WhatsApp и настройки сервера.';
  const known: Record<string, string> = {
    whatsapp_disabled: 'На сервере выключена отправка WhatsApp.',
    relay_unavailable: 'Сервис отправки WhatsApp сейчас недоступен.',
    relay_owner_mismatch: 'Отправка WhatsApp на этом сервере не активна.',
  };
  return known[reason] ?? 'Отправка сейчас недоступна. Предпросмотр и настройки остаются доступны.';
};

export const DailyOrderDigestConfig: React.FC = () => {
  const authScopeKey = useSyncExternalStore(authSession.subscribe, getAuthScopeSnapshot, getAuthScopeSnapshot);
  const actorId = authSession.getUser()?.id ?? '';
  const allowed = dailyDigestTabVisible(authSession.getUser()?.permissions);
  const [form] = Form.useForm<SettingsFormValues>();
  const formValues = Form.useWatch([], form) as SettingsFormValues | undefined;
  const [envelope, setEnvelope] = useState<DailyDigestSettingsEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingError, setLoadingError] = useState('');
  const [actionError, setActionError] = useState('');
  const [preview, setPreview] = useState<DailyDigestPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [history, setHistory] = useState<DailyDigestRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [detail, setDetail] = useState<DailyDigestRunDetail | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const [retryTarget, setRetryTarget] = useState<{ run: DailyDigestRun; mode: 'remaining' | 'all'; unknown: boolean } | null>(null);
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [imageUrls, setImageUrls] = useState<Record<number, string>>({});
  const imageUrlsRef = useRef<string[]>([]);
  const historyRequestRef = useRef(false);
  const mountedRef = useRef(false);
  const authorizationScopeRef = useRef(authScopeKey);
  authorizationScopeRef.current = authScopeKey;
  const sendActorIdRef = useRef(actorId);
  const previewRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const sendIdempotencyRef = useRef<PendingManualSend | null>(readPendingManualSend(actorId));
  const currentPendingSend = sendIdempotencyRef.current?.actorId === actorId ? sendIdempotencyRef.current : null;
  const sendOutcomeUncertain = Boolean(currentPendingSend?.ambiguous);
  const actorReady = sendActorIdRef.current === actorId;
  const retryIdempotencyRef = useRef<{ runId: string; mode: 'remaining' | 'all'; key: string } | null>(null);
  const settings = envelope?.settings;
  const dirty = Boolean(formValues && settings && !settingsDraftMatchesSaved(formValues, settings));
  const runtimeAvailable = Boolean(envelope?.runtime.enabled && envelope.runtime.relayAvailable);
  const chatId = Form.useWatch('groupChatId', form) ?? null;
  const catchUpPolicy = Form.useWatch('catchUpPolicy', form);
  const partialPolicy = Form.useWatch('partialPolicy', form);

  useEffect(() => {
    if (sendActorIdRef.current === actorId) return;
    sendActorIdRef.current = actorId;
    sendIdempotencyRef.current = readPendingManualSend(actorId);
    setConfirmSend(false);
    setPreview(null);
    setActionError('');
  }, [actorId]);

  const loadSettings = useCallback(async () => {
    if (!allowed) return;
    const requestScope = authScopeKey;
    setLoading(true);
    setLoadingError('');
    try {
      const result = await dailyOrderDigestApi.settings();
      if (!mountedRef.current || authorizationScopeRef.current !== requestScope) return;
      setEnvelope(result);
      form.resetFields();
      form.setFieldsValue(toFormValues(result.settings));
    } catch (error) {
      if (mountedRef.current && authorizationScopeRef.current === requestScope) setLoadingError(errorMessage(error, 'Не удалось загрузить настройки рассылки.'));
    } finally {
      if (mountedRef.current && authorizationScopeRef.current === requestScope) setLoading(false);
    }
  }, [allowed, authScopeKey, form]);

  const loadHistory = useCallback(async (silent = false) => {
    if (!allowed) return;
    const requestScope = authScopeKey;
    if (historyRequestRef.current) return;
    historyRequestRef.current = true;
    if (!silent) setHistoryLoading(true);
    setHistoryError('');
    try {
      const result = await dailyOrderDigestApi.runs();
      if (mountedRef.current && authorizationScopeRef.current === requestScope) setHistory(result.runs);
    } catch (error) {
      if (mountedRef.current && authorizationScopeRef.current === requestScope && !silent) setHistoryError(errorMessage(error, 'Не удалось загрузить историю рассылки.'));
    } finally {
      historyRequestRef.current = false;
      if (mountedRef.current && authorizationScopeRef.current === requestScope && !silent) setHistoryLoading(false);
    }
  }, [allowed, authScopeKey]);

  useEffect(() => {
    mountedRef.current = true;
    if (!allowed) {
      setLoading(false);
      return () => { mountedRef.current = false; };
    }
    let active = true;
    void Promise.all([loadSettings(), loadHistory()]).then(() => {
      if (!active) return;
    });
    const timer = window.setInterval(() => {
      if (active && document.visibilityState === 'visible') void loadHistory(true);
    }, 15_000);
    return () => {
      active = false;
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [authScopeKey, actorId, allowed, loadHistory, loadSettings]);

  useEffect(() => () => {
    mountedRef.current = false;
    previewRequestRef.current += 1;
    detailRequestRef.current += 1;
    imageUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const clearHistoryImages = () => {
    imageUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    imageUrlsRef.current = [];
    setImageUrls({});
  };

  const previousAuthScopeRef = useRef(authScopeKey);
  useEffect(() => {
    if (previousAuthScopeRef.current === authScopeKey) return;
    previousAuthScopeRef.current = authScopeKey;
    previewRequestRef.current += 1;
    detailRequestRef.current += 1;
    historyRequestRef.current = false;
    clearHistoryImages();
    setPreview(null);
    setHistory([]);
    setDetail(null);
    setConfirmSend(false);
    setRetryTarget(null);
    setActionError('');
    setHistoryError('');
    setLoading(false);
    setSaving(false);
    setPreviewLoading(false);
    setHistoryLoading(false);
    setSending(false);
    setRetrying(false);
    if (!allowed) {
      setEnvelope(null);
      form.resetFields();
    }
  }, [authScopeKey, allowed, form]);

  const saveSettings = async (values: SettingsFormValues) => {
    if (!allowed) return;
    const requestScope = authScopeKey;
    setSaving(true);
    setActionError('');
    setPreview(null);
    clearHistoryImages();
    try {
      const body: DailyDigestSettingsInput = {
        version: values.version,
        enabled: values.enabled,
        groupChatId: values.groupChatId?.trim() || null,
        sendTime: values.sendTime.format('HH:mm'),
        catchUpPolicy: values.catchUpPolicy,
        catchUpDeadline: values.catchUpDeadline.format('HH:mm'),
        cardsPerMessage: values.cardsPerMessage,
        partialPolicy: values.partialPolicy,
        duplicateRiskConfirmed: values.partialPolicy !== 'repeat_all' || riskConfirmed,
      };
      const next = await dailyOrderDigestApi.saveSettings(body);
      if (!mountedRef.current || authorizationScopeRef.current !== requestScope) return;
      setEnvelope(next);
      form.resetFields();
      form.setFieldsValue(toFormValues(next.settings));
      setRiskConfirmed(false);
      message.success('Настройки рассылки сохранены.');
      void loadHistory();
    } catch (error) {
      if (mountedRef.current && authorizationScopeRef.current === requestScope) setActionError(errorMessage(error, 'Не удалось сохранить настройки. Обновите их и повторите попытку.'));
    } finally {
      if (mountedRef.current && authorizationScopeRef.current === requestScope) setSaving(false);
    }
  };

  const createPreview = async () => {
    if (!allowed || !settings || dirty) return;
    const requestScope = authScopeKey;
    const requestId = ++previewRequestRef.current;
    setPreviewLoading(true);
    setActionError('');
    setPreview(null);
    try {
      const result = await dailyOrderDigestApi.preview();
      if (mountedRef.current && authorizationScopeRef.current === requestScope && requestId === previewRequestRef.current) setPreview(result);
    } catch (error) {
      if (mountedRef.current && authorizationScopeRef.current === requestScope && requestId === previewRequestRef.current) setActionError(errorMessage(error, 'Не удалось сформировать предпросмотр.'));
    } finally {
      if (mountedRef.current && authorizationScopeRef.current === requestScope && requestId === previewRequestRef.current) setPreviewLoading(false);
    }
  };

  const sendNow = async () => {
    const pending = sendIdempotencyRef.current?.actorId === actorId ? sendIdempotencyRef.current : null;
    if (!allowed || !actorReady || (!pending && (!settings || dirty || !preview || preview.empty || !runtimeAvailable || !chatId?.trim()))) return;
    const requestScope = authScopeKey;
    const request = pending ?? {
      actorId,
      payload: { settingsVersion: settings!.version, idempotencyKey: createUuid(), confirmed: true as const },
      ambiguous: false,
    };
    sendIdempotencyRef.current = request;
    persistPendingManualSend(actorId, request);
    setSending(true);
    setActionError('');
    try {
      await dailyOrderDigestApi.send(request.payload);
      const sameActorRequest = sendIdempotencyRef.current === request;
      if (sameActorRequest) sendIdempotencyRef.current = null;
      clearPendingManualSend(actorId);
      if (!mountedRef.current || authorizationScopeRef.current !== requestScope || !allowed) return;
      setConfirmSend(false);
      message.success('Ручная рассылка поставлена в очередь.');
      void loadHistory();
    } catch (error) {
      const definitelyNotQueued = isKnownNotQueuedError(error, request.ambiguous);
      if (definitelyNotQueued) {
        if (sendIdempotencyRef.current === request) sendIdempotencyRef.current = null;
        clearPendingManualSend(actorId);
      } else {
        request.ambiguous = true;
        persistPendingManualSend(actorId, request);
        if (sendIdempotencyRef.current !== request && sendActorIdRef.current === actorId) {
          sendIdempotencyRef.current = request;
        }
      }
      if (mountedRef.current && authorizationScopeRef.current === requestScope) setActionError(request.ambiguous
        ? 'Не удалось подтвердить результат. При повторе будет проверен тот же запрос, без создания нового запуска.'
        : errorMessage(error, 'Не удалось поставить рассылку в очередь.'));
    } finally {
      if (mountedRef.current && authorizationScopeRef.current === requestScope) setSending(false);
    }
  };

  const openRun = async (run: DailyDigestRun) => {
    if (!allowed) return;
    const requestScope = authScopeKey;
    const requestId = ++detailRequestRef.current;
    clearHistoryImages();
    setDetail(null);
    try {
      const next = await dailyOrderDigestApi.run(run.id);
      if (mountedRef.current && authorizationScopeRef.current === requestScope && requestId === detailRequestRef.current) setDetail(next);
    } catch (error) {
      if (mountedRef.current && authorizationScopeRef.current === requestScope && requestId === detailRequestRef.current) setHistoryError(errorMessage(error, 'Не удалось открыть подробности рассылки.'));
    }
  };

  const loadRunImage = async (pageIndex: number, expiresAt: string) => {
    if (!allowed || !detail || isDigestImageExpired(expiresAt)) return;
    const requestScope = authScopeKey;
    const requestId = detailRequestRef.current;
    const runId = detail.run.id;
    try {
      const blob = await dailyOrderDigestApi.pageImage(runId, pageIndex);
      if (blob.type !== 'image/png') throw new Error('Сервер вернул недопустимый формат изображения.');
      if (!mountedRef.current || authorizationScopeRef.current !== requestScope || requestId !== detailRequestRef.current || isDigestImageExpired(expiresAt)) return;
      const url = URL.createObjectURL(blob);
      imageUrlsRef.current.push(url);
      setImageUrls((current) => ({ ...current, [pageIndex]: url }));
    } catch (error) {
      if (!mountedRef.current || authorizationScopeRef.current !== requestScope || requestId !== detailRequestRef.current) return;
      setHistoryError(isDigestImageExpired(expiresAt)
        ? 'Изображение удалено: срок хранения истёк.'
        : errorMessage(error, 'Не удалось загрузить изображение.'));
    }
  };

  const startRetry = async (mode: 'remaining' | 'all') => {
    if (!allowed || !detail || !runtimeAvailable) return;
    const hasUnknown = detail.pages.some((page) => page.state === 'unknown');
    if (detail.pages.some((page) => !page.imageAvailable || isDigestImageExpired(page.expiresAt))) {
      setHistoryError('Повтор недоступен: срок хранения изображения истёк или файл удалён.');
      return;
    }
    setRiskConfirmed(false);
    setRetryTarget({ run: detail.run, mode, unknown: hasUnknown });
  };

  const retryNow = async () => {
    if (!allowed || !retryTarget || !riskConfirmed || !runtimeAvailable) return;
    const requestScope = authScopeKey;
    if (!detail || detail.run.id !== retryTarget.run.id
      || detail.pages.some((page) => !page.imageAvailable || isDigestImageExpired(page.expiresAt))) {
      setRetryTarget(null);
      setHistoryError('Повтор недоступен: срок хранения изображения истёк или файл удалён.');
      return;
    }
    setRetrying(true);
    setHistoryError('');
    try {
      const existing = retryIdempotencyRef.current;
      const idempotencyKey = existing?.runId === retryTarget.run.id && existing.mode === retryTarget.mode
        ? existing.key
        : createUuid();
      retryIdempotencyRef.current = { runId: retryTarget.run.id, mode: retryTarget.mode, key: idempotencyKey };
      await dailyOrderDigestApi.retry(retryTarget.run.id, {
        mode: retryTarget.mode,
        idempotencyKey,
        duplicateRiskConfirmed: true,
      });
      if (!mountedRef.current || authorizationScopeRef.current !== requestScope) return;
      retryIdempotencyRef.current = null;
      setRetryTarget(null);
      message.success('Повторная отправка поставлена в очередь.');
      void loadHistory();
    } catch (error) {
      if (mountedRef.current && authorizationScopeRef.current === requestScope) setHistoryError(errorMessage(error, 'Не удалось повторить отправку.'));
    } finally {
      if (mountedRef.current && authorizationScopeRef.current === requestScope) setRetrying(false);
    }
  };

  const historyColumns = useMemo(() => [
    { title: 'Дата', dataIndex: 'businessDate', width: 110 },
    { title: 'Тип', dataIndex: 'kind', width: 100, render: (kind: DailyDigestRun['kind']) => ({ auto: 'Авто', manual: 'Вручную', retry: 'Повтор' }[kind]) },
    { title: 'Статус', dataIndex: 'state', width: 160, render: (state: DailyDigestRunState) => <Tag color={runStateColor(state)}>{RUN_STATE_LABELS[state]}</Tag> },
    { title: 'Заказы', dataIndex: 'orderCount', width: 85 },
    { title: 'Площадь', dataIndex: 'totalArea', width: 115, render: (area: number) => formatDigestArea(area) },
    { title: 'Страницы', render: (_: unknown, run: DailyDigestRun) => `${run.sentPageCount}/${run.pageCount}`, width: 90 },
    { title: 'Группа', dataIndex: 'destinationMasked', width: 130, ellipsis: true },
    { title: '', width: 120, render: (_: unknown, run: DailyDigestRun) => <Button onClick={() => void openRun(run)}>Подробности</Button> },
  ], [openRun]);

  if (!allowed) return <Alert type="warning" showIcon message="Нет доступа к рассылке заказов" description="Нужны права whatsapp.manage, calendar.view, orders.view и orders.view_financials." />;
  if (loading && !envelope) return <div style={{ padding: 24, textAlign: 'center' }}><Spin /></div>;
  if (loadingError && !envelope) return <Alert type="error" showIcon message={loadingError} action={<Button onClick={() => void loadSettings()}>Повторить</Button>} />;

  return <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <header>
      <Title level={4}>Рассылка заказов</Title>
      <Paragraph type="secondary">Ежедневная сводка группового чата WhatsApp по заказам с плановой датой выдачи сегодня. Время рассчитывается по Asia/Almaty.</Paragraph>
    </header>
    {loadingError && <Alert type="error" showIcon message={loadingError} action={<Button onClick={() => void loadSettings()}>Повторить</Button>} />}
    {actionError && <Alert type="error" showIcon message={actionError} closable onClose={() => setActionError('')} />}
    {!runtimeAvailable && <Alert type="warning" showIcon message="Автоматическая и ручная отправка сейчас недоступна" description={digestRuntimeReason(envelope?.runtime.unavailableReason ?? null)} />}
    {dirty && <Alert type="info" showIcon message="Сначала сохраните изменения" description="Предпросмотр и ручная отправка используют только сохранённые настройки." />}

    <Card title="Расписание и правила">
      <Form form={form} layout="vertical" initialValues={DEFAULT_SETTINGS} disabled={saving || loading} onFinish={(values: SettingsFormValues) => void saveSettings(values)}>
        <Form.Item name="version" hidden><InputNumber /></Form.Item>
        <Space align="center" size="middle" wrap>
          <Form.Item name="enabled" label="Автоматическая рассылка" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Switch checkedChildren="Включена" unCheckedChildren="Выключена" />
          </Form.Item>
          <Text type="secondary">При первом подключении выключена. Предпросмотр и ручная отправка настраиваются отдельно.</Text>
        </Space>
        <Form.Item name="groupChatId" label="Группа WhatsApp" rules={[
          { validator: async (_, value: string | null | undefined) => {
            if (!value && !form.getFieldValue('enabled')) return;
            if (!value || !/^\d{5,20}@g\.us$/.test(value.trim())) throw new Error('Введите ID группы из 5–20 цифр, заканчивающийся на @g.us.');
          } },
        ]} extra="ID группы хранится в защищённых настройках. В истории показывается только маска.">
          <Input placeholder="120…@g.us" autoComplete="off" />
        </Form.Item>
        <Form.Item name="sendTime" label="Время ежедневной отправки" rules={[{ required: true, message: 'Укажите время отправки.' }]}>
          <TimePicker format="HH:mm" minuteStep={5} style={{ width: 160 }} />
        </Form.Item>
        <Form.Item name="catchUpPolicy" label="Если сервер пропустил время отправки" rules={[{ required: true }]}>
          <Select options={[
            { value: 'skip', label: 'Пропустить сводку за сегодня' },
            { value: 'until_deadline', label: 'Отправить до контрольного времени' },
            { value: 'end_of_day', label: 'Отправить до конца дня' },
          ]} />
        </Form.Item>
        {catchUpPolicy === 'until_deadline' && <Form.Item name="catchUpDeadline" label="Контрольное время" dependencies={['sendTime']} rules={[{ required: true, message: 'Укажите контрольное время.' }, { validator: async (_, deadline: Dayjs | undefined) => {
          const sendTime = form.getFieldValue('sendTime') as Dayjs | undefined;
          if (deadline && sendTime && deadline.format('HH:mm') < sendTime.format('HH:mm')) throw new Error('Контрольное время должно быть не раньше времени отправки.');
        } }]}>
          <TimePicker format="HH:mm" minuteStep={5} style={{ width: 160 }} />
        </Form.Item>}
        <Form.Item name="cardsPerMessage" label="Карточек в одном сообщении" rules={[{ required: true }]} extra="Настройка применяется к новым предпросмотрам и запускам. Повтор использует изображения и количество карточек из исходного запуска.">
          <Select options={[
            { value: 1, label: '1 карточка' },
            { value: 2, label: '2 карточки' },
          ]} />
        </Form.Item>
        <Form.Item name="partialPolicy" label="Если отправлена только часть сводки" rules={[{ required: true }]}> 
          <Select options={[
            { value: 'remaining', label: 'Продолжить с неотправленных карточек' },
            { value: 'repeat_all', label: 'Повторить всю сводку' },
            { value: 'manual', label: 'Остановить и ждать решения оператора' },
          ]} />
        </Form.Item>
        {partialPolicy === 'repeat_all' && <Alert type="warning" showIcon message="Повтор может отправить уже полученные карточки ещё раз." description={<Checkbox checked={riskConfirmed} onChange={(event) => setRiskConfirmed(event.target.checked)}>Подтверждаю возможные повторные сообщения</Checkbox>} />}
        <Paragraph type="secondary">Сводка содержит все незакрытые и закрытые производственные заказы с плановой датой сегодня. На каждом изображении — не более {settings?.cardsPerMessage === 1 ? 'одной карточки' : 'двух карточек'}; общий метраж считается по всем заказам.</Paragraph>
        <Space wrap>
          <Button type="primary" htmlType="submit" loading={saving} disabled={!dirty || (partialPolicy === 'repeat_all' && !riskConfirmed)}>Сохранить настройки</Button>
          <Button icon={<ReloadOutlined />} onClick={() => void loadSettings()} disabled={saving}>Обновить</Button>
        </Space>
      </Form>
    </Card>

    <Card title="Предпросмотр и ручная отправка" extra={<Text type="secondary">Ручные действия не зависят от переключателя расписания.</Text>}>
      <Space wrap>
        <Button onClick={() => void createPreview()} loading={previewLoading} disabled={!actorReady || !settings || dirty}>Предпросмотр</Button>
        <Button type="primary" icon={<SendOutlined />} onClick={() => setConfirmSend(true)} disabled={!actorReady || (!currentPendingSend && (!preview || preview.empty || dirty || !runtimeAvailable || !chatId?.trim()))}>
          Отправить сейчас
        </Button>
      </Space>
      {preview && <div style={{ marginTop: 16 }}>
        <Alert type={preview.empty ? 'info' : 'success'} showIcon message={preview.empty ? 'На выбранную дату заказов нет — сообщение не отправится.' : `${weekdayDate(preview.businessDate)} · ${preview.orderCount} заказов · ${formatDigestArea(preview.totalArea)}`} />
        {preview.pages.length > 0 && <div className="daily-digest-preview-pages">
          {preview.pages.map((page) => <Card key={page.pageIndex} size="small" title={`Страница ${page.pageIndex}`}>
            <img className="daily-digest-preview-image" src={page.imageDataUrl} alt={`Предпросмотр сводки, страница ${page.pageIndex}`} />
            <Text type="secondary">Заказы: {page.orderIds.map((id) => `#${id}`).join(', ')}</Text>
          </Card>)}
        </div>}
      </div>}
    </Card>

    <Card title="История отправок" extra={<Button icon={<ReloadOutlined />} onClick={() => void loadHistory()} loading={historyLoading}>Обновить</Button>}>
      {historyError && <Alert type="error" showIcon message={historyError} closable onClose={() => setHistoryError('')} />}
      <Table<DailyDigestRun> rowKey="id" loading={historyLoading} dataSource={history} columns={historyColumns} pagination={false} scroll={{ x: 900 }} locale={{ emptyText: 'История рассылок пока пуста.' }} />
      {detail && <Card className="daily-digest-run-detail" size="small" title={`Подробности · ${weekdayDate(detail.run.businessDate)}`} extra={<Button onClick={() => { clearHistoryImages(); setDetail(null); }}>Закрыть</Button>}>
        <Space wrap>
          <Tag color={runStateColor(detail.run.state)}>{RUN_STATE_LABELS[detail.run.state]}</Tag>
          <Text>{detail.run.orderCount} заказов · {formatDigestArea(detail.run.totalArea)}</Text>
          <Text type="secondary">Группа {detail.run.destinationMasked}</Text>
        </Space>
        {detail.run.reason && <Paragraph type="secondary">{runReasonText(detail.run.reason)}</Paragraph>}
        <div className="daily-digest-history-pages">
          {detail.pages.map((page) => {
            const expired = !page.imageAvailable || isDigestImageExpired(page.expiresAt);
            return <Card key={page.pageIndex} size="small" title={`Страница ${page.pageIndex}`} extra={<Tag color={page.state === 'sent' ? 'green' : page.state === 'unknown' ? 'orange' : 'default'}>{PAGE_STATE_LABELS[page.state] ?? page.state}</Tag>}>
              <Paragraph type="secondary">Заказы: {page.orderIds.map((id) => `#${id}`).join(', ')} · Попыток: {page.attemptCount}{page.sentAt ? ` · Отправлено ${formatTimestamp(page.sentAt)}` : ''}</Paragraph>
              {expired ? <Alert type="info" showIcon message="Изображение удалено: срок хранения истёк." />
                : imageUrls[page.pageIndex] ? <img className="daily-digest-preview-image" src={imageUrls[page.pageIndex]} alt={`Сохранённая сводка, страница ${page.pageIndex}`} />
                  : <Button onClick={() => void loadRunImage(page.pageIndex, page.expiresAt)}>Показать изображение</Button>}
            </Card>;
          })}
        </div>
        {detail.pages.some((page) => page.state === 'unknown') && <Alert style={{ marginTop: 12 }} type="warning" showIcon message="Результат одной из отправок неизвестен" description="WhatsApp мог уже получить сообщение. Любой повтор может создать дубликат." />}
        <Space wrap style={{ marginTop: 12 }}>
          <Button onClick={() => void startRetry('remaining')} disabled={!runtimeAvailable || !canRetry(detail)}>Повторить оставшиеся</Button>
          <Button danger onClick={() => void startRetry('all')} disabled={!runtimeAvailable || !canRetry(detail)}>Повторить всё</Button>
        </Space>
      </Card>}
    </Card>

    <Modal open={confirmSend && actorReady} title="Подтвердить ручную рассылку" okText={sendOutcomeUncertain ? 'Проверить тот же запрос' : 'Поставить в очередь'} cancelText="Отмена" confirmLoading={sending} onCancel={() => setConfirmSend(false)} onOk={() => void sendNow()}>
      {sendOutcomeUncertain && <Alert type="warning" showIcon message="Предыдущий результат неизвестен" description="Продолжение повторно использует прежний идентификатор и исходные параметры; новый запуск создан не будет." />}
      {sendOutcomeUncertain
        ? <Paragraph>Проверить постановку в очередь запроса с версией настроек {currentPendingSend?.payload.settingsVersion}. Повтор использует прежний идентификатор.</Paragraph>
        : <>
          <Paragraph>Отправить в группу <Text code>{maskDestination(chatId)}</Text> сводку за {preview ? weekdayDate(preview.businessDate) : 'сегодня'}?</Paragraph>
          <Paragraph>{preview?.orderCount ?? 0} заказов, общий метраж {formatDigestArea(preview?.totalArea ?? 0)}.</Paragraph>
          <Alert type="warning" showIcon message="Состав может измениться" description="Предпросмотр фиксирует текущее состояние. Перед отправкой сервер заново соберёт заказы, поэтому содержимое может отличаться." />
        </>}
    </Modal>

    <Modal open={Boolean(retryTarget)} title="Подтвердить повторную отправку" okText="Подтвердить риск и повторить" cancelText="Отмена" confirmLoading={retrying} okButtonProps={{ disabled: !riskConfirmed }} onCancel={() => { retryIdempotencyRef.current = null; setRetryTarget(null); }} onOk={() => void retryNow()}>
      <Paragraph>Будет создан новый запуск режима «{retryTarget?.mode === 'all' ? 'все страницы' : 'оставшиеся страницы'}» для сохранённого снимка.</Paragraph>
      {retryTarget?.unknown && <Alert type="warning" showIcon message="Есть страницы с неизвестным результатом" description="Они могли уже попасть в группу; повтор создаёт риск дубликатов." />}
      <Checkbox checked={riskConfirmed} onChange={(event) => setRiskConfirmed(event.target.checked)}>Понимаю риск повторных сообщений и подтверждаю</Checkbox>
    </Modal>
  </Space>;
};

function toFormValues(settings: DailyDigestSettings): SettingsFormValues {
  return {
    ...settings,
    sendTime: parseTime(settings.sendTime),
    catchUpDeadline: parseTime(settings.catchUpDeadline),
  };
}

function parseTime(value: string): Dayjs {
  const [hour = '0', minute = '0'] = value.split(':');
  return dayjs().hour(Number(hour)).minute(Number(minute)).second(0).millisecond(0);
}

export function settingsDraftMatchesSaved(values: SettingsFormValues, settings: DailyDigestSettings): boolean {
  return values.version === settings.version
    && values.enabled === settings.enabled
    && (values.groupChatId?.trim() || null) === settings.groupChatId
    && values.sendTime?.format('HH:mm') === settings.sendTime
    && values.catchUpPolicy === settings.catchUpPolicy
    && values.catchUpDeadline?.format('HH:mm') === settings.catchUpDeadline
    && values.cardsPerMessage === settings.cardsPerMessage
    && values.partialPolicy === settings.partialPolicy;
}

function weekdayDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return date;
  return new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parsed);
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Almaty' }).format(timestamp) : value;
}

function runStateColor(state: DailyDigestRunState): string {
  if (state === 'sent') return 'green';
  if (state === 'partial' || state === 'unknown' || state === 'sending') return 'orange';
  if (state === 'failed') return 'red';
  return 'default';
}

function runReasonText(reason: string): string {
  const known: Record<string, string> = {
    runtime_unavailable: 'Отправка не была поставлена в очередь: WhatsApp недоступен.',
    no_orders: 'На дату запуска заказов не было.',
    catch_up_window_elapsed: 'Контрольное время отправки прошло.',
    image_expired: 'Срок хранения изображения истёк; повторная отправка невозможна.',
    settings_changed: 'Настройки изменились до запуска отправки.',
  };
  return known[reason] ?? 'Дополнительные сведения доступны в техническом журнале.';
}

function maskDestination(destination: string | null): string {
  if (!destination) return 'группа не настроена';
  const suffix = destination.endsWith('@g.us') ? '@g.us' : '';
  const digits = suffix ? destination.slice(0, -suffix.length) : destination;
  return `${digits.slice(0, 4)}…${suffix}`;
}

function canRetry(detail: DailyDigestRunDetail): boolean {
  return detail.pages.length > 0
    && detail.pages.some((page) => ['failed', 'unknown', 'pending', 'cancelled'].includes(page.state))
    && detail.pages.every((page) => page.imageAvailable && !isDigestImageExpired(page.expiresAt));
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message && error.message.length < 240) return error.message;
  return fallback;
}

function pendingManualSendStorageKey(actorId: string): string | null {
  return actorId ? `${PENDING_MANUAL_SEND_KEY}:${encodeURIComponent(actorId)}` : null;
}

function readPendingManualSend(actorId: string): PendingManualSend | null {
  try {
    const storageKey = pendingManualSendStorageKey(actorId);
    if (typeof window === 'undefined' || !storageKey) return null;
    const stored = window.sessionStorage.getItem(storageKey);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed) || !isRecord(parsed.payload)) return null;
    const payload = parsed.payload;
    const { settingsVersion, idempotencyKey, confirmed } = payload;
    if (parsed.actorId !== actorId || typeof settingsVersion !== 'number' || !Number.isSafeInteger(settingsVersion) || typeof idempotencyKey !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(idempotencyKey) || confirmed !== true || typeof parsed.ambiguous !== 'boolean') return null;
    return { actorId, payload: { settingsVersion, idempotencyKey, confirmed: true }, ambiguous: parsed.ambiguous };
  } catch {
    return null;
  }
}

function persistPendingManualSend(actorId: string, request: PendingManualSend): void {
  try {
    const storageKey = pendingManualSendStorageKey(actorId);
    if (typeof window !== 'undefined' && storageKey && request.actorId === actorId) window.sessionStorage.setItem(storageKey, JSON.stringify(request));
  } catch {
    // The in-memory request remains available for retries within this page session.
  }
}

function clearPendingManualSend(actorId: string): void {
  try {
    const storageKey = pendingManualSendStorageKey(actorId);
    if (typeof window !== 'undefined' && storageKey) window.sessionStorage.removeItem(storageKey);
  } catch {
    // A stale idempotency key is safer than generating a second command.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isKnownNotQueuedError(error: unknown, priorAttemptWasAmbiguous: boolean): boolean {
  if (!(error instanceof ApiError)) return false;
  const servicePreflightCodes = [
    'WHATSAPP_DAILY_DIGEST_VERSION_CONFLICT',
    'WHATSAPP_DAILY_DIGEST_DESTINATION_REQUIRED',
    'WHATSAPP_DAILY_DIGEST_RUNTIME_UNAVAILABLE',
  ];
  if (servicePreflightCodes.includes(error.code)) return true;
  return !priorAttemptWasAmbiguous && [
    'AUTH_REQUIRED',
    'PERMISSION_DENIED',
    'VALIDATION_ERROR',
  ].includes(error.code);
}

function createUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    return (token === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function getAuthScopeSnapshot(): string {
  const user = authSession.getUser();
  return user ? `${user.id}|${getUserAuthorizationScopeKey(user)}` : '';
}
