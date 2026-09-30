import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Dropdown, Form, Input, InputNumber, Modal, Select, Space, Switch, Typography, message } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { ReloadOutlined } from '@ant-design/icons';
import { broadcastsApi } from '../../../../api/broadcastsApi';
import type {
  Broadcast,
  BroadcastCaptionVariable,
  BroadcastEnvelope,
  BroadcastTodaySchedule,
} from '../../../../api/broadcastsApiTypes';
import { ClockTimePicker } from '../../../../ui/ClockTimePicker';
import { WhatsAppGroupSelect } from '../WhatsAppGroupSelect';
import {
  ALL_DAYS,
  CAPTION_MAX_LENGTH,
  WEEKDAY_OPTIONS,
  WORKDAYS,
  broadcastErrorMessage,
  buildSaveRequest,
  clearPendingReplan,
  createUuid,
  defaultFormValues,
  draftMatchesSaved,
  formatScheduleTime,
  insertCaptionVariable,
  isKnownNotCreatedCommandError,
  isVersionConflict,
  offsetOptions,
  persistPendingReplan,
  readPendingReplan,
  runPendingCommand,
  STORAGE_UNAVAILABLE_MESSAGE,
  toFormValues,
  validateCaption,
  validateDeadline,
  validateGroupId,
  validateName,
  validateWeekdays,
  validateWindow,
  type BroadcastFormValues,
  type PendingReplan,
} from './broadcastModel';
import './broadcasts.css';

const { Paragraph } = Typography;

export interface BroadcastEditorProps {
  /** null = creating a new broadcast. */
  broadcast: Broadcast | null;
  todaySchedule: BroadcastTodaySchedule | null;
  captionVariables: BroadcastCaptionVariable[];
  /** Current user: an unconfirmed replan key is kept per user and broadcast. */
  actorId: string;
  createDisabled?: boolean;
  onSaved: (envelope: BroadcastEnvelope, created: boolean) => void;
  onEnvelope: (envelope: BroadcastEnvelope) => void;
  onArchived: () => void;
  onConflict: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
}

