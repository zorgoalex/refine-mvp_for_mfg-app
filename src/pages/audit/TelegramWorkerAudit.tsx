import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, DatePicker, Descriptions, Empty, Form, Input, message, Row, Select, Space, Statistic, Table, Tag, Timeline, Tooltip, Typography } from 'antd';
import { DownloadOutlined, ReloadOutlined, RobotOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { cncTelegramApi } from '../../api/cncTelegramApi';
import type { TelegramWorkerAuditExportQuery, TelegramWorkerAuditQuery, TelegramWorkerMessageLog, TelegramWorkerMessageStatus, TelegramWorkerMessageType, TelegramWorkerOperation, TelegramWorkerScan } from '../../api/types/cncTelegramWorkerAudit.types';
import { ApiError } from '../../api/httpClient';

const { Text } = Typography;
const STATUS_LABELS: Record<string, string> = {
  observed: 'Прочитано', used: 'Использовано', ingested: 'Создано в ERP', skipped: 'Пропущено', failed: 'Ошибка',
  running: 'Выполняется', completed: 'Завершено', abandoned: 'Прервано', succeeded: 'Успешно', planned: 'Запланировано',
  reconciled: 'Найден после рестарта', ambiguous: 'Неоднозначно', incomplete: 'Не доказано',
};
const TYPE_LABELS: Record<string, string> = { svg: 'SVG', dxf: 'DXF', image: 'Изображение', gcode: 'G-code', bot_reply: 'Ответ', text: 'Текст', other: 'Файл' };
const STATUS_COLORS: Record<string, string> = { ingested: 'green', used: 'blue', skipped: 'gold', failed: 'red', abandoned: 'volcano', completed: 'green', running: 'processing', succeeded: 'green', planned: 'processing', reconciled: 'green', ambiguous: 'volcano', incomplete: 'red' };
export const TELEGRAM_WORKER_EXPECTED_POLL_INTERVAL_SECONDS = 60;

interface FilterValues {
  period?: [Dayjs, Dayjs];
  status?: TelegramWorkerMessageStatus;
  messageType?: TelegramWorkerMessageType;
  reasonCode?: string;
  search?: string;
}

export function buildTelegramWorkerAuditQuery(values: FilterValues, pageSize = 50): TelegramWorkerAuditQuery {
  const period = values.period ?? [dayjs().subtract(6, 'day'), dayjs()];
  return {
    dateFrom: period[0].format('YYYY-MM-DD'), dateTo: period[1].format('YYYY-MM-DD'),
    page: 1, pageSize, status: values.status, messageType: values.messageType,
    reasonCode: values.reasonCode?.trim() || undefined, search: values.search?.trim() || undefined,
  };
}

export function buildTelegramWorkerAuditExportQuery(values: FilterValues): TelegramWorkerAuditExportQuery {
  const query = buildTelegramWorkerAuditQuery(values);
  return {
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    status: query.status,
    messageType: query.messageType,
    reasonCode: query.reasonCode,
    search: query.search,
  };
}

export function isTelegramWorkerScanStale(
  scan: TelegramWorkerScan,
  now = dayjs(),
  pollIntervalSeconds = TELEGRAM_WORKER_EXPECTED_POLL_INTERVAL_SECONDS,
): boolean {
  const startedAt = dayjs(scan.startedAt);
  return scan.status === 'running'
    && startedAt.isValid()
    && now.diff(startedAt, 'second') > pollIntervalSeconds * 2;
}

function formatDateTime(value: string | null | undefined): string {
  return value ? dayjs(value).format('DD.MM.YYYY HH:mm:ss') : '—';
}

function ScanCard({ scan, now }: { scan: TelegramWorkerScan; now: Dayjs }) {
  const stale = isTelegramWorkerScanStale(scan, now);
  const warning = stale || scan.status !== 'completed' || scan.dayTruncated || scan.replySearchTruncated || scan.dayErrorCode || scan.replySearchErrorCode;
  return (
    <Card size="small" style={{ minWidth: 310, borderColor: warning ? '#ffccc7' : undefined }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Space wrap>
          <Tag color={stale ? 'red' : STATUS_COLORS[scan.status]}>{stale ? 'Нет завершения' : STATUS_LABELS[scan.status] ?? scan.status}</Tag>
          <Text strong>{formatDateTime(scan.startedAt)}</Text>
          <Text type="secondary" className="tg-audit-num">Сессия Telegram #{scan.sessionUserId ?? '—'}</Text>
        </Space>
        <Text className="tg-audit-num">История: {scan.dayYieldedCount} · SVG: {scan.svgCount} · ERP: {scan.ingestedCount} · Ошибок: {scan.failedCount}</Text>
        <Text className="tg-audit-num" type={scan.replySearchTruncated || scan.replySearchErrorCode ? 'danger' : 'secondary'}>
          Поиск ответов: {scan.replySearchYieldedCount} · {scan.replySearchExhausted ? 'полностью' : scan.replySearchTruncated ? 'лимит' : 'не завершён'}
        </Text>
        <Text type="secondary">Worker {scan.workerVersion} · parser {scan.parserVersion} · ответы {scan.canWriteChat ? 'разрешены' : 'запрещены'}</Text>
        {stale && <Text type="danger">Проход не завершён больше 2 минут. Worker мог остановиться.</Text>}
        {(scan.errorMessage || scan.dayErrorCode || scan.replySearchErrorCode) && <Text type="danger">{scan.errorMessage || scan.dayErrorCode || scan.replySearchErrorCode}</Text>}
      </Space>
    </Card>
  );
}

function OperationEvidence({ operation }: { operation: TelegramWorkerOperation }) {
  return (
    <Card size="small" title={<Space><Tag color={STATUS_COLORS[operation.status]}>{STATUS_LABELS[operation.status] ?? operation.status}</Tag><Text>{operation.operationType === 'telegram_reply' ? 'Ответ Telegram' : 'Обработка файла'}</Text></Space>}>
      <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
        <Descriptions.Item label="Причина">{operation.reasonMessage || operation.reasonCode || '—'}</Descriptions.Item>
        <Descriptions.Item label="Ошибка">{operation.errorMessage || operation.errorCode || '—'}</Descriptions.Item>
        <Descriptions.Item label="Packet key">{operation.externalPacketKey || '—'}</Descriptions.Item>
        <Descriptions.Item label="Версия источника" className="tg-audit-num">{operation.sourceVersion ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Packet">{operation.packetId || '—'}</Descriptions.Item>
        <Descriptions.Item label="Раскрой ERP">{operation.cutJobId ? `#${operation.cutJobId}${operation.cutResultNo ? ` / результат ${operation.cutResultNo}` : ''}` : '—'}</Descriptions.Item>
        <Descriptions.Item label="Ответ">{operation.replyText || '—'}</Descriptions.Item>
        <Descriptions.Item label="На сообщение" className="tg-audit-num">{operation.replyToMessageId ? `#${operation.replyToMessageId}` : '—'}</Descriptions.Item>
        <Descriptions.Item label="ID ответа" className="tg-audit-num">{operation.sentTelegramMessageId ? `#${operation.sentTelegramMessageId}` : '—'}</Descriptions.Item>
        <Descriptions.Item label="Отправитель сессии" className="tg-audit-num">{operation.sessionSenderUserId ? `#${operation.sessionSenderUserId}` : '—'}</Descriptions.Item>
        <Descriptions.Item label="ERP применил">{operation.backendApplied == null ? '—' : operation.backendApplied ? 'да' : operation.backendStale ? 'нет, устарело' : 'нет'}</Descriptions.Item>
        {operation.operationType === 'telegram_reply' && <Descriptions.Item label="Восстановление">{operation.reconciliationYieldedCount} сообщений · {operation.reconciliationExhausted ? 'полный поиск' : operation.reconciliationTruncated ? 'достигнут лимит' : operation.reconciliationErrorCode || 'не завершён'}</Descriptions.Item>}
        {operation.reconciliationWindowFrom && <Descriptions.Item label="Окно восстановления">{formatDateTime(operation.reconciliationWindowFrom)} — {formatDateTime(operation.reconciliationWindowTo)}</Descriptions.Item>}
      </Descriptions>
      {operation.steps.length > 0 && <Timeline style={{ marginTop: 12 }} items={operation.steps.map((step) => ({ color: step.status === 'failed' ? 'red' : step.status === 'skipped' ? 'orange' : 'green', children: <><Text>{step.message}</Text><Text type="secondary" style={{ marginLeft: 8 }}>{formatDateTime(step.at)}</Text></> }))} />}
      {operation.responses.map((response) => <Alert key={response.responseId} style={{ marginTop: 8 }} type={response.status === 'failed' ? 'error' : 'info'} showIcon message={response.kind === 'telegram_reply' ? `Telegram: ${response.text ?? response.status}` : `ERP: ${response.status}`} description={response.errorMessage || (response.replyToMessageId ? `Ответ на #${response.replyToMessageId}` : undefined)} />)}
    </Card>
  );
}

function ExpandedEvidence({ record }: { record: TelegramWorkerMessageLog }) {
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Descriptions size="small" bordered column={{ xs: 1, sm: 2, lg: 4 }}>
        <Descriptions.Item label="Чат" className="tg-audit-num">#{record.sourceChatId}</Descriptions.Item>
        <Descriptions.Item label="Отправитель" className="tg-audit-num">{record.senderUserId ? `#${record.senderUserId}` : '—'} · {record.outgoing ? 'исходящее' : 'входящее'}</Descriptions.Item>
        <Descriptions.Item label="Ответ на" className="tg-audit-num">{record.replyToMessageId ? `#${record.replyToMessageId}` : '—'}</Descriptions.Item>
        <Descriptions.Item label="Связано с" className="tg-audit-num">{record.relatedSourceMessageId ? `#${record.relatedSourceMessageId}` : '—'}</Descriptions.Item>
        <Descriptions.Item label="Packet key">{record.externalPacketKey || '—'}</Descriptions.Item>
        <Descriptions.Item label="Packet ID">{record.packetId || '—'}</Descriptions.Item>
        <Descriptions.Item label="Раскрой ERP" className="tg-audit-num">{record.cutJobId ? `#${record.cutJobId}` : '—'}</Descriptions.Item>
        <Descriptions.Item label="Номер раскроя" className="tg-audit-num">{record.cuttingSequenceNo ?? '—'}</Descriptions.Item>
      </Descriptions>
      {record.observations.length > 0 && <Text type="secondary" className="tg-audit-num">Прочитано {record.observations.length} раз: {record.observations.map((item) => `${item.readSource} №${item.readOrdinal}${item.decisionCode ? ` → ${item.decisionCode}` : ''}${item.relatedSourceMessageId ? ` (для #${item.relatedSourceMessageId})` : ''}`).join(', ')}</Text>}
      {record.operations.length ? record.operations.map((operation) => <OperationEvidence key={operation.operationId} operation={operation} />) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Операций нет: сообщение только прочитано" />}
    </Space>
  );
}

export const TelegramWorkerAudit: React.FC = () => {
  const [form] = Form.useForm<FilterValues>();
  const [query, setQuery] = useState<TelegramWorkerAuditQuery>(() => buildTelegramWorkerAuditQuery({}));
  const [data, setData] = useState<TelegramWorkerMessageLog[]>([]);
  const [scans, setScans] = useState<TelegramWorkerScan[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 50, total: 0 });
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => dayjs());

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await cncTelegramApi.workerLogs(query);
      setData(response.data); setScans(response.scans); setPagination(response.pagination);
    } catch (caught) {
      setData([]); setScans([]);
      setError(caught instanceof ApiError && caught.statusCode === 403 ? 'Нет права audit.view.' : caught instanceof Error ? caught.message : 'Не удалось загрузить журнал.');
    } finally { setLoading(false); }
  }, [query]);
  const exportDetailed = useCallback(async () => {
    const exportQuery = buildTelegramWorkerAuditExportQuery(form.getFieldsValue());
    setExporting(true);
    setError(null);
    try {
      const result = await cncTelegramApi.exportWorkerLogs(exportQuery);
      saveBlob(
        result.blob,
        result.fileName ?? `telegram-worker-audit_${exportQuery.dateFrom}_${exportQuery.dateTo}.json`,
      );
      message.success('Подробный JSON-журнал выгружен');
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.statusCode === 403
          ? 'Нет права audit.view.'
          : caught instanceof Error
            ? caught.message
            : 'Не удалось выгрузить JSON-журнал.',
      );
    } finally {
      setExporting(false);
    }
  }, [form]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(dayjs()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div style={{ padding: '0 8px 16px' }}>
      <style>{`.tg-audit-num { font-variant-numeric: tabular-nums; } .tg-audit-controls .ant-input, .tg-audit-controls .ant-select-selector, .tg-audit-controls .ant-picker, .tg-audit-controls .ant-btn { min-height: 40px !important; }`}</style>
      <Space style={{ marginBottom: 12 }}><RobotOutlined style={{ color: '#1677ff' }} /><Text strong>Журнал Telegram-воркера</Text><Text type="secondary">Что бот прочитал, почему пропустил и что ответил</Text></Space>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', marginBottom: 12, paddingBottom: 2 }}>{scans.slice(0, 4).map((scan) => <ScanCard key={scan.scanId} scan={scan} now={now} />)}</div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Form form={form} layout="inline" className="tg-audit-controls" initialValues={{ period: [dayjs().subtract(6, 'day'), dayjs()] }} onFinish={(values) => setQuery(buildTelegramWorkerAuditQuery(values, pagination.pageSize))}>
          <Form.Item name="period"><DatePicker.RangePicker allowClear={false} /></Form.Item>
          <Form.Item name="status"><Select allowClear placeholder="Результат" style={{ width: 150 }} options={Object.entries(STATUS_LABELS).filter(([key]) => ['observed','used','ingested','skipped','failed'].includes(key)).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="messageType"><Select allowClear placeholder="Тип" style={{ width: 145 }} options={Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="reasonCode"><Input allowClear placeholder="Код причины" style={{ width: 180 }} /></Form.Item>
          <Form.Item name="search"><Input allowClear prefix={<SearchOutlined />} placeholder="ID, файл или текст" style={{ width: 220 }} /></Form.Item>
          <Form.Item>
            <Space wrap>
              <Button type="primary" htmlType="submit">Показать</Button>
              <Button icon={<ReloadOutlined />} onClick={() => void load()}>Обновить</Button>
              <Tooltip title="Полный JSON: все поля сканов, сообщений, наблюдений, операций, шагов и ответов за выбранный период с учётом фильтров">
                <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportDetailed()}>
                  Выгрузить JSON
                </Button>
              </Tooltip>
            </Space>
          </Form.Item>
        </Form>
      </Card>
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col xs={12} md={6}><Statistic title="Сообщений" value={pagination.total} /></Col>
        <Col xs={12} md={6}><Statistic title="На странице: создано" value={data.filter((item) => item.status === 'ingested').length} /></Col>
        <Col xs={12} md={6}><Statistic title="На странице: пропущено" value={data.filter((item) => item.status === 'skipped').length} /></Col>
        <Col xs={12} md={6}><Statistic title="На странице: ошибки" value={data.filter((item) => item.status === 'failed').length} /></Col>
      </Row>
      <Table<TelegramWorkerMessageLog> rowKey="logId" size="middle" loading={loading} dataSource={data} scroll={{ x: 1040 }} locale={{ emptyText: <Empty description="За период сообщений нет" /> }} expandable={{ expandedRowRender: (record) => <ExpandedEvidence record={record} />, rowExpandable: (record) => record.operations.length > 0 || record.observations.length > 0 }} pagination={{ current: pagination.page, pageSize: pagination.pageSize, total: pagination.total, showSizeChanger: true }} onChange={(next) => setQuery((current) => ({ ...current, page: next.current ?? 1, pageSize: next.pageSize ?? 50 }))}>
        <Table.Column<TelegramWorkerMessageLog> title="Когда" width={150} render={(_, record) => <Text className="tg-audit-num">{formatDateTime(record.sourceCreatedAt)}</Text>} />
        <Table.Column<TelegramWorkerMessageLog> title="Telegram" width={190} render={(_, record) => <div><Text strong className="tg-audit-num">Сообщение #{record.sourceMessageId}</Text><br /><Text type="secondary" className="tg-audit-num">Отправитель #{record.senderUserId ?? '—'} · {record.outgoing ? 'исх.' : 'вх.'}</Text></div>} />
        <Table.Column<TelegramWorkerMessageLog> title="Тип" width={105} render={(_, record) => <Tag>{TYPE_LABELS[record.messageType] ?? record.messageType}</Tag>} />
        <Table.Column<TelegramWorkerMessageLog> title="Файл / текст" width={260} render={(_, record) => <div><Text strong={Boolean(record.filename)}>{record.filename || 'Без файла'}</Text>{record.messageText && <Text type="secondary" ellipsis={{ tooltip: record.messageText }} style={{ display: 'block', maxWidth: 240 }}>{record.messageText}</Text>}</div>} />
        <Table.Column<TelegramWorkerMessageLog> title="Результат" width={150} render={(_, record) => <div><Tag color={STATUS_COLORS[record.status]}>{STATUS_LABELS[record.status] ?? record.status}</Tag>{record.everIngested && record.status !== 'ingested' && <Tag color="green">ранее создано</Tag>}</div>} />
        <Table.Column<TelegramWorkerMessageLog> title="Почему / что сделано" render={(_, record) => <div><Text>{record.reasonMessage || record.errorMessage || 'Решение ещё не принято'}</Text>{(record.reasonCode || record.errorCode) && <Text code style={{ display: 'block', marginTop: 3 }}>{record.reasonCode || record.errorCode}</Text>}{record.cutJobId && <Text type="success" className="tg-audit-num" style={{ display: 'block' }}>Раскрой ERP #{record.cutJobId}</Text>}</div>} />
      </Table>
    </div>
  );
};

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
