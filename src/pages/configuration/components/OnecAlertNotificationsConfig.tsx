import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Form, Modal, Select, Space, Spin, Switch, Tag, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { ApiError } from '../../../api/apiError';
import { Table } from '../../../ui/tooltipDelay';
import { can } from '../../../utils/permissions';
import {
  onecAlertNotificationsApi,
  type OnecAlertGroupView,
  type OnecAlertNotificationsOverview,
  type OnecAlertRecentDispatch,
} from '../../onec/onecAlertNotificationsApi';
import {
  IMPORTANCE_LABELS,
  IMPORTANCE_OPTIONS,
  REPEAT_OPTIONS,
  STAGE_LABELS,
  buildPolicyUpdate,
  importanceLabel,
  overviewWarnings,
  policyToFormValues,
  recipientsSummary,
  repeatLabel,
  type OnecAlertPolicyFormValues,
} from './onecAlertNotificationsModel';

const { Paragraph, Text } = Typography;

const formatTime = (value: string | null) => (value ? dayjs(value).format('DD.MM.YYYY HH:mm') : '—');
const errorText = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

/**
 * «Конфигурация → Оповещения 1С» (plan 2026-10-19 §3): for each group of 1C alerts — importance, recipients,
 * repeat of critical alerts, recovery notice. The bell and the balloon that closes only with its cross are always on
 * and cannot be switched off; Telegram and WhatsApp come with the next releases. View — onec.view, change and
 * «Проверить» — onec.manage (the backend checks the same literal permissions).
 */
