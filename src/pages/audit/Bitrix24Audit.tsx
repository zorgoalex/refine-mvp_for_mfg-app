import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import { auditApi } from '../../api/auditApi';
import type {
  AuditLogEventDto,
  AuditLogListQuery,
  BitrixAuditStatus,
  BitrixQueueResponse,
  BitrixQueueRow,
} from '../../api/types/auditApi.types';
import { authSession } from '../../api/authSession';
import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';

const directions = {
  forward: 'ERP → Bitrix24',
  reverse: 'Bitrix24 → ERP',
  widget: 'Виджет оплаты',
  settings: 'Настройки',
  other: 'Прочее',
};
const outcomes = {
  success: 'Завершено',
  error: 'Ошибка',
  conflict: 'Конфликт',
  started: 'Начато / ожидает',
  skipped: 'Пропущено',
  unknown: 'Не указан',
};
const categories = {
  client: 'Клиенты',
  order: 'Сделки и заказы',
  payment: 'Платежи',
  settings: 'Настройки',
  processing: 'Обработка',
  other: 'Прочее',
};
const statuses = {
  pending: 'Ожидает',
  processing: 'Обрабатывается',
  processed: 'Обработано',
  failed: 'Ошибка',
  dead: 'Остановлено',
};
const objects = {
  contact: 'Контакт',
  company: 'Компания',
  deal: 'Сделка',
  payment: 'Платёж',
};
const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString('ru-RU') : 'Нет данных';
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Не удалось загрузить журнал';
const label = (labels: Record<string, string>, key?: string | null) =>
  key ? labels[key] ?? key : '—';

interface Filters
  extends Pick<
    AuditLogListQuery,
    | 'events'
    | 'bitrixDirection'
    | 'bitrixCategory'
    | 'bitrixOutcome'
    | 'bitrixReconcile'
    | 'bitrixObject'
    | 'bitrixId'
    | 'requestId'
    | 'entityType'
    | 'entityId'
    | 'userId'
    | 'source'
  > {
  orderId?: number;
  range?: [Dayjs, Dayjs];
  status?: string;
}
export function bitrixAuditQuery(
  filters: Filters,
  page: number,
  pageSize: number
): AuditLogListQuery {
  const { range, orderId, status: _status, ...rest } = filters;
  return {
    ...rest,
    scope: 'bitrix24',
    page,
    pageSize,
    orderIds: orderId ? [orderId] : undefined,
    createdFrom: range?.[0]?.toISOString(),
    createdTo: range?.[1]?.toISOString(),
  };
}

