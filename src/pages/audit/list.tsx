import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Table,
  Form,
  Input,
  InputNumber,
  Button,
  Card,
  Space,
  Typography,
  Tooltip,
  Tag,
  Empty,
  Alert,
} from 'antd';
import {
  FilterOutlined,
  ClearOutlined,
  AuditOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { auditApi } from '../../api/auditApi';
import type { AuditLogEventDto, AuditLogListQuery } from '../../api/types/auditApi.types';
import { ApiError } from '../../api/httpClient';
import { featureFlags } from '../../config/featureFlags';
import { authSession } from '../../api/authSession';
import { can } from '../../utils/permissions';

const { Text } = Typography;

const PAGE_SIZE_DEFAULT = 50;

interface FilterValues {
  event?: string;
  entityType?: string;
  entityId?: string;
  userId?: number;
  source?: string;
  relatedOrderId?: number;
  relatedClientId?: number;
  relatedPaymentId?: number;
  relatedDeadlineId?: number;
  relatedProductionEventId?: number;
  requestId?: string;
  createdFrom?: string;
  createdTo?: string;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return dayjs(value).format('DD.MM.YYYY HH:mm:ss');
}

function JsonCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span style={{ color: '#bfbfbf' }}>—</span>;
  return (
    <pre
      style={{
        margin: 0,
        fontSize: 11,
        maxHeight: 200,
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        background: '#f6f8fa',
        padding: '4px 6px',
        borderRadius: 4,
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function RelatedIds({ record }: { record: AuditLogEventDto }) {
  const parts: React.ReactNode[] = [];
  if (record.relatedOrderId != null)
    parts.push(<Tag key="order" color="blue">Заказ #{record.relatedOrderId}</Tag>);
  if (record.relatedClientId != null)
    parts.push(<Tag key="client" color="geekblue">Клиент #{record.relatedClientId}</Tag>);
  if (record.relatedPaymentId != null)
    parts.push(<Tag key="payment" color="green">Платёж #{record.relatedPaymentId}</Tag>);
  if (record.relatedDeadlineId != null)
    parts.push(<Tag key="deadline" color="orange">Дедлайн #{record.relatedDeadlineId}</Tag>);
  if (record.relatedProductionEventId != null)
    parts.push(<Tag key="prod" color="purple">Произв. #{record.relatedProductionEventId}</Tag>);
  if (parts.length === 0) return <span style={{ color: '#bfbfbf' }}>—</span>;
  return <>{parts}</>;
}

export const AuditList: React.FC = () => {
  const [form] = Form.useForm<FilterValues>();
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [query, setQuery] = useState<AuditLogListQuery>({ page: 1, pageSize: PAGE_SIZE_DEFAULT });
  const [data, setData] = useState<AuditLogEventDto[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: PAGE_SIZE_DEFAULT, total: 0 });
  const [loading, setLoading] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Permission check: audit.view is required when backend permissions are on
  const currentUser = featureFlags.useBackendPermissions ? authSession.getUser() : null;
  const hasPermission =
    !featureFlags.useBackendPermissions || can('audit.view', currentUser);

  const fetchData = useCallback(
    async (q: AuditLogListQuery) => {
      if (!hasPermission) return;

      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setLoading(true);
      setPermissionError(null);

      try {
        const response = await auditApi.list(q);
        setData(response.data);
        setPagination({
          page: response.pagination.page,
          pageSize: response.pagination.pageSize,
          total: response.pagination.total,
        });
      } catch (err) {
        if (err instanceof ApiError && (err.statusCode === 403 || err.statusCode === 401)) {
          setPermissionError('Недостаточно прав для просмотра журнала аудита (audit.view).');
          setData([]);
        } else if (err instanceof Error && err.name !== 'AbortError') {
          setPermissionError(`Ошибка загрузки: ${err.message}`);
          setData([]);
        }
      } finally {
        setLoading(false);
      }
    },
    [hasPermission],
  );

  useEffect(() => {
    void fetchData(query);
  }, [query, fetchData]);

  const handleFilter = (values: FilterValues) => {
    const next: AuditLogListQuery = {
      page: 1,
      pageSize: query.pageSize ?? PAGE_SIZE_DEFAULT,
    };
    if (values.event) next.event = values.event;
    if (values.entityType) next.entityType = values.entityType;
    if (values.entityId) next.entityId = values.entityId;
    if (values.userId != null) next.userId = values.userId;
    if (values.source) next.source = values.source;
    if (values.relatedOrderId != null) next.relatedOrderId = values.relatedOrderId;
    if (values.relatedClientId != null) next.relatedClientId = values.relatedClientId;
    if (values.relatedPaymentId != null) next.relatedPaymentId = values.relatedPaymentId;
    if (values.relatedDeadlineId != null) next.relatedDeadlineId = values.relatedDeadlineId;
    if (values.relatedProductionEventId != null)
      next.relatedProductionEventId = values.relatedProductionEventId;
    if (values.requestId) next.requestId = values.requestId;
    if (values.createdFrom) next.createdFrom = values.createdFrom;
    if (values.createdTo) next.createdTo = values.createdTo;
    setQuery(next);
  };

  const handleClearFilters = () => {
    form.resetFields();
    setQuery({ page: 1, pageSize: query.pageSize ?? PAGE_SIZE_DEFAULT });
  };

  const handleTableChange = (pag: { current?: number; pageSize?: number }) => {
    setQuery((prev) => ({
      ...prev,
      page: pag.current ?? 1,
      pageSize: pag.pageSize ?? PAGE_SIZE_DEFAULT,
    }));
  };

  const expandedRowRender = (record: AuditLogEventDto) => (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 220px', minWidth: 220 }}>
        <Text strong style={{ fontSize: 12 }}>before</Text>
        <JsonCell value={record.before} />
      </div>
      <div style={{ flex: '1 1 220px', minWidth: 220 }}>
        <Text strong style={{ fontSize: 12 }}>after</Text>
        <JsonCell value={record.after} />
      </div>
      <div style={{ flex: '1 1 220px', minWidth: 220 }}>
        <Text strong style={{ fontSize: 12 }}>diff</Text>
        <JsonCell value={record.diff} />
      </div>
      <div style={{ flex: '1 1 220px', minWidth: 220 }}>
        <Text strong style={{ fontSize: 12 }}>metadata</Text>
        <JsonCell value={record.metadata} />
      </div>
    </div>
  );

  if (!hasPermission) {
    return (
      <div style={{ padding: 32 }}>
        <Alert
          type="warning"
          showIcon
          message="Доступ запрещён"
          description="У вас нет разрешения audit.view для просмотра журнала аудита."
        />
      </div>
    );
  }

  return (
    <div style={{ padding: '16px 24px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <Space>
          <AuditOutlined style={{ fontSize: 18, color: '#1677ff' }} />
          <Text strong style={{ fontSize: 16 }}>
            Журнал аудита
          </Text>
        </Space>
        <Button
          type={filtersVisible ? 'primary' : 'default'}
          icon={<FilterOutlined />}
          onClick={() => setFiltersVisible((v) => !v)}
          size="small"
        >
          {filtersVisible ? 'Скрыть фильтры' : 'Фильтры'}
        </Button>
      </div>

      {permissionError && (
        <Alert
          type="error"
          showIcon
          message={permissionError}
          style={{ marginBottom: 12 }}
        />
      )}

      {filtersVisible && (
        <Card
          size="small"
          style={{ marginBottom: 12 }}
          bodyStyle={{ padding: '8px 12px' }}
        >
          <style>{`
            .audit-filters .ant-form-item { margin-bottom: 6px; }
            .audit-filters .ant-form-item-label > label { font-size: 11px; }
            .audit-filters-grid { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-end; }
            .audit-filters-grid > .aff-item { flex-shrink: 0; }
          `}</style>
          <Form
            form={form}
            layout="vertical"
            onFinish={handleFilter}
            className="audit-filters"
          >
            <div className="audit-filters-grid">
              <div className="aff-item">
                <Form.Item name="event" label="Событие">
                  <Input allowClear placeholder="ORDER_CREATED..." size="small" style={{ width: 160 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="entityType" label="Тип сущности">
                  <Input allowClear placeholder="order..." size="small" style={{ width: 110 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="entityId" label="ID сущности">
                  <Input allowClear placeholder="42" size="small" style={{ width: 80 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="userId" label="ID пользователя">
                  <InputNumber min={1} placeholder="7" size="small" style={{ width: 90 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="source" label="Источник">
                  <Input allowClear placeholder="backend" size="small" style={{ width: 100 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedOrderId" label="Заказ #">
                  <InputNumber min={1} placeholder="ID" size="small" style={{ width: 80 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedClientId" label="Клиент #">
                  <InputNumber min={1} placeholder="ID" size="small" style={{ width: 80 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedPaymentId" label="Платёж #">
                  <InputNumber min={1} placeholder="ID" size="small" style={{ width: 80 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedDeadlineId" label="Дедлайн #">
                  <InputNumber min={1} placeholder="ID" size="small" style={{ width: 80 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedProductionEventId" label="Произв. событие #">
                  <InputNumber min={1} placeholder="ID" size="small" style={{ width: 90 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="requestId" label="Request ID">
                  <Input allowClear placeholder="uuid..." size="small" style={{ width: 140 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="createdFrom" label="Дата с (ISO)">
                  <Input allowClear placeholder="2026-01-01T00:00:00Z" size="small" style={{ width: 180 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="createdTo" label="Дата по (ISO)">
                  <Input allowClear placeholder="2026-12-31T23:59:59Z" size="small" style={{ width: 180 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item label=" " colon={false}>
                  <Space size="small">
                    <Button type="primary" htmlType="submit" icon={<FilterOutlined />} size="small">
                      Применить
                    </Button>
                    <Button onClick={handleClearFilters} icon={<ClearOutlined />} size="small">
                      Сбросить
                    </Button>
                  </Space>
                </Form.Item>
              </div>
            </div>
          </Form>
        </Card>
      )}

      <Table<AuditLogEventDto>
        rowKey="auditId"
        loading={loading}
        dataSource={data}
        size="small"
        sticky
        scroll={{ x: 'max-content', y: 600 }}
        pagination={{
          current: pagination.page,
          pageSize: pagination.pageSize,
          total: pagination.total,
          pageSizeOptions: ['20', '50', '100', '200'],
          showSizeChanger: true,
          showTotal: (total) => `Всего: ${total}`,
        }}
        onChange={(pag) => handleTableChange(pag)}
        expandable={{
          expandedRowRender,
          rowExpandable: (record) =>
            record.before !== null ||
            record.after !== null ||
            record.diff !== null ||
            record.metadata !== null,
        }}
        locale={{ emptyText: <Empty description="Нет записей аудита" /> }}
      >
        <Table.Column<AuditLogEventDto>
          dataIndex="createdAt"
          title="Дата/время"
          width={150}
          render={(value) => formatDateTime(value)}
        />
        <Table.Column<AuditLogEventDto>
          dataIndex="event"
          title="Событие"
          width={180}
          ellipsis
          render={(value: string) => <Tag color="blue">{value}</Tag>}
        />
        <Table.Column<AuditLogEventDto>
          title="Актор"
          width={140}
          render={(_, record) => {
            if (!record.username) return <span style={{ color: '#bfbfbf' }}>—</span>;
            return (
              <div>
                <div>{record.username}</div>
                {record.role && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {record.role}
                  </Text>
                )}
              </div>
            );
          }}
        />
        <Table.Column<AuditLogEventDto>
          title="Сущность"
          width={130}
          render={(_, record) => (
            <div>
              <Text style={{ fontSize: 12 }}>{record.entityType ?? <span style={{ color: '#bfbfbf' }}>—</span>}</Text>
              {record.entityId && (
                <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                  #{record.entityId}
                </Text>
              )}
            </div>
          )}
        />
        <Table.Column<AuditLogEventDto>
          title="Связанные объекты"
          width={220}
          render={(_, record) => <RelatedIds record={record} />}
        />
        <Table.Column<AuditLogEventDto>
          dataIndex="source"
          title="Источник"
          width={90}
          render={(value: string | null) => value ?? <span style={{ color: '#bfbfbf' }}>—</span>}
        />
        <Table.Column<AuditLogEventDto>
          dataIndex="requestId"
          title="Request ID"
          width={130}
          ellipsis
          render={(value: string) =>
            value ? (
              <Tooltip title={value}>
                <Text code style={{ fontSize: 11 }}>
                  {value.slice(0, 8)}…
                </Text>
              </Tooltip>
            ) : (
              <span style={{ color: '#bfbfbf' }}>—</span>
            )
          }
        />
      </Table>
    </div>
  );
};
