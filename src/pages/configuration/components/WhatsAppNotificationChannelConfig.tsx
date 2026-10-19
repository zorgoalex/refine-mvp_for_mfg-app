import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, DatePicker, Descriptions, Input, Select, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { Table } from '../../../ui/tooltipDelay';
import { whatsappApi } from '../../../api/whatsappApi';
import type {
  WhatsAppNotificationChannelDto,
  WhatsAppNotificationDeliveryDto,
  WhatsAppNotificationJournalQuery,
} from '../../../api/types/whatsappApi.types';
import { whatsappErrorPresentation, type UserFacingError } from './WhatsAppConfigTabs';
import { WhatsAppGroupLabel } from './WhatsAppGroupLabel';
import {
  WHATSAPP_NOTIFICATION_LEVEL_VIEW,
  WHATSAPP_NOTIFICATION_SOURCE_OPTIONS,
  WHATSAPP_NOTIFICATION_STATE_VIEW,
  whatsappNotificationChannelHealth,
  whatsappNotificationReason,
  whatsappNotificationSource,
  whatsappNotificationUserLabel,
} from './whatsappNotificationChannelView';

const { Paragraph, Text, Title } = Typography;

function formatDate(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
}

const Recipient: React.FC<{ item: WhatsAppNotificationDeliveryDto }> = ({ item }) => {
  const recipient = item.recipient;
  if (recipient.kind === 'chat') return <span>Группа: <WhatsAppGroupLabel id={recipient.chatId} /></span>;
  return (
    <span>
      {whatsappNotificationUserLabel(recipient)}
      {recipient.phoneMasked ? <Text type="secondary"> · {recipient.phoneMasked}</Text> : null}
    </span>
  );
};

