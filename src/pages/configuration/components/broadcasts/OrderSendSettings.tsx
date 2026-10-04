import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Form, Input, InputNumber, Row, Select, Space, Switch, Typography, message } from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { ApiError } from '../../../../api/apiError';
import { authSession } from '../../../../api/authSession';
import { orderSendApi } from '../../../../api/orderSendApi';
import type { OrderSendSettingsEnvelope } from '../../../../api/orderSendApiTypes';
import { can } from '../../../../utils/permissions';
import { invalidateOrderSendMenu } from '../../../orders/whatsappOrderSendSupport';
import { loadWhatsAppGroups } from '../whatsappGroupsCache';
import { findGroupById, groupDisplayName } from '../whatsappGroupsView';
import { WhatsAppGroupSelect } from '../WhatsAppGroupSelect';
import {
  ORDER_SEND_CAPTION_MAX,
  ORDER_SEND_LABEL_MAX,
  ORDER_SEND_CHANNEL_LABELS,
  ORDER_SEND_MAX_CHATS,
  ORDER_SEND_MAX_EMPLOYEES,
  ORDER_SEND_SUPPORTED_CHANNELS,
  ORDER_SEND_MAX_INTERVAL,
  ORDER_SEND_MIN_INTERVAL,
  buildOrderSendUpdate,
  duplicateEmployeeIndexes,
  duplicateGroupIndexes,
  employeeDirectoryLabel,
  isOrderSendVersionConflict,
  orderSendDirty,
  orderSendSettingsErrorMessage,
  orderSendStatusText,
  toOrderSendFormValues,
  validateOrderSendCaption,
  validateOrderSendGroup,
  validateOrderSendInterval, validateOrderSendWindow,
  validateOrderSendLabel,
  type OrderSendFormValues,
} from './orderSendSettingsModel';
import './broadcasts.css';

const { Paragraph, Text } = Typography;

/**
 * «Отправка заказа из карточки»: who the «Отправить заказ» icon of an order card can send to and which forms.
 * Renders nothing for users without whatsapp.manage and on a backend that does not have the feature (404).
 */