export const OnecAlertNotificationsConfig: React.FC = () => {
  const canManage = can('onec.manage');
  const [overview, setOverview] = useState<OnecAlertNotificationsOverview | null>(null);
  const [recent, setRecent] = useState<OnecAlertRecentDispatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<OnecAlertGroupView | null>(null);
  const [values, setValues] = useState<OnecAlertPolicyFormValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [next, last] = await Promise.all([onecAlertNotificationsApi.overview(), onecAlertNotificationsApi.recent(30)]);
      setOverview(next);
      setRecent(last.data);
    } catch (error) {
      setLoadError(errorText(error, 'Не удалось загрузить настройки оповещений 1С'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = (group: OnecAlertGroupView) => {
    setEditing(group);
    setValues(policyToFormValues(group.policy));
  };

  const save = async () => {
    if (!editing || !values) return;
    setSaving(true);
    try {
      await onecAlertNotificationsApi.update(editing.code, editing.policy.version, buildPolicyUpdate(editing.policy, values));
      message.success(`Настройка «${editing.label}» сохранена`);
      setEditing(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONEC_ALERT_POLICY_VERSION_CONFLICT') {
        message.error('Настройку уже изменил другой пользователь — показаны актуальные значения');
        setEditing(null);
        await load();
      } else {
        message.error(errorText(error, 'Не удалось сохранить настройку'));
      }
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async (group: OnecAlertGroupView) => {
    setTesting(group.code);
    try {
      const result = await onecAlertNotificationsApi.test(group.code);
      if (result.visibleInBell) message.success('Проверочное оповещение отправлено вам: колокольчик и балун');
      else message.warning('Отправлено, но в колокольчике его не видно: нужно право «Просмотр интеграции 1С»');
    } catch (error) {
      message.error(errorText(error, 'Не удалось отправить проверку'));
    } finally {
      setTesting(null);
    }
  };

  if (loadError && !loading) {
    return (
      <Alert type="error" showIcon message={loadError} action={<Button size="small" onClick={() => void load()}>Повторить</Button>} />
    );
  }
  if (loading && !overview) return <Spin />;
  if (!overview) return null;

  const warnings = overviewWarnings(overview);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%', padding: '16px 0' }}>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Каждое оповещение интеграции 1С приходит в колокольчик и отдельным окном, которое закрывается только крестиком.
        Здесь — кому, с какой важностью и как часто. Telegram и WhatsApp появятся в следующих выпусках.
      </Paragraph>
      <Text type="secondary">
        Рассылка: {overview.flagEnabled ? (overview.active ? 'включена' : 'включается') : 'выключена'}
        {overview.enabledAt ? `, с ${formatTime(overview.enabledAt)}` : ''}; последний проход: {formatTime(overview.lastTickAt)}
      </Text>
      {warnings.map((warning) => (
        <Alert key={warning.message} type={warning.type} showIcon message={warning.message} />
      ))}
      {!canManage && <Alert type="info" showIcon message="Только просмотр: для изменения нужно право «Управление интеграцией 1С»" />}

      <Table<OnecAlertGroupView>
        rowKey="code"
        size="small"
        pagination={false}
        dataSource={overview.groups}
        scroll={{ x: 900 }}
        columns={[
          {
            title: 'Группа',
            key: 'label',
            render: (_, group) => (
              <Space direction="vertical" size={0}>
                <Text strong>{group.label}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{group.kinds.map((kind) => kind.label).join('; ')}</Text>
              </Space>
            ),
          },
          { title: 'Важность', key: 'importance', width: 130, render: (_, group) => importanceLabel(group.policy.importance) },
          {
            title: 'Кому сейчас',
            key: 'recipients',
            render: (_, group) => (group.recipients ? recipientsSummary(group) : <Tag color="red">Некому доставить</Tag>),
          },
          {
            title: 'Каналы',
            key: 'channels',
            width: 170,
            render: () => (
              <Space size={4} wrap>
                <Tag>Колокольчик</Tag>
                <Tag>Окно с крестиком</Tag>
              </Space>
            ),
          },
          { title: 'Повтор критичных', key: 'repeat', width: 150, render: (_, group) => repeatLabel(group.policy.repeatMinutes) },
          { title: 'О восстановлении', key: 'resolved', width: 120, render: (_, group) => (group.policy.notifyResolved ? 'Сообщать' : 'Нет') },
          {
            title: '',
            key: 'actions',
            width: 210,
            render: (_, group) =>
              canManage ? (
                <Space>
                  <Button size="small" onClick={() => openEditor(group)}>Изменить</Button>
                  <Button size="small" loading={testing === group.code} onClick={() => void sendTest(group)}>Проверить</Button>
                </Space>
              ) : null,
          },
        ]}
      />

      <Typography.Title level={5} style={{ marginBottom: 0 }}>Последние оповещения</Typography.Title>
      <Table<OnecAlertRecentDispatch>
        rowKey="dispatchId"
        size="small"
        dataSource={recent}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        scroll={{ x: 800 }}
        locale={{ emptyText: 'Оповещений ещё не было' }}
        columns={[
          { title: 'Когда', key: 'createdAt', width: 140, render: (_, row) => formatTime(row.createdAt) },
          { title: 'Группа', dataIndex: 'groupLabel', key: 'group' },
          { title: 'Что', key: 'stage', width: 150, render: (_, row) => STAGE_LABELS[row.stage] ?? row.stage },
          {
            title: 'Важность',
            key: 'importance',
            width: 110,
            render: (_, row) => <Tag color={row.importance === 'critical' ? 'red' : row.importance === 'important' ? 'orange' : 'blue'}>{IMPORTANCE_LABELS[row.importance]}</Tag>,
          },
          { title: 'Оповещений', key: 'members', width: 100, render: (_, row) => `${row.members}: ${row.kindLabels.join(', ')}` },
          {
            title: 'Получатели',
            key: 'recipients',
            render: (_, row) =>
              row.recipients.map((recipient) => (
                <Tag key={recipient.userId} color={recipient.shown ? 'green' : undefined}>
                  {recipient.username ?? `#${recipient.userId}`}
                  {recipient.shown ? ' · показано' : ' · ждёт показа'}
                </Tag>
              )),
          },
        ]}
      />

      <Modal
        open={Boolean(editing)}
        title={editing ? `Оповещения 1С: ${editing.label}` : ''}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={saving}
        onOk={() => void save()}
        onCancel={() => setEditing(null)}
        destroyOnClose
      >
        {editing && values && (
          <Form layout="vertical">
            <Form.Item label="Важность" extra="«По оповещению»: критичное — Критично, предупреждение — Важно.">
              <Select
                value={values.importance}
                options={IMPORTANCE_OPTIONS}
                onChange={(importance) => setValues({ ...values, importance })}
              />
            </Form.Item>
            <Form.Item
              label="Роли-получатели"
              extra="Получат только активные пользователи с правом «Просмотр интеграции 1С». Пусто — все с правом «Управление интеграцией 1С»."
            >
              <Select
                mode="multiple"
                allowClear
                value={values.recipientRoleCodes}
                options={overview.recipientOptions.roles.map((role) => ({ value: role.code, label: role.name }))}
                optionFilterProp="label"
                onChange={(recipientRoleCodes) => setValues({ ...values, recipientRoleCodes })}
              />
            </Form.Item>
            <Form.Item label="Пользователи-получатели">
              <Select
                mode="multiple"
                allowClear
                value={values.recipientUserIds}
                options={overview.recipientOptions.users.map((user) => ({ value: user.id, label: user.name }))}
                optionFilterProp="label"
                onChange={(recipientUserIds) => setValues({ ...values, recipientUserIds })}
              />
            </Form.Item>
            <Form.Item label="Каналы">
              <Space direction="vertical" size={2}>
                <Checkbox checked disabled>Колокольчик — всегда</Checkbox>
                <Checkbox checked disabled>Окно, которое закрывается только крестиком — всегда</Checkbox>
                <Checkbox disabled>Telegram — в следующем выпуске</Checkbox>
                <Checkbox disabled>WhatsApp — в следующем выпуске</Checkbox>
              </Space>
            </Form.Item>
            <Form.Item label="Повтор критичных, пока не нажмут «Принять» на экране «Интеграция 1С»">
              <Select
                value={values.repeatMinutes ?? 'none'}
                options={REPEAT_OPTIONS.map((option) => ({ value: option.value ?? 'none', label: option.label }))}
                onChange={(value) => setValues({ ...values, repeatMinutes: value === 'none' ? null : Number(value) })}
              />
            </Form.Item>
            <Form.Item label="Сообщать о восстановлении">
              <Switch checked={values.notifyResolved} onChange={(notifyResolved) => setValues({ ...values, notifyResolved })} />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </Space>
  );
};

export default OnecAlertNotificationsConfig;