/** «Конфигурация» → «Уведомления» → «Канал WhatsApp»: состояние канала и журнал доставок (whatsapp.manage). */
export const WhatsAppNotificationChannelConfig: React.FC<{ active?: boolean }> = ({ active = true }) => {
  const [channel, setChannel] = useState<WhatsAppNotificationChannelDto | null>(null);
  const [rows, setRows] = useState<WhatsAppNotificationDeliveryDto[]>([]);
  const [total, setTotal] = useState(0);
  const [totalCapped, setTotalCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<UserFacingError | null>(null);
  const [query, setQuery] = useState<WhatsAppNotificationJournalQuery>({ page: 1, pageSize: 50 });
  const revision = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async (silent = false) => {
    if (silent && inFlight.current) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const current = ++revision.current;
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      const [state, journal] = await Promise.all([
        whatsappApi.notificationChannel({ signal: controller.signal }),
        whatsappApi.notificationDeliveries(query, { signal: controller.signal }),
      ]);
      if (current !== revision.current) return;
      setChannel(state);
      setRows(journal.data);
      setTotal(journal.pagination.total);
      setTotalCapped(journal.pagination.totalCapped);
    } catch (error) {
      if (controller.signal.aborted || current !== revision.current) return;
      setLoadError(whatsappErrorPresentation(error, 'Не удалось загрузить журнал уведомлений WhatsApp'));
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
      if (current === revision.current && !controller.signal.aborted) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    // Another configuration section is open: the panel stays mounted, but nothing is requested.
    if (!active) return undefined;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 30_000);
    return () => {
      window.clearInterval(timer);
      inFlight.current?.abort();
    };
  }, [load, active]);

  const health = channel ? whatsappNotificationChannelHealth(channel) : null;
  const filter = (patch: Partial<WhatsAppNotificationJournalQuery>) => setQuery((current) => ({ ...current, ...patch, page: 1 }));

  return (
    <div className="whatsapp-config">
      <header className="whatsapp-config__header">
        <div>
          <Title level={4}>Канал WhatsApp</Title>
          <Paragraph type="secondary">
            Короткие сообщения сотрудникам и в группы, которые ставят модули ERP (первыми — оповещения 1С). Номера показаны
            маской; текст и адрес стираются через {channel?.limits.purgeAfterDays ?? 30} дней после завершения доставки.
          </Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>Обновить</Button>
      </header>
      {loadError ? (
        <Alert type="error" showIcon message={loadError.title} description={loadError.description}
          action={<Button onClick={() => void load()}>Повторить</Button>} />
      ) : null}
      {channel && health ? (
        <>
          <Alert type={health.tone} showIcon message={health.title} description={health.description} />
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} style={{ marginTop: 12 }}>
            <Descriptions.Item label="В очереди">{channel.queued}</Descriptions.Item>
            <Descriptions.Item label="Последняя отправка (7 дней)">{formatDate(channel.lastSentAt)}</Descriptions.Item>
            <Descriptions.Item label="За сутки">
              <Space size={4} wrap>
                {Object.entries(channel.last24h).length === 0 ? '—' : Object.entries(channel.last24h).map(([state, count]) => {
                  const view = WHATSAPP_NOTIFICATION_STATE_VIEW[state as keyof typeof WHATSAPP_NOTIFICATION_STATE_VIEW];
                  return <Tag key={state} color={view?.color}>{view?.label ?? state}: {count}</Tag>;
                })}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="Ограничения">
              одно сообщение в {channel.limits.globalGapSeconds} с, не больше {channel.limits.perRecipientHourly} в час одному получателю
            </Descriptions.Item>
            <Descriptions.Item label="Запуск сервера">
              {formatDate(channel.epochStartedAt)}
              <Text type="secondary"> · сообщения, поставленные раньше, не отправляются</Text>
            </Descriptions.Item>
          </Descriptions>
        </>
      ) : null}
      <Space wrap className="whatsapp-config__technical-filters" style={{ marginTop: 12 }}>
        <Select allowClear placeholder="Состояние" style={{ width: 170 }} value={query.state}
          options={Object.entries(WHATSAPP_NOTIFICATION_STATE_VIEW).map(([value, view]) => ({ value, label: view.label }))}
          onChange={(state) => filter({ state })} />
        <Select allowClear placeholder="Важность" style={{ width: 160 }} value={query.level}
          options={Object.entries(WHATSAPP_NOTIFICATION_LEVEL_VIEW).map(([value, view]) => ({ value, label: view.label }))}
          onChange={(level) => filter({ level })} />
        <Select allowClear placeholder="Источник" style={{ width: 170 }} value={query.sourceType}
          options={WHATSAPP_NOTIFICATION_SOURCE_OPTIONS} onChange={(sourceType) => filter({ sourceType })} />
        <Select allowClear placeholder="Получатель" style={{ width: 150 }} value={query.recipientKind}
          options={[{ value: 'user', label: 'Сотрудник' }, { value: 'chat', label: 'Группа' }]}
          onChange={(recipientKind) => filter({ recipientKind })} />
        <DatePicker.RangePicker format="DD.MM.YYYY" allowEmpty={[true, true]}
          onChange={(range: [Dayjs | null, Dayjs | null] | null) => filter({
            from: range?.[0]?.format('YYYY-MM-DD') ?? undefined,
            to: range?.[1]?.format('YYYY-MM-DD') ?? undefined,
          })} />
        <Input.Search allowClear placeholder="Заголовок, сотрудник, ключ" style={{ width: 280 }}
          onSearch={(search) => filter({ search: search.trim() || undefined })} />
      </Space>
      <Table<WhatsAppNotificationDeliveryDto>
        rowKey="deliveryId"
        loading={loading}
        dataSource={rows}
        scroll={{ x: 1000 }}
        pagination={{
          current: query.page ?? 1,
          pageSize: query.pageSize ?? 50,
          total,
          showSizeChanger: true,
          pageSizeOptions: [50, 100, 200],
          showTotal: (count) => (totalCapped ? `Больше ${count.toLocaleString('ru-RU')}` : `Всего: ${count}`),
          onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })),
        }}
        expandable={{
          rowExpandable: () => true,
          expandedRowRender: (item) => (
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="Текст">
                {item.text === null ? <Text type="secondary">стёрт {formatDate(item.purgedAt)}</Text>
                  : <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{item.text}</Paragraph>}
              </Descriptions.Item>
              <Descriptions.Item label="Отправить с / до">{formatDate(item.notBefore)} — {formatDate(item.expiresAt)}</Descriptions.Item>
              {item.requiredPermission ? <Descriptions.Item label="Нужное право">{item.requiredPermission}</Descriptions.Item> : null}
              <Descriptions.Item label="Попыток">{item.attempts}</Descriptions.Item>
              <Descriptions.Item label="Источник">{whatsappNotificationSource(item.sourceType)}{item.sourceId ? ` #${item.sourceId}` : ''}</Descriptions.Item>
              <Descriptions.Item label="Ключ"><Text code copyable>{item.idempotencyKey}</Text></Descriptions.Item>
              <Descriptions.Item label="Correlation ID"><Text code copyable>{item.correlationId}</Text></Descriptions.Item>
            </Descriptions>
          ),
        }}
        columns={[
          { title: 'Поставлено', dataIndex: 'createdAt', width: 140, render: formatDate },
          {
            title: 'Состояние', width: 150,
            render: (_: unknown, item) => {
              const view = WHATSAPP_NOTIFICATION_STATE_VIEW[item.state];
              return <Tag color={view?.color}>{view?.label ?? item.state}</Tag>;
            },
          },
          {
            title: 'Важность', dataIndex: 'level', width: 130,
            render: (level: WhatsAppNotificationDeliveryDto['level']) => {
              const view = WHATSAPP_NOTIFICATION_LEVEL_VIEW[level];
              return <Tag color={view?.color}>{view?.label ?? level}</Tag>;
            },
          },
          { title: 'Заголовок', dataIndex: 'title', ellipsis: true, render: (title: string | null) => title ?? '—' },
          { title: 'Кому', width: 260, render: (_: unknown, item) => <Recipient item={item} /> },
          { title: 'Источник', dataIndex: 'sourceType', width: 140, responsive: ['lg'], render: whatsappNotificationSource },
          { title: 'Отправлено', dataIndex: 'sentAt', width: 140, render: formatDate },
          {
            title: 'Причина', dataIndex: 'reason', width: 260, ellipsis: true,
            render: (reason: string | null) => whatsappNotificationReason(reason) ?? '—',
          },
        ]}
      />
    </div>
  );
};