export const BroadcastEditor: React.FC<BroadcastEditorProps> = ({
  broadcast, todaySchedule, captionVariables, actorId, createDisabled, onSaved, onEnvelope, onArchived, onConflict, onDirtyChange, onClose,
}) => {
  const [form] = Form.useForm<BroadcastFormValues>();
  const values = Form.useWatch([], form) as BroadcastFormValues | undefined;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmReplan, setConfirmReplan] = useState(false);
  const [busy, setBusy] = useState(false);
  const captionRef = useRef<TextAreaRef>(null);
  // An unconfirmed replan survives remounts: after a lost response the same key and
  // version are replayed (the ledger answers first), never a second replan.
  const [pendingReplan, setPendingReplan] = useState<PendingReplan | null>(() => (broadcast ? readPendingReplan(broadcast.id, actorId) : null));
  const mountedRef = useRef(false);
  const enabled = Form.useWatch('enabled', form);
  const catchUpPolicy = Form.useWatch('catchUpPolicy', form);
  const partialPolicy = Form.useWatch('partialPolicy', form);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    form.resetFields();
    form.setFieldsValue(broadcast ? toFormValues(broadcast) : defaultFormValues());
    setRiskConfirmed(false);
    setError('');
  }, [broadcast?.id, broadcast?.version, form]);

  const dirty = Boolean(values && (broadcast ? !draftMatchesSaved(values, broadcast) : true));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const save = async (formValues: BroadcastFormValues) => {
    setSaving(true);
    setError('');
    try {
      const request = buildSaveRequest(broadcast, formValues, riskConfirmed);
      const envelope = request.kind === 'create'
        ? await broadcastsApi.create(request.body)
        : await broadcastsApi.update(request.id, request.body);
      if (!mountedRef.current) return;
      message.success('Рассылка сохранена.');
      onSaved(envelope, request.kind === 'create');
    } catch (err) {
      if (!mountedRef.current) return;
      if (isVersionConflict(err)) onConflict();
      setError(broadcastErrorMessage(err, 'Не удалось сохранить рассылку. Обновите её и повторите попытку.'));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const archive = async () => {
    if (!broadcast) return;
    setBusy(true);
    try {
      await broadcastsApi.archive(broadcast.id, { version: broadcast.version });
      if (!mountedRef.current) return;
      setConfirmArchive(false);
      message.success('Рассылка перенесена в архив.');
      onArchived();
    } catch (err) {
      if (!mountedRef.current) return;
      setConfirmArchive(false);
      if (isVersionConflict(err)) onConflict();
      setError(broadcastErrorMessage(err, 'Не удалось архивировать рассылку.'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const replan = async () => {
    if (!broadcast) return;
    const broadcastId = broadcast.id;
    const version = broadcast.version;
    setBusy(true);
    setError('');
    const outcome = await runPendingCommand<PendingReplan, BroadcastEnvelope>({
      // Stored request, else the one still held in memory (storage may have refused the write).
      stored: readPendingReplan(broadcastId, actorId) ?? (pendingReplan?.broadcastId === broadcastId ? pendingReplan : null),
      fresh: () => ({ actorId, broadcastId, payload: { version, idempotencyKey: createUuid() } }),
      persist: persistPendingReplan,
      clear: () => clearPendingReplan(broadcastId),
      send: (request) => broadcastsApi.replanToday(request.broadcastId, request.payload),
      isDefinite: isKnownNotCreatedCommandError,
    });
    if (!mountedRef.current) return;
    setBusy(false);
    setConfirmReplan(false);
    setPendingReplan(outcome.status === 'uncertain' ? outcome.request : null);
    if (outcome.status === 'done') {
      message.success(outcome.replayed ? 'Перепланирование подтверждено.' : 'Сегодняшнее время перепланировано.');
      onEnvelope(outcome.result);
    } else if (outcome.status === 'not-stored') {
      setError(STORAGE_UNAVAILABLE_MESSAGE);
    } else if (outcome.status === 'refused') {
      if (isVersionConflict(outcome.error)) onConflict();
      setError(broadcastErrorMessage(outcome.error, 'Не удалось перепланировать сегодняшнюю рассылку.'));
    } else {
      setError('Не удалось подтвердить результат перепланирования. Проверка отправит тот же запрос и не перепланирует второй раз.');
    }
  };

  const insertVariable = (name: string) => {
    const textArea = captionRef.current?.resizableTextArea?.textArea;
    const current = String(form.getFieldValue('captionTemplate') ?? '');
    const { text } = insertCaptionVariable(current, name, textArea?.selectionStart ?? current.length, textArea?.selectionEnd ?? current.length);
    form.setFieldsValue({ captionTemplate: text });
  };

  const fieldsLocked = saving || busy;
  return <Card title={broadcast ? `Рассылка: ${broadcast.name}` : 'Новая рассылка'} extra={<Button onClick={onClose}>Закрыть</Button>}>
    {error && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={error} closable onClose={() => setError('')} />}
    <Form form={form} layout="vertical" initialValues={defaultFormValues()} disabled={fieldsLocked} onFinish={(v: BroadcastFormValues) => void save(v)}>
      <div className="broadcast-settings-grid">
        <Form.Item className="broadcast-settings-wide" name="name" label="Название" rules={[{ validator: async (_, value: string | undefined) => {
          const problem = validateName(value);
          if (problem) throw new Error(problem);
        } }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item name="enabled" label="Автоматическая рассылка" valuePropName="checked" tooltip="Предпросмотр и ручная отправка работают независимо от этого переключателя.">
          <Switch checkedChildren="Включена" unCheckedChildren="Выключена" />
        </Form.Item>
        <Form.Item className="broadcast-settings-wide" name="groupChatId" label="Группа WhatsApp" dependencies={['enabled']} rules={[{ validator: async (_, value: string | null | undefined) => {
          const problem = validateGroupId(value, Boolean(form.getFieldValue('enabled')));
          if (problem) throw new Error(problem);
        } }]} tooltip="ID группы хранится в защищённых настройках. В истории показывается только маска.">
          <WhatsAppGroupSelect placeholder="120…@g.us" />
        </Form.Item>
        <Form.Item className="broadcast-settings-wide" label="Дни недели" required>
          <Form.Item name="weekdays" noStyle dependencies={['enabled']} rules={[{ validator: async (_, value: number[] | undefined) => {
            const problem = validateWeekdays(value, Boolean(form.getFieldValue('enabled')));
            if (problem) throw new Error(problem);
          } }]}>
            <Checkbox.Group options={WEEKDAY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
          </Form.Item>
          <Space size="small" style={{ marginLeft: 12 }}>
            <Button size="small" onClick={() => form.setFieldsValue({ weekdays: [...WORKDAYS] })}>Будни</Button>
            <Button size="small" onClick={() => form.setFieldsValue({ weekdays: [...ALL_DAYS] })}>Все дни</Button>
          </Space>
        </Form.Item>
        <Form.Item name="sendTime" label="Начало окна отправки" rules={[{ required: true, message: 'Укажите время отправки.' }]}>
          <ClockTimePicker minuteStep={5} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="sendWindowMinutes" label="Случайное окно отправки, минут" dependencies={['sendTime']} rules={[{ required: true, message: 'Укажите длительность окна.' }, { validator: async (_, duration: number | undefined) => {
          const problem = validateWindow(form.getFieldValue('sendTime'), duration);
          if (problem) throw new Error(problem);
        } }]} tooltip="0 — отправка точно в указанное время. Больше 0 — сервер один раз в день случайно выбирает минуту внутри окна и фиксирует её до конца дня.">
          <InputNumber min={0} max={1439} step={5} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="orderDateOffsetDays" label="Заказы на" rules={[{ required: true }]} tooltip="Плановая дата выдачи заказов относительно дня отправки.">
          <Select style={{ width: '100%' }} options={offsetOptions()} />
        </Form.Item>
        <Form.Item name="cardsPerMessage" label="Карточек в сообщении" rules={[{ required: true }]}>
          <Select style={{ width: '100%' }} options={[{ value: 1, label: '1 карточка' }, { value: 2, label: '2 карточки' }]} />
        </Form.Item>
        <Form.Item name="catchUpPolicy" label="Если сервер пропустил время отправки" rules={[{ required: true }]}>
          <Select style={{ width: '100%' }} options={[
            { value: 'skip', label: 'Пропустить рассылку за сегодня' },
            { value: 'until_deadline', label: 'Отправить до контрольного времени' },
            { value: 'end_of_day', label: 'Отправить до конца дня' },
          ]} />
        </Form.Item>
        {/* Always registered (only hidden) for the other policies: the form values must keep the saved deadline. */}
        <Form.Item name="catchUpDeadline" label="Контрольное время" hidden={catchUpPolicy !== 'until_deadline'}
          dependencies={['sendTime', 'sendWindowMinutes', 'catchUpPolicy']} rules={[{ validator: async (_, deadline: unknown) => {
          if (form.getFieldValue('catchUpPolicy') !== 'until_deadline') return;
          if (!deadline) throw new Error('Укажите контрольное время.');
          const problem = validateDeadline(deadline as BroadcastFormValues['catchUpDeadline'], form.getFieldValue('sendTime'), Number(form.getFieldValue('sendWindowMinutes') ?? 0));
          if (problem) throw new Error(problem);
        } }]}>
          <ClockTimePicker minuteStep={5} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="partialPolicy" label="Если отправлена только часть" rules={[{ required: true }]}>
          <Select style={{ width: '100%' }} options={[
            { value: 'remaining', label: 'Продолжить с неотправленных карточек' },
            { value: 'repeat_all', label: 'Повторить всё' },
            { value: 'manual', label: 'Остановить и ждать решения оператора' },
          ]} />
        </Form.Item>
        <Form.Item className="broadcast-settings-wide" name="captionTemplate" label="Подпись к первой картинке" rules={[{ validator: async (_, value: string | undefined) => {
          const problem = validateCaption(value);
          if (problem) throw new Error(problem);
        } }]} extra={<Dropdown menu={{ items: captionVariables.map((v) => ({ key: v.name, label: `${v.label} — ${v.example}` })), onClick: ({ key }) => insertVariable(String(key)) }} disabled={captionVariables.length === 0}>
          <Button size="small" type="link">Переменные</Button>
        </Dropdown>}>
          <Input.TextArea ref={captionRef} rows={2} maxLength={CAPTION_MAX_LENGTH} placeholder="Заказы на {target_date}" />
        </Form.Item>
      </div>
      {partialPolicy === 'repeat_all' && <Alert type="warning" showIcon message="Повтор может отправить уже полученные карточки ещё раз." description={<Checkbox checked={riskConfirmed} onChange={(event) => setRiskConfirmed(event.target.checked)}>Подтверждаю возможные повторные сообщения</Checkbox>} />}
      {broadcast && todaySchedule
        ? <Alert style={{ marginTop: 8 }} type="info" showIcon message={`Сегодня отправка запланирована на ${formatScheduleTime(todaySchedule.scheduledAt)}`}
          description={`${todaySchedule.sendWindowMinutes > 0 ? `Время выбрано случайно в окне ${todaySchedule.windowStart}–${todaySchedule.windowEnd}. ` : ''}Изменения расписания применятся к завтрашнему дню; чтобы пересчитать сегодняшнее время, используйте «Перепланировать сегодня».`}
          action={<Button size="small" onClick={() => setConfirmReplan(true)} disabled={dirty || fieldsLocked || Boolean(pendingReplan)}>Перепланировать сегодня</Button>} />
        : broadcast && enabled ? <Paragraph type="secondary" style={{ marginTop: 8 }}>Время отправки на сегодня не запланировано: сегодня не день рассылки или планировщик ещё не выбрал минуту.</Paragraph> : null}
      {broadcast && pendingReplan && !busy && <Alert style={{ marginTop: 8 }} type="warning" showIcon message="Результат перепланирования не подтверждён"
        description="Сегодняшнее время могло уже измениться. Проверка отправит тот же запрос и не перепланирует второй раз."
        action={<Button size="small" loading={busy} onClick={() => void replan()}>Проверить</Button>} />}
      <Space wrap style={{ marginTop: 12 }}>
        <Button type="primary" htmlType="submit" loading={saving} disabled={!dirty || (partialPolicy === 'repeat_all' && !riskConfirmed) || (!broadcast && Boolean(createDisabled) && Boolean(enabled))}>
          {broadcast ? 'Сохранить настройки' : 'Создать рассылку'}
        </Button>
        {broadcast && <Button icon={<ReloadOutlined />} onClick={onConflict} disabled={fieldsLocked}>Обновить</Button>}
        {broadcast && <Button danger onClick={() => setConfirmArchive(true)} disabled={fieldsLocked}>Архивировать</Button>}
      </Space>
    </Form>
    <Modal open={confirmArchive} title="Архивировать рассылку" okText="Архивировать" cancelText="Отмена" okButtonProps={{ danger: true }} confirmLoading={busy} onCancel={() => setConfirmArchive(false)} onOk={() => void archive()}>
      <Paragraph>Рассылка «{broadcast?.name}» будет выключена и убрана из списка. История отправок сохранится.</Paragraph>
    </Modal>
    <Modal open={confirmReplan} title="Перепланировать сегодня" okText="Перепланировать" cancelText="Отмена" confirmLoading={busy} onCancel={() => setConfirmReplan(false)} onOk={() => void replan()}>
      <Paragraph>Сервер заново выберет минуту отправки на сегодня по текущим настройкам. Если сегодняшняя отправка уже началась, перепланирование будет отклонено.</Paragraph>
    </Modal>
  </Card>;
};
