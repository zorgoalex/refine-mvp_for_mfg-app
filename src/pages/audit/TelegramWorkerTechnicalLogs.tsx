import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, DatePicker, Empty, Form, Input, Select, Space, Tag, Typography, message } from 'antd';
import { Table } from '../../ui/tooltipDelay';
import { CopyOutlined, DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { cncTelegramApi } from '../../api/cncTelegramApi';
import { ApiError } from '../../api/httpClient';
import type { TelegramWorkerTechnicalLog, TelegramWorkerTechnicalLogQuery } from '../../api/types/cncTelegramWorkerAudit.types';
import { can } from '../../utils/permissions';

const { Text } = Typography;

interface Filters {
  period?: [Dayjs, Dayjs];
  stream?: 'stdout' | 'stderr';
  workerInstanceId?: string;
  search?: string;
}

export const TelegramWorkerTechnicalLogs: React.FC = () => {
  const allowed = can('audit.technical.view');
  const [form] = Form.useForm<Filters>();
  const [query, setQuery] = useState<TelegramWorkerTechnicalLogQuery>(() => buildQuery({}));
  const [rows, setRows] = useState<TelegramWorkerTechnicalLog[]>([]);
  const [health, setHealth] = useState({ latestLineAt: null as string | null, latestHeartbeatAt: null as string | null, droppedLines: 0 });
  const [pagination, setPagination] = useState({ page: 1, pageSize: 100, total: 0 });
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true); setError(null);
    try {
      const response = await cncTelegramApi.workerTechnicalLogs(query);
      setRows(response.data); setHealth(response.health); setPagination(response.pagination);
    } catch (caught) {
      setRows([]);
      setError(errorText(caught, 'Не удалось загрузить технические логи.'));
    } finally { setLoading(false); }
  }, [allowed, query]);

  useEffect(() => { void load(); }, [load]);
  if (!allowed) return null;

  const heartbeatStale = !health.latestHeartbeatAt || dayjs().diff(dayjs(health.latestHeartbeatAt), 'second') > 90;
  const exportLogs = async () => {
    setExporting(true); setError(null);
    try {
      const current = buildQuery(form.getFieldsValue());
      const result = await cncTelegramApi.exportWorkerTechnicalLogs({
        dateFrom: current.dateFrom, dateTo: current.dateTo, stream: current.stream,
        workerInstanceId: current.workerInstanceId, search: current.search,
      });
      saveBlob(result.blob, result.fileName ?? `telegram-worker-technical_${current.dateFrom}_${current.dateTo}.log`);
      message.success('Raw technical log выгружен');
    } catch (caught) { setError(errorText(caught, 'Не удалось выгрузить технические логи.')); }
    finally { setExporting(false); }
  };

  return (
    <Card title={<span style={{ textWrap: 'balance' }}>Raw technical logs · stdout / stderr</span>} style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 2px 4px rgba(0,0,0,.04)' }}>
      <style>{`.tg-technical-controls .ant-input, .tg-technical-controls .ant-select-selector, .tg-technical-controls .ant-picker, .tg-technical-controls .ant-btn { min-height: 40px !important; } .tg-technical-log-line { max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }`}</style>
      <Alert
        type={heartbeatStale ? 'error' : 'success'} showIcon style={{ marginBottom: 12 }}
        message={heartbeatStale ? 'Heartbeat worker отсутствует больше 90 секунд' : `Worker жив · heartbeat ${formatDateTime(health.latestHeartbeatAt)}`}
        description={`Последняя строка: ${formatDateTime(health.latestLineAt)} · потеряно при переполнении: ${health.droppedLines}`}
      />
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Form form={form} layout="inline" className="tg-technical-controls" initialValues={{ period: [dayjs().subtract(1, 'day'), dayjs()] }} onFinish={(values) => setQuery(buildQuery(values, pagination.pageSize))} style={{ marginBottom: 12 }}>
        <Form.Item name="period"><DatePicker.RangePicker allowClear={false} /></Form.Item>
        <Form.Item name="stream"><Select allowClear placeholder="Поток" style={{ width: 120 }} options={[{ value: 'stdout', label: 'stdout' }, { value: 'stderr', label: 'stderr' }]} /></Form.Item>
        <Form.Item name="workerInstanceId"><Input allowClear placeholder="Worker instance UUID" style={{ width: 260 }} /></Form.Item>
        <Form.Item name="search"><Input allowClear prefix={<SearchOutlined />} placeholder="Текст raw-лога" style={{ width: 220 }} /></Form.Item>
        <Form.Item><Space wrap><Button type="primary" htmlType="submit">Показать</Button><Button icon={<ReloadOutlined />} onClick={() => void load()}>Обновить</Button><Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportLogs()}>Выгрузить .log</Button></Space></Form.Item>
      </Form>
      <Table<TelegramWorkerTechnicalLog>
        rowKey="logId" size="small" loading={loading} dataSource={rows} scroll={{ x: 1100 }}
        locale={{ emptyText: <Empty description="Raw-строк за период нет" /> }}
        pagination={{ current: pagination.page, pageSize: pagination.pageSize, total: pagination.total, showSizeChanger: true }}
        onChange={(next) => setQuery((current) => ({ ...current, page: next.current ?? 1, pageSize: next.pageSize ?? 100 }))}
      >
        <Table.Column<TelegramWorkerTechnicalLog> dataIndex="observedAt" title="Когда" width={160} render={(value) => <Text className="tg-audit-num">{formatDateTime(value)}</Text>} />
        <Table.Column<TelegramWorkerTechnicalLog> dataIndex="stream" title="Поток" width={90} render={(value) => <Tag color={value === 'stderr' ? 'red' : 'blue'}>{value}</Tag>} />
        <Table.Column<TelegramWorkerTechnicalLog> title="Instance / seq" width={300} render={(_, row) => <Text code>{row.workerInstanceId} #{row.sequence}</Text>} />
        <Table.Column<TelegramWorkerTechnicalLog> dataIndex="message" title="Raw строка" render={(value, row) => <Space direction="vertical" size={2} style={{ width: '100%' }}><Text code className="tg-technical-log-line">{value}</Text><Space>{row.redacted && <Tag color="orange">redacted</Tag>}{row.truncated && <Tag color="gold">truncated</Tag>}{row.droppedBefore > 0 && <Tag color="red">dropped before: {row.droppedBefore}</Tag>}</Space></Space>} />
        <Table.Column<TelegramWorkerTechnicalLog> title="" width={56} render={(_, row) => <Button aria-label="Копировать raw-строку" icon={<CopyOutlined />} onClick={() => void copyLine(row)} />} />
      </Table>
    </Card>
  );
};

function buildQuery(values: Filters, pageSize = 100): TelegramWorkerTechnicalLogQuery {
  const period = values.period ?? [dayjs().subtract(1, 'day'), dayjs()];
  return { dateFrom: period[0].format('YYYY-MM-DD'), dateTo: period[1].format('YYYY-MM-DD'), page: 1, pageSize, stream: values.stream, workerInstanceId: values.workerInstanceId?.trim() || undefined, search: values.search?.trim() || undefined };
}

function formatDateTime(value: string | null): string { return value ? dayjs(value).format('DD.MM.YYYY HH:mm:ss') : '—'; }
function errorText(caught: unknown, fallback: string): string { return caught instanceof ApiError && caught.statusCode === 403 ? 'Нет права audit.technical.view.' : caught instanceof Error ? caught.message : fallback; }
async function copyLine(row: TelegramWorkerTechnicalLog): Promise<void> {
  try {
    await navigator.clipboard.writeText(`${row.observedAt} ${row.stream.toUpperCase()} ${row.workerInstanceId}#${row.sequence} ${row.message}`);
    message.success('Raw-строка скопирована');
  } catch {
    message.error('Браузер не разрешил копирование');
  }
}
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