export const OrderSendSettings: React.FC = () => {
  const allowed = can('whatsapp.manage', authSession.getUser());
  const [form] = Form.useForm<OrderSendFormValues>();
  const values = Form.useWatch([], form) as OrderSendFormValues | undefined;
  const [envelope, setEnvelope] = useState<OrderSendSettingsEnvelope | null>(null);
  const [loading, setLoading] = useState(allowed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  const load = useCallback(async (notice?: string) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const next = await orderSendApi.settings();
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setEnvelope(next);
      form.resetFields();
      form.setFieldsValue(toOrderSendFormValues(next.settings));
      setError(notice ?? '');
    } catch (err) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      if (err instanceof ApiError && err.status === 404) setUnsupported(true);
      else setError(orderSendSettingsErrorMessage(err, 'Не удалось загрузить настройки отправки заказа из карточки.'));
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    mountedRef.current = true;
    if (allowed) void load();
    return () => { mountedRef.current = false; requestRef.current += 1; };
  }, [load, allowed]);

  const settings = envelope?.settings ?? null;
  const dirty = Boolean(settings && values && orderSendDirty(values, settings));
  const formOptions = (envelope?.forms ?? []).map((item) => ({ value: item.code, label: item.title }));
  const variableNames = (envelope?.captionVariables ?? []).map((item) => item.name);

  const save = async (formValues: OrderSendFormValues) => {
    if (!settings) return;
    const body = buildOrderSendUpdate(settings.version, formValues);
    if (!body) return;
    setSaving(true);
    setError('');
    try {
      const next = await orderSendApi.updateSettings(body);
      if (!mountedRef.current) return;
      invalidateOrderSendMenu();
      setEnvelope(next);
      form.resetFields();
      form.setFieldsValue(toOrderSendFormValues(next.settings));
      message.success('Настройки отправки заказа из карточки сохранены.');
    } catch (err) {
      if (!mountedRef.current) return;
      if (isOrderSendVersionConflict(err)) void load('Настройки изменены другим пользователем — данные обновлены.');
      else setError(orderSendSettingsErrorMessage(err, 'Не удалось сохранить настройки отправки заказа из карточки.'));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  // A new row gets the group name as its menu label when the user has not typed one.
  const prefillLabel = async (index: number, groupChatId: string) => {
    if (!groupChatId.trim()) return;
    try {
      const group = findGroupById(await loadWhatsAppGroups(), groupChatId);
      if (!group || !mountedRef.current) return;
      const chats = (form.getFieldValue('chats') ?? []) as OrderSendFormValues['chats'];
      if (!chats[index] || chats[index].label?.trim() || chats[index].groupChatId !== groupChatId) return;
      form.setFieldValue(['chats', index, 'label'], groupDisplayName(group));
    } catch {
      // The list is only a convenience; the label stays empty and validation asks for it.
    }
  };

  if (!allowed || unsupported) return null;
  if (!settings) {
    return <Card title="Отправка заказа из карточки" loading={loading}>
      {error && <Alert type="error" showIcon message={error} action={<Button onClick={() => void load()}>Повторить</Button>} />}
    </Card>;
  }

  const status = orderSendStatusText(envelope?.nextAllowedAt ?? null, Boolean(envelope?.activeSend), Date.now(), envelope ?? undefined);
  const runtime = envelope?.runtime;
  const runtimeAvailable = Boolean(runtime?.enabled && runtime.relayAvailable);
  const fieldsLocked = saving || loading;
  const duplicates = duplicateGroupIndexes(values?.chats ?? []);
  const employeesSupported = Array.isArray(settings.employees);
  const employeeDuplicates = duplicateEmployeeIndexes(values?.employees ?? []);
  const directory = envelope?.employeeDirectory ?? [];
  // An employee already in the settings stays selectable even when inactive (the directory has active ones only).
  const employeeOptions = [
    ...directory.map((item) => ({ value: item.employeeId, label: `${employeeDirectoryLabel(item)}${item.phones === 0 ? ' — нет рабочего телефона' : ''}` })),
    ...(settings.employees ?? []).filter((item) => !directory.some((entry) => entry.employeeId === item.employeeId))
      .map((item) => ({ value: item.employeeId, label: `${item.employeeName} (неактивен)` })),
  ];
  const channelOptions = (['whatsapp', 'telegram'] as const).map((channel) => ({
    value: channel,
    label: ORDER_SEND_SUPPORTED_CHANNELS.includes(channel) ? ORDER_SEND_CHANNEL_LABELS[channel] : `${ORDER_SEND_CHANNEL_LABELS[channel]} (скоро)`,
    disabled: !ORDER_SEND_SUPPORTED_CHANNELS.includes(channel),
  }));
  const variablesHint = (envelope?.captionVariables ?? []).length > 0
    ? <Text type="secondary">Переменные: {(envelope?.captionVariables ?? []).map((item) => `{${item.name}} — ${item.label}`).join('; ')}</Text>
    : null;
  const captionRule = { validator: async (_: unknown, value: string | undefined) => {
    const problem = validateOrderSendCaption(value, variableNames);
    if (problem) throw new Error(problem);
  } };

  return <Card title="Отправка заказа из карточки" extra={<Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading} disabled={saving}>Обновить</Button>}>
    <Paragraph type="secondary">Команды «Отправить клиенту в WhatsApp» и «Отправить в чат» под иконкой «Отправить заказ» в карточке заказа (слева от «⋯») ставят выбранную форму в общую очередь: отправки уходят по одной с порогом частоты и окном. Ожидающая отправка ждёт не больше 24 часов.</Paragraph>
    {error && <Alert style={{ marginBottom: 12 }} type={error.startsWith('Настройки изменены') ? 'warning' : 'error'} showIcon message={error} closable onClose={() => setError('')} />}
    <Form form={form} layout="vertical" initialValues={toOrderSendFormValues(settings)} disabled={fieldsLocked} onFinish={(v: OrderSendFormValues) => void save(v)}>
      <Row gutter={[16, 0]}>
        <Col xs={24} sm={8} xl={4}>
          <Form.Item name="enabled" label="Включено" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Col>
        <Col xs={24} sm={8} xl={5}>
          <Form.Item name="minIntervalMinutes" label="Порог частоты, мин" extra="Общий для всех отправок из карточек заказов" rules={[{ validator: async (_, value: number | null | undefined) => {
            const problem = validateOrderSendInterval(value);
            if (problem) throw new Error(problem);
          } }]}>
            <InputNumber min={ORDER_SEND_MIN_INTERVAL} max={ORDER_SEND_MAX_INTERVAL} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col xs={24} sm={8} xl={5}>
          <Form.Item name="sendWindowMinutes" label="Окно отправки, мин" dependencies={['minIntervalMinutes']}
            extra="Следующая отправка уходит в случайный момент этого окна после порога. Не больше половины порога; 0 — без окна."
            rules={[({ getFieldValue }) => ({ validator: async (_: unknown, value: number | null | undefined) => {
              const problem = validateOrderSendWindow(value, getFieldValue('minIntervalMinutes'));
              if (problem) throw new Error(problem);
            } })]}>
            <InputNumber min={0} max={720} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <Form.Item name="clientForms" label="Клиенту: разрешённые формы">
            <Checkbox.Group className="order-send-forms" options={formOptions} />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Form.Item name="clientCaption" label="Клиенту: подпись" rules={[captionRule]} extra={variablesHint}>
            <Input.TextArea rows={4} maxLength={ORDER_SEND_CAPTION_MAX} placeholder="Заказ {order_name}" />
          </Form.Item>
        </Col>
      </Row>
      <Typography.Title level={5}>Чаты</Typography.Title>
      <Form.List name="chats">
        {(fields, { add, remove }) => <>
          <Row gutter={[12, 12]}>
            {fields.map((field, index) => <Col key={field.key} xs={24} lg={12} xxl={8}>
              <Card size="small" style={{ height: '100%' }}
                title={`Чат ${index + 1}`}
                extra={<Button type="text" danger icon={<DeleteOutlined />} aria-label={`Удалить чат ${index + 1}`} onClick={() => remove(field.name)} />}>
                <Form.Item name={[field.name, 'chatKey']} hidden noStyle><Input type="hidden" /></Form.Item>
                <Form.Item name={[field.name, 'groupChatId']} label="Группа WhatsApp" rules={[{ validator: async (_, value: string | null | undefined) => {
                  const problem = validateOrderSendGroup(value) ?? (duplicates.has(index) ? 'Эта группа уже указана в другом чате.' : null);
                  if (problem) throw new Error(problem);
                } }]}>
                  <WhatsAppGroupSelect placeholder="120…@g.us" onChange={(next) => void prefillLabel(index, next)} />
                </Form.Item>
                <Row gutter={12}>
                  <Col xs={24} sm={12}>
                    <Form.Item name={[field.name, 'label']} label="Название в меню" rules={[{ validator: async (_, value: string | undefined) => {
                      const problem = validateOrderSendLabel(value);
                      if (problem) throw new Error(problem);
                    } }]}>
                      <Input maxLength={ORDER_SEND_LABEL_MAX} placeholder="Цех ЧПУ" />
                    </Form.Item>
                    <Form.Item name={[field.name, 'forms']} label="Формы">
                      <Checkbox.Group className="order-send-forms" options={formOptions} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={12}>
                    <Form.Item name={[field.name, 'caption']} label="Подпись" rules={[captionRule]}>
                      <Input.TextArea rows={7} maxLength={ORDER_SEND_CAPTION_MAX} />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>
            </Col>)}
          </Row>
          <Space style={{ marginTop: 12 }}>
            <Button icon={<PlusOutlined />} disabled={fieldsLocked || fields.length >= ORDER_SEND_MAX_CHATS}
              onClick={() => { if (!fieldsLocked) add({ chatKey: null, groupChatId: '', label: '', forms: [], caption: '' }); }}>Добавить чат</Button>
            {fields.length >= ORDER_SEND_MAX_CHATS && <Text type="secondary">Не больше {ORDER_SEND_MAX_CHATS} чатов.</Text>}
          </Space>
        </>}
      </Form.List>
      {employeesSupported && <>
        <Typography.Title level={5} style={{ marginTop: 16 }}>Сотрудники</Typography.Title>
        <Paragraph type="secondary">Сотрудник получает форму на рабочий телефон из своей карточки: по умолчанию основной, в меню можно выбрать другой.</Paragraph>
        <Form.List name="employees">
          {(fields, { add, remove }) => <>
            <Row gutter={[12, 12]}>
              {fields.map((field, index) => <Col key={field.key} xs={24} lg={12} xxl={8}>
                <Card size="small" style={{ height: '100%' }}
                  title={`Сотрудник ${index + 1}`}
                  extra={<Button type="text" danger icon={<DeleteOutlined />} aria-label={`Удалить сотрудника ${index + 1}`} onClick={() => remove(field.name)} />}>
                  <Form.Item name={[field.name, 'recipientKey']} hidden noStyle><Input type="hidden" /></Form.Item>
                  <Row gutter={12}>
                    <Col xs={24} sm={16}>
                      <Form.Item name={[field.name, 'employeeId']} label="Пользователь / сотрудник" rules={[{ validator: async (_, value: number | null | undefined) => {
                        if (value == null) throw new Error('Выберите сотрудника.');
                        if (employeeDuplicates.has(index)) throw new Error('Этот сотрудник с этим каналом уже есть в списке.');
                      } }]}>
                        <Select showSearch optionFilterProp="label" options={employeeOptions} placeholder="Выберите сотрудника" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name={[field.name, 'channel']} label="Канал">
                        <Select options={channelOptions} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={12}>
                      <Form.Item name={[field.name, 'forms']} label="Формы">
                        <Checkbox.Group className="order-send-forms" options={formOptions} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={12}>
                      <Form.Item name={[field.name, 'caption']} label="Подпись" rules={[captionRule]}>
                        <Input.TextArea rows={7} maxLength={ORDER_SEND_CAPTION_MAX} />
                      </Form.Item>
                    </Col>
                  </Row>
                </Card>
              </Col>)}
            </Row>
            <Space style={{ marginTop: 12 }}>
              <Button icon={<PlusOutlined />} disabled={fieldsLocked || fields.length >= ORDER_SEND_MAX_EMPLOYEES}
                onClick={() => { if (!fieldsLocked) add({ recipientKey: null, employeeId: null, channel: 'whatsapp', forms: [], caption: 'Заказ {order_name}' }); }}>Добавить сотрудника</Button>
              {fields.length >= ORDER_SEND_MAX_EMPLOYEES && <Text type="secondary">Не больше {ORDER_SEND_MAX_EMPLOYEES} сотрудников.</Text>}
            </Space>
          </>}
        </Form.List>
      </>}
      {typeof settings.supplierRequestsEnabled === 'boolean' && <>
        <Typography.Title level={5} style={{ marginTop: 16 }}>Заявки поставщикам</Typography.Title>
        <Form.Item name="supplierRequestsEnabled" valuePropName="checked"
          extra="Кнопка «Отправить в WhatsApp» в окне «Текст для поставщика» экрана снабжения: текст уходит на телефон поставщика из справочника через эту же очередь и порог. Выключение отменяет ожидающие заявки.">
          <Checkbox>Отправлять заявки поставщикам в WhatsApp</Checkbox>
        </Form.Item>
      </>}
      {status && <Alert style={{ margin: '12px 0' }} type="info" showIcon message={status} />}
      {!runtimeAvailable && <Alert style={{ margin: '12px 0' }} type="warning" showIcon message="Отправка WhatsApp сейчас недоступна" />}
      <Space wrap style={{ marginTop: 12 }}>
        <Button type="primary" htmlType="submit" loading={saving} disabled={!dirty}>Сохранить настройки</Button>
        {dirty && <Text type="secondary">Есть несохранённые изменения.</Text>}
      </Space>
    </Form>
  </Card>;
};