export function AuditOrderLookup({
  value,
  onChange,
}: {
  value?: number;
  onChange?: (value?: number) => void;
}) {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Array<{ value: number; label: string }>>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(false);
      void auditApi
        .orderOptions({ search, ids: value ? [value] : [], limit: 50 })
        .then((response) => {
          if (live)
            setRows(
              response.data.map((r) => ({
                value: r.orderId,
                label: `Заказ №${r.orderName} · ID ${r.orderId}`,
              }))
            );
        })
        .catch(() => {
          if (live) {
            setRows([]);
            setError(true);
          }
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [search, value]);
  const choices = [...rows];
  for (const id of [
    value,
    /^[1-9][0-9]*$/.test(search) ? Number(search) : undefined,
  ]) {
    if (id && Number.isSafeInteger(id) && !choices.some((r) => r.value === id))
      choices.push({ value: id, label: `Точный ID заказа: ${id}` });
  }
  return (
    <div>
      <Select
        aria-label="Заказ: номер или ID"
        allowClear
        showSearch
        filterOption={false}
        loading={loading}
        value={value}
        onChange={onChange}
        onSearch={setSearch}
        options={choices}
        placeholder="Номер / название / ID"
        style={{ minWidth: 250, width: '100%' }}
      />
      {error && (
        <Typography.Text type="danger">
          Ошибка поиска. Точный ID можно ввести вручную.
        </Typography.Text>
      )}
    </div>
  );
}

function EventLookup({
  value,
  onChange,
}: {
  value?: string[];
  onChange?: (value: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Array<{ value: string; label: string }>>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void auditApi
        .bitrixEvents(search)
        .then((r) => {
          if (live) {
            setRows(
              r.data.map((item) => ({
                value: item.event,
                label: `${item.label} · ${item.event}`,
              }))
            );
            setError(false);
          }
        })
        .catch(() => {
          if (live) setError(true);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [search]);
  return (
    <div>
      <Select
        aria-label="События Bitrix"
        mode="tags"
        allowClear
        value={value}
        onChange={onChange}
        onSearch={setSearch}
        filterOption={false}
        options={rows}
        style={{ minWidth: 280, width: '100%' }}
        placeholder="Выбрать или ввести точное событие"
      />
      {error && (
        <Typography.Text type="danger">
          Не загружен справочник событий
        </Typography.Text>
      )}
    </div>
  );
}

export function Bitrix24Audit() {
  const user = featureFlags.useBackendPermissions
    ? authSession.getUser()
    : null;
  const allowed =
    !featureFlags.useBackendPermissions || can('audit.view', user);
  const [mode, setMode] = useState('events');
  const [form] = Form.useForm<Filters>();
  const [filters, setFilters] = useState<Filters>({});
  const [queueDirection, setQueueDirection] = useState<'forward' | 'reverse'>(
    'forward'
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [revision, setRevision] = useState(0);
  const [health, setHealth] = useState<BitrixAuditStatus | null>(null);
  const [healthError, setHealthError] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<AuditLogEventDto[]>([]);
  const [queue, setQueue] = useState<BitrixQueueResponse['data']>([]);
  const [total, setTotal] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    setHealthError('');
    void auditApi
      .bitrixStatus()
      .then((result) => {
        if (live) setHealth(result);
      })
      .catch((err) => {
        if (live) {
          setHealth(null);
          setHealthError(message(err));
        }
      });
    return () => {
      live = false;
    };
  }, [allowed, revision]);
  useEffect(() => {
    if (!allowed) return;
    const seq = ++request.current;
    setLoading(true);
    setError('');
    const run = async () => {
      try {
        if (mode === 'events') {
          const result = await auditApi.list(
            bitrixAuditQuery(filters, page, pageSize)
          );
          if (request.current === seq) {
            setEvents(result.data);
            setTotal(result.pagination.total);
          }
        } else {
          const result = await auditApi.bitrixQueue({
            direction: queueDirection,
            page,
            pageSize,
            status: filters.status,
            orderId: filters.orderId,
            entityType: filters.entityType,
            entityId: filters.entityId,
            bitrixObject: filters.bitrixObject,
            bitrixId: filters.bitrixId,
          });
          if (request.current === seq) {
            setQueue(result.data);
            setTotal(result.pagination.total);
          }
        }
      } catch (err) {
        if (request.current === seq) {
          setError(message(err));
          setEvents([]);
          setQueue([]);
          setTotal(0);
        }
      } finally {
        if (request.current === seq) setLoading(false);
      }
    };
    void run();
    return () => {
      request.current++;
    };
  }, [allowed, mode, filters, queueDirection, page, pageSize, revision]);
  if (!allowed)
    return <Alert type="error" message="Требуется право audit.view" />;
  const pagination = {
    current: page,
    pageSize,
    total,
    showSizeChanger: true,
    showTotal: (n: number) => `Всего: ${n}`,
  };
  const pageChange = (p: { current?: number; pageSize?: number }) => {
    setPage(p.pageSize !== pageSize ? 1 : p.current ?? 1);
    setPageSize(p.pageSize ?? pageSize);
  };
  const reset = () => {
    form.resetFields();
    setFilters({});
    setPage(1);
  };
  return (
    <Space
      direction="vertical"
      style={{ width: '100%', fontVariantNumeric: 'tabular-nums' }}
      size="middle"
    >
      <Space wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Bitrix24
        </Typography.Title>
        <Button
          onClick={() => setRevision((v) => v + 1)}
          style={{ minHeight: 40 }}
        >
          Обновить
        </Button>
        <Typography.Text type="secondary">
          Часовой пояс: {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </Typography.Text>
      </Space>
      {healthError && (
        <Alert
          type="error"
          message={`Состояние синхронизации недоступно: ${healthError}`}
        />
      )}
      <Space wrap align="start">
        {health?.data.map((h) => (
          <Card
            key={h.direction}
            size="small"
            title={directions[h.direction]}
            style={{ minWidth: 290 }}
          >
            <div>
              {!h.enabled
                ? 'Выключена'
                : h.dryRun
                ? 'Проверочный режим, без записи'
                : h.owner === 'none'
                ? 'Обработчик не назначен'
                : h.owner === 'external'
                ? 'Внешний обработчик; процесс не подтверждён'
                : 'Обработчик назначен внутри backend'}
            </div>
            <Typography.Text type="secondary">
              owner={h.owner} · enabled={String(h.enabled)} · dryRun=
              {String(h.dryRun)}
            </Typography.Text>
            <div>
              Ожидают: {h.pending} · В работе: {h.processing} · Ошибки:{' '}
              {h.failed} · Остановлены: {h.dead}
            </div>
            <div>
              Ожидание с: {date(h.oldestPendingAt)}
              {h.oldestPendingAt
                ? ` (${Math.max(
                    0,
                    Math.floor(
                      (Date.parse(health.fetchedAt) -
                        Date.parse(h.oldestPendingAt)) /
                        60000
                    )
                  )} мин.)`
                : ''}
            </div>
            <div>Последняя обработка: {date(h.lastProcessedAt)}</div>
          </Card>
        ))}
      </Space>
      <Typography.Text type="secondary">
        Состояние на {date(health?.fetchedAt)}. Назначенный обработчик не
        доказывает, что он сейчас работает. Очередь — текущее состояние; события
        — сохранённая история.
      </Typography.Text>
      <Tabs
        activeKey={mode}
        onChange={(key) => {
          setMode(key);
          reset();
        }}
        items={[
          { key: 'events', label: 'События' },
          { key: 'queue', label: 'Очереди' },
        ]}
      />
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          setFilters(values);
          setPage(1);
        }}
      >
        <Space wrap align="start">
          <Form.Item name="orderId" label="Заказ ERP">
            <AuditOrderLookup />
          </Form.Item>
          {mode === 'events' ? (
            <>
              <Form.Item name="range" label="Период">
                <DatePicker.RangePicker showTime />
              </Form.Item>
              <Form.Item name="bitrixDirection" label="Направление">
                <Select
                  allowClear
                  options={options(directions)}
                  style={{ width: 180 }}
                />
              </Form.Item>
              <Form.Item name="bitrixCategory" label="Группа">
                <Select
                  allowClear
                  options={options(categories)}
                  style={{ width: 180 }}
                />
              </Form.Item>
              <Form.Item name="bitrixOutcome" label="Результат">
                <Select
                  allowClear
                  options={options({
                    attention: 'Ошибки и конфликты',
                    ...outcomes,
                  })}
                  style={{ width: 200 }}
                />
              </Form.Item>
              <Form.Item name="bitrixReconcile" label="Сверки платежей">
                <Select
                  allowClear
                  placeholder="Все события"
                  options={[
                    { value: 'exclude', label: 'Без фоновых сверок' },
                    { value: 'only', label: 'Только сверки' },
                  ]}
                  style={{ width: 220 }}
                />
              </Form.Item>
              <Form.Item name="events" label="Событие">
                <EventLookup />
              </Form.Item>
              <Form.Item name="requestId" label="Request / correlation ID">
                <Input allowClear />
              </Form.Item>
              <Form.Item name="userId" label="ID исполнителя ERP">
                <InputNumber min={1} precision={0} />
              </Form.Item>
              <Form.Item name="source" label="Точный источник">
                <Input allowClear />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item label="Направление очереди">
                <Select
                  value={queueDirection}
                  onChange={(value) => {
                    setQueueDirection(value);
                    setPage(1);
                  }}
                  options={options({
                    forward: directions.forward,
                    reverse: directions.reverse,
                  })}
                  style={{ width: 180 }}
                />
              </Form.Item>
              <Form.Item name="status" label="Статус">
                <Select
                  allowClear
                  options={options(statuses)}
                  style={{ width: 180 }}
                />
              </Form.Item>
            </>
          )}
          <Form.Item name="entityType" label="Тип объекта ERP">
            <Select
              allowClear
              options={options({
                order: 'Заказ',
                client: 'Клиент',
                payment: 'Платёж',
              })}
              style={{ width: 150 }}
            />
          </Form.Item>
          <Form.Item name="entityId" label="ID объекта ERP">
            <Input allowClear />
          </Form.Item>
          <Form.Item name="bitrixObject" label="Тип объекта Bitrix">
            <Select
              allowClear
              options={options(objects)}
              style={{ width: 160 }}
            />
          </Form.Item>
          <Form.Item name="bitrixId" label="ID объекта Bitrix">
            <Input allowClear />
          </Form.Item>
        </Space>
        <Space>
          <Button htmlType="submit" type="primary" style={{ minHeight: 40 }}>
            Применить
          </Button>
          <Button onClick={reset} style={{ minHeight: 40 }}>
            Сбросить
          </Button>
        </Space>
      </Form>
      {error && <Alert type="error" message={error} />}
      {mode === 'events' ? (
        <Table<AuditLogEventDto>
          rowKey="auditId"
          dataSource={events}
          loading={loading}
          pagination={pagination}
          onChange={pageChange}
          scroll={{ x: 1300 }}
          locale={{
            emptyText:
              'Нет записанных событий по выбранным фильтрам. Неотправленные заказы проверьте в очередях.',
          }}
          expandable={{
            expandedRowRender: (row) => (
              <div>
                <Typography.Paragraph copyable>
                  {row.requestId}
                </Typography.Paragraph>
                <pre
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {JSON.stringify(
                    {
                      before: row.before,
                      after: row.after,
                      diff: row.diff,
                      metadata: row.metadata,
                      relatedEntities: row.relatedEntities,
                    },
                    null,
                    2
                  )}
                </pre>
              </div>
            ),
          }}
          columns={[
            {
              title: 'Когда',
              dataIndex: 'createdAt',
              render: date,
              width: 180,
            },
            {
              title: 'Направление',
              render: (_, r) => label(directions, r.bitrix?.direction),
            },
            {
              title: 'Событие',
              render: (_, r) => (
                <div>
                  {r.bitrix?.label ?? r.event}
                  <br />
                  <Typography.Text type="secondary">{r.event}</Typography.Text>
                </div>
              ),
            },
            {
              title: 'Результат',
              render: (_, r) => (
                <Tag
                  color={
                    ['error', 'conflict'].includes(r.bitrix?.outcome ?? '')
                      ? 'red'
                      : undefined
                  }
                >
                  {label(outcomes, r.bitrix?.outcome)}
                </Tag>
              ),
            },
            {
              title: 'Заказ ERP',
              render: (_, r) =>
                r.relatedOrderId
                  ? `№${r.relatedOrderName ?? '—'} · ID ${r.relatedOrderId}`
                  : r.entityType === 'order'
                  ? `№${r.entityName ?? '—'} · ID ${r.entityId}`
                  : r.bitrix?.currentRequestOrderId
                  ? `ID ${r.bitrix.currentRequestOrderId} (текущая связь)`
                  : '—',
            },
            {
              title: 'Объекты',
              render: (_, r) => (
                <div>
                  {r.entityType} {r.entityId}
                  <br />
                  {r.bitrix?.refs.map((ref) => (
                    <div key={`${ref.type}:${ref.id}`}>
                      {label(objects, ref.type)} Bitrix #{ref.id}
                      {ref.identitySource !== 'event' ? ' (текущая связь)' : ''}
                    </div>
                  ))}
                </div>
              ),
            },
            {
              title: 'Исполнитель',
              render: (_, r) =>
                r.username ??
                (r.userId ? `ERP #${r.userId}` : 'Системное действие'),
            },
            {
              title: 'Ошибка',
              render: (_, r) => {
                const m = r.metadata;
                return m && typeof m === 'object' && 'error' in m
                  ? String(m.error)
                  : '—';
              },
            },
          ]}
        />
      ) : (
        <Table<BitrixQueueRow>
          rowKey="id"
          dataSource={queue}
          loading={loading}
          pagination={pagination}
          onChange={pageChange}
          scroll={{ x: 1500 }}
          locale={{ emptyText: 'Нет заданий по выбранным фильтрам' }}
          columns={[
            { title: 'Поставлено', dataIndex: 'createdAt', render: date },
            {
              title: 'Событие / ID задания',
              render: (_, r) => (
                <div>
                  {r.event}
                  <br />
                  <Typography.Text copyable>{r.queueId}</Typography.Text>
                </div>
              ),
            },
            {
              title: 'Заказ ERP',
              render: (_, r) =>
                r.orderId ? `№${r.orderName ?? '—'} · ID ${r.orderId}` : '—',
            },
            {
              title: 'Объекты',
              render: (_, r) => (
                <div>
                  {r.entityType} {r.entityId}
                  <br />
                  {label(objects, r.bitrixObject)}{' '}
                  {r.bitrixId ?? 'Без связи Bitrix'}
                </div>
              ),
            },
            { title: 'Статус', render: (_, r) => label(statuses, r.status) },
            { title: 'Попытки', dataIndex: 'attempts' },
            { title: 'Обработано', dataIndex: 'processedAt', render: date },
            {
              title: 'Следующая попытка',
              dataIndex: 'nextAttemptAt',
              render: date,
            },
            {
              title: 'Ошибка',
              render: (_, r) => (
                <div>
                  {r.error ?? 'Не сохранена'}
                  {r.errorSource === 'current_mapping' && (
                    <div>
                      <Typography.Text type="secondary">
                        Последняя ошибка связанного объекта, не обязательно
                        этого задания
                      </Typography.Text>
                    </div>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}
    </Space>
  );
}
