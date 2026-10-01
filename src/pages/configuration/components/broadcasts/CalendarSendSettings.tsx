import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Dropdown, Form, InputNumber, Select, Space, Typography, Input, message } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { ReloadOutlined } from '@ant-design/icons';
import { broadcastsApi } from '../../../../api/broadcastsApi';
import type { BroadcastCaptionVariable, CalendarSendEnvelope } from '../../../../api/broadcastsApiTypes';
import { authSession } from '../../../../api/authSession';
import { WhatsAppGroupSelect } from '../WhatsAppGroupSelect';
import { BroadcastHistory } from './BroadcastHistory';
import {
  CALENDAR_SEND_MAX_INTERVAL,
  CALENDAR_SEND_MIN_INTERVAL,
  buildCalendarSendUpdate,
  calendarSendDirty,
  calendarSendStatusText,
  toCalendarSendFormValues,
  validateInterval,
  type CalendarSendFormValues,
} from './calendarSendModel';
import { noteCalendarSendInterval } from './calendarSendSupport';
import {
  CAPTION_MAX_LENGTH,
  broadcastErrorMessage,
  insertCaptionVariable,
  isVersionConflict,
  validateCaption,
  validateGroupId,
} from './broadcastModel';
import './broadcasts.css';

const { Paragraph, Text } = Typography;

export interface CalendarSendSettingsProps {
  captionVariables: BroadcastCaptionVariable[];
  paused: boolean;
}

export const CalendarSendSettings: React.FC<CalendarSendSettingsProps> = ({ captionVariables, paused }) => {
  const actorId = authSession.getUser()?.id ?? '';
  const [form] = Form.useForm<CalendarSendFormValues>();
  const values = Form.useWatch([], form) as CalendarSendFormValues | undefined;
  const [envelope, setEnvelope] = useState<CalendarSendEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const captionRef = useRef<TextAreaRef>(null);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  const load = useCallback(async (notice?: string) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const next = await broadcastsApi.calendarSendSettings();
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setEnvelope(next);
      noteCalendarSendInterval(next.settings.minIntervalMinutes);
      form.resetFields();
      form.setFieldsValue(toCalendarSendFormValues(next.settings));
      setError(notice ?? '');
    } catch (err) {
      if (mountedRef.current && requestId === requestRef.current) setError(broadcastErrorMessage(err, 'Не удалось загрузить настройки отправки из календаря.'));
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => { mountedRef.current = false; requestRef.current += 1; };
  }, [load]);

  const settings = envelope?.settings ?? null;
  const dirty = Boolean(settings && values && calendarSendDirty(values, settings));

  const save = async (formValues: CalendarSendFormValues) => {
    if (!settings) return;
    const body = buildCalendarSendUpdate(settings.version, formValues);
    if (!body) return;
    setSaving(true);
    setError('');
    try {
      const next = await broadcastsApi.updateCalendarSendSettings(body);
      if (!mountedRef.current) return;
      setEnvelope(next);
      noteCalendarSendInterval(next.settings.minIntervalMinutes);
      form.resetFields();
      form.setFieldsValue(toCalendarSendFormValues(next.settings));
      message.success('Настройки отправки из календаря сохранены.');
    } catch (err) {
      if (!mountedRef.current) return;
      if (isVersionConflict(err)) void load('Настройки изменены другим пользователем — данные обновлены.');
      else setError(broadcastErrorMessage(err, 'Не удалось сохранить настройки отправки из календаря.'));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const insertVariable = (name: string) => {
    const textArea = captionRef.current?.resizableTextArea?.textArea;
    const current = String(form.getFieldValue('captionTemplate') ?? '');
    const { text } = insertCaptionVariable(current, name, textArea?.selectionStart ?? current.length, textArea?.selectionEnd ?? current.length);
    form.setFieldsValue({ captionTemplate: text });
  };

  if (!settings) {
    return <Card title="Отправка из календаря" loading={loading}>
      {error && <Alert type="error" showIcon message={error} action={<Button onClick={() => void load()}>Повторить</Button>} />}
    </Card>;
  }

  const status = calendarSendStatusText(envelope?.nextAllowedAt ?? null, Boolean(envelope?.activeRun));
  const runtime = envelope?.runtime;
  const runtimeAvailable = Boolean(runtime?.enabled && runtime.relayAvailable);
  const fieldsLocked = saving || loading;

  return <>
    <Card title="Отправка из календаря" extra={<Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading} disabled={saving}>Обновить</Button>}>
      <Paragraph type="secondary">Команда «Отправить в чат» в календаре (правый клик по заголовку дня) сразу отправляет карточки заказов этого дня в выбранную группу.</Paragraph>
      {error && <Alert style={{ marginBottom: 12 }} type={error.startsWith('Настройки изменены') ? 'warning' : 'error'} showIcon message={error} closable onClose={() => setError('')} />}
      <Form form={form} layout="vertical" initialValues={toCalendarSendFormValues(settings)} disabled={fieldsLocked} onFinish={(v: CalendarSendFormValues) => void save(v)}>
        <div className="broadcast-settings-grid">
          <Form.Item className="broadcast-settings-wide" name="groupChatId" label="Группа WhatsApp" rules={[{ validator: async (_, value: string | null | undefined) => {
            const problem = validateGroupId(value, false);
            if (problem) throw new Error(problem);
          } }]} tooltip="ID группы хранится в защищённых настройках. В истории показывается только маска.">
            <WhatsAppGroupSelect placeholder="120…@g.us" />
          </Form.Item>
          <Form.Item name="cardsPerMessage" label="Карточек на картинке" rules={[{ required: true }]}>
            <Select style={{ width: '100%' }} options={[{ value: 1, label: '1 карточка' }, { value: 2, label: '2 карточки' }]} />
          </Form.Item>
          <Form.Item name="minIntervalMinutes" label="Не чаще одного раза в (мин)" rules={[{ validator: async (_, value: number | null | undefined) => {
            const problem = validateInterval(value);
            if (problem) throw new Error(problem);
          } }]}>
            <InputNumber min={CALENDAR_SEND_MIN_INTERVAL} max={CALENDAR_SEND_MAX_INTERVAL} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item className="broadcast-settings-wide" name="captionTemplate" label="Подпись" rules={[{ validator: async (_, value: string | undefined) => {
            const problem = validateCaption(value);
            if (problem) throw new Error(problem);
          } }]} extra={<Dropdown menu={{ items: captionVariables.map((v) => ({ key: v.name, label: `${v.label} — ${v.example}` })), onClick: ({ key }) => insertVariable(String(key)) }} disabled={captionVariables.length === 0}>
            <Button size="small" type="link">Переменные</Button>
          </Dropdown>}>
            <Input.TextArea ref={captionRef} rows={2} maxLength={CAPTION_MAX_LENGTH} placeholder="Заказы на {target_date}" />
          </Form.Item>
        </div>
        {status && <Alert style={{ marginBottom: 12 }} type="info" showIcon message={status} />}
        {!runtimeAvailable && <Alert style={{ marginBottom: 12 }} type="warning" showIcon message="Отправка WhatsApp сейчас недоступна" />}
        <Space wrap>
          <Button type="primary" htmlType="submit" loading={saving} disabled={!dirty}>Сохранить настройки</Button>
          {dirty && <Text type="secondary">Есть несохранённые изменения.</Text>}
        </Space>
      </Form>
    </Card>
    <BroadcastHistory broadcast={{ id: settings.broadcastId }} actorId={actorId} runtimeAvailable={runtimeAvailable && !paused} refreshToken={0} />
  </>;
};
