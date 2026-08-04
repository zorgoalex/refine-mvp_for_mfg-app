import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Col, Descriptions, Form, Input, InputNumber, Modal,
  Popconfirm, Row, Space, Table, Typography, message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, DownloadOutlined, EditOutlined, SaveOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import {
  bazisCutApi, type BazisCutDetailFields, type BazisCutSetCardDto, type BazisCutSetDetailDto,
} from '../../api/bazisCutApi';
import { OrderDeletedTag, orderDeletedReferenceClassName } from '../../components/OrderDeletedTag';
import { useTabStore } from '../../stores/tabStore';
import { can } from '../../utils/permissions';
import { buildBazisCutQrCode, summarizeBazisCutDetails } from './bazisCutDetailPresentation';
import { saveBazisCutFile, type BazisCutSaveHandle } from './bazisCutSaveFile';
import './BazisCutSetPage.css';

const { Title, Text } = Typography;

type FieldKey = keyof BazisCutDetailFields;
interface FieldDefinition { key: FieldKey; label: string; group: 'Основное' | 'Размеры' | 'Кромки' | 'Дополнительно'; kind: 'text' | 'long' | 'number' | 'integer' | 'boolean'; }

const FIELDS: FieldDefinition[] = [
  { key: 'cutEnabled', label: 'Кроить', group: 'Основное', kind: 'boolean' },
  { key: 'materialType', label: 'Тип материала', group: 'Основное', kind: 'text' },
  { key: 'materialName', label: 'Материал', group: 'Основное', kind: 'text' },
  { key: 'materialArticle', label: 'Артикул материала', group: 'Основное', kind: 'text' },
  { key: 'thicknessMm', label: 'Толщина', group: 'Основное', kind: 'number' },
  { key: 'position', label: 'Позиция', group: 'Основное', kind: 'text' },
  { key: 'partName', label: 'Наименования', group: 'Основное', kind: 'text' },
  { key: 'finishedLengthMm', label: 'Длина готовая', group: 'Размеры', kind: 'number' },
  { key: 'finishedWidthMm', label: 'Ширина готовая', group: 'Размеры', kind: 'number' },
  { key: 'cutLengthMm', label: 'Длина распиловочная', group: 'Размеры', kind: 'number' },
  { key: 'cutWidthMm', label: 'Ширина распиловочная', group: 'Размеры', kind: 'number' },
  { key: 'quantity', label: 'Кол-во', group: 'Размеры', kind: 'integer' },
  { key: 'orientation', label: 'Ориентация', group: 'Размеры', kind: 'text' },
  { key: 'groove', label: 'Паз', group: 'Кромки', kind: 'text' },
  { key: 'l1Name', label: 'L1 - Наим.', group: 'Кромки', kind: 'text' },
  { key: 'l1Designation', label: 'L1 - Обозн.', group: 'Кромки', kind: 'text' },
  { key: 'l1ThicknessMm', label: 'L1 - Толщина', group: 'Кромки', kind: 'number' },
  { key: 'l2Name', label: 'L2 - Наим.', group: 'Кромки', kind: 'text' },
  { key: 'l2Designation', label: 'L2 - Обозн.', group: 'Кромки', kind: 'text' },
  { key: 'l2ThicknessMm', label: 'L2 - Толщина', group: 'Кромки', kind: 'number' },
  { key: 'w1Name', label: 'W1 - Наим.', group: 'Кромки', kind: 'text' },
  { key: 'w1Designation', label: 'W1 - Обозн.', group: 'Кромки', kind: 'text' },
  { key: 'w1ThicknessMm', label: 'W1 - Толщина', group: 'Кромки', kind: 'number' },
  { key: 'w2Name', label: 'W2 - Наим.', group: 'Кромки', kind: 'text' },
  { key: 'w2Designation', label: 'W2 - Обозн.', group: 'Кромки', kind: 'text' },
  { key: 'w2ThicknessMm', label: 'W2 - Толщина', group: 'Кромки', kind: 'number' },
  { key: 'priority', label: 'Приоритет', group: 'Дополнительно', kind: 'integer' },
  { key: 'comment', label: 'Комментарий', group: 'Дополнительно', kind: 'long' },
  { key: 'customProperty', label: '%Пользовательское свойство', group: 'Дополнительно', kind: 'long' },
  { key: 'glue', label: '%Склейка', group: 'Дополнительно', kind: 'text' },
  { key: 'milling', label: '%Фрезировка', group: 'Дополнительно', kind: 'text' },
  { key: 'route', label: '%Маршрут', group: 'Дополнительно', kind: 'text' },
  { key: 'film', label: '%Пленка', group: 'Дополнительно', kind: 'text' },
];
const FIELD_GROUPS = ['Основное', 'Размеры', 'Кромки', 'Дополнительно'] as const;
const GROUPED_FIELDS = FIELD_GROUPS.flatMap((group) =>
  FIELDS.filter((field) => field.group === group && field.key !== 'position' && field.key !== 'partName'),
);
const LEADING_COLUMN_COUNT = 7;
const QR_CODE_COLUMN_INDEX = 5;
const QR_CODE_STICKY_CLASS = 'bazis-cut-sticky-qr';
const QR_CODE_STICKY_LEFT_PX = 58 + 210 + 150 + 150;
const TOTAL_LABEL_COLUMN_INDEX = LEADING_COLUMN_COUNT - 1;
const QUANTITY_COLUMN_INDEX = LEADING_COLUMN_COUNT
  + GROUPED_FIELDS.findIndex((field) => field.key === 'quantity');

export const BazisCutSetPage: React.FC = () => {
  const { id } = useParams(); const setId = Number(id); const valid = Number.isInteger(setId) && setId > 0;
  const [set, setSet] = useState<BazisCutSetCardDto | null>(null);
  const [loading, setLoading] = useState(false); const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false); const [editing, setEditing] = useState<BazisCutSetDetailDto | null>(null);
  const [nameForm] = Form.useForm<{ name: string }>(); const [detailForm] = Form.useForm<BazisCutDetailFields>();
  const canManage = can('cut.manage');
  const setTabTitle = useTabStore((state) => state.setTabTitle);
  const tableHeaderOffset = useWorkspaceTabsHeight();

  useEffect(() => {
    if (valid) setTabTitle(`/bazis-cut/${setId}`, `Базис-раскрой #${setId}`);
  }, [setId, setTabTitle, valid]);

  const load = useCallback(async () => {
    if (!valid) return; setLoading(true);
    try { const response = await bazisCutApi.get(setId); setSet(response); nameForm.setFieldsValue({ name: response.name }); }
    catch (error) { message.error(error instanceof Error ? error.message : 'Не удалось загрузить набор'); }
    finally { setLoading(false); }
  }, [nameForm, setId, valid]);
  useEffect(() => { void load(); }, [load]);

  const saveName = useCallback(async () => {
    if (!set) return; const { name } = await nameForm.validateFields(); setSaving(true);
    try { const result = await bazisCutApi.rename(setId, { name: name.trim(), expectedVersion: set.version }, { idempotencyKey: commandKey('bazis-cut-rename') }); setSet(result.set); message.success('Название сохранено'); }
    catch (error) { message.error(error instanceof Error ? error.message : 'Не удалось сохранить название'); }
    finally { setSaving(false); }
  }, [nameForm, set, setId]);

  const startEdit = useCallback((detail: BazisCutSetDetailDto) => { setEditing(detail); detailForm.setFieldsValue(fieldsOf(detail)); }, [detailForm]);
  const saveDetail = useCallback(async () => {
    if (!set || !editing) return; const fields = await detailForm.validateFields(); setSaving(true);
    try { const result = await bazisCutApi.updateDetail(setId, editing.bazisCutSetDetailId,
      { ...fields, priority: fields.priority ?? null, expectedVersion: set.version }, { idempotencyKey: commandKey('bazis-cut-detail') });
      setSet(result.set); setEditing(null); message.success('Строка сохранена'); }
    catch (error) { message.error(error instanceof Error ? error.message : 'Не удалось сохранить строку'); }
    finally { setSaving(false); }
  }, [detailForm, editing, set, setId]);

  const remove = useCallback(async (detailId: number) => {
    if (!set) return;
    try { const result = await bazisCutApi.removeDetail(setId, detailId, { expectedVersion: set.version }, { idempotencyKey: commandKey('bazis-cut-delete') }); setSet(result.set); message.success('Деталь удалена'); }
    catch (error) { message.error(error instanceof Error ? error.message : 'Не удалось удалить деталь'); }
  }, [set, setId]);

  const exportXls = useCallback(async () => {
    if (!set) return;
    const picker = (window as PickerWindow).showSaveFilePicker;
    try {
      await saveBazisCutFile({
        suggestedName: exportFileName(set.name, setId),
        picker: picker ? (options) => picker.call(window, options) : undefined,
        fetchFile: () => bazisCutApi.exportXls(setId), fallbackDownload: downloadBlob,
        onGenerationStart: () => setExporting(true),
      });
      message.success('Excel-файл сформирован');
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) message.error(error instanceof Error ? error.message : 'Не удалось экспортировать Excel'); }
    finally { setExporting(false); }
  }, [set, setId]);

  const columns = useMemo<ColumnsType<BazisCutSetDetailDto>>(() => buildColumns(canManage, startEdit, remove), [canManage, remove, startEdit]);
  if (!valid) return <div className="bazis-cut-set-modern"><Alert type="error" showIcon message="Некорректный номер набора" /></div>;
  return <div className="bazis-cut-set-modern"><Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}><Title level={3} style={{ margin: 0 }}>Базис-раскрой #{setId}</Title>
      <Button type="primary" icon={<DownloadOutlined />} loading={exporting} disabled={!set || set.positionCount === 0} onClick={() => void exportXls()}>Экспорт XLS</Button></Space>
    <Card loading={loading} title="Набор"><Form form={nameForm} layout="inline" onFinish={() => void saveName()}>
      <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true }, { max: 200 }]} style={{ flex: 1 }}><Input disabled={!canManage} /></Form.Item>
      {canManage && <Button htmlType="submit" icon={<SaveOutlined />} loading={saving}>Сохранить</Button>}
    </Form>
    {set && <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} style={{ marginTop: 16 }}>
      <Descriptions.Item label="Сформирован">{new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(set.createdAt))}</Descriptions.Item>
      <Descriptions.Item label="Деталей"><span style={{ fontVariantNumeric: 'tabular-nums' }}>{set.quantity}</span></Descriptions.Item>
      <Descriptions.Item label="Позиций"><span style={{ fontVariantNumeric: 'tabular-nums' }}>{set.positionCount}</span></Descriptions.Item>
      <Descriptions.Item label="ERP-заказы"><SourceRefs refs={set.orders} href={(refId) => `/orders/show/${refId}`} /></Descriptions.Item>
      <Descriptions.Item label="ERP-проекты"><SourceRefs refs={set.projects} /></Descriptions.Item>
      <Descriptions.Item label="Базис-проекты"><SourceRefs refs={set.bazisProjects} href={(refId) => `/bazis/projects/${refId}`} /></Descriptions.Item>
      <Descriptions.Item label="Базис-заказы"><SourceRefs refs={set.bazisOrders} /></Descriptions.Item>
    </Descriptions>}</Card>
    <Card title="Детали набора"><Table className="bazis-cut-set-details-table"
      style={{ '--bazis-cut-sticky-qr-left': `${QR_CODE_STICKY_LEFT_PX}px` } as React.CSSProperties}
      rowKey="bazisCutSetDetailId" columns={columns} dataSource={set?.details ?? []}
      loading={loading} pagination={false} scroll={{ x: 5470, y: 480 }} sticky={{ offsetHeader: tableHeaderOffset }}
      rowClassName={(row) => orderDeletedReferenceClassName(row.sourceOrderDeleted)}
      summary={(details) => <DetailTableSummary details={details} canManage={canManage} />}
      size="small" locale={{ emptyText: 'В наборе нет деталей' }} /></Card>
  </Space>
  <Modal width={1000} title={`Редактирование позиции ${editing?.position ?? ''}`} open={editing !== null}
    onCancel={() => setEditing(null)} onOk={() => void saveDetail()} confirmLoading={saving} okText="Сохранить" cancelText="Отмена" destroyOnClose>
    <Form form={detailForm} layout="vertical">{FIELD_GROUPS.map((group) => <Card key={group} size="small" title={group} style={{ marginBottom: 12 }}><Row gutter={12}>
      {FIELDS.filter((field) => field.group === group).map((field) => <Col xs={24} md={field.kind === 'long' ? 24 : 8} key={field.key}><FieldInput field={field} /></Col>)}
    </Row></Card>)}</Form>
  </Modal></div>;
};

const FieldInput: React.FC<{ field: FieldDefinition }> = ({ field }) => {
  const rules = field.key === 'materialName' || field.key === 'partName' || field.key === 'materialType'
    ? [{ required: true, message: 'Обязательное поле' }] : [];
  if (field.kind === 'boolean') return <Form.Item name={field.key} label={field.label} valuePropName="checked"><Checkbox>Да</Checkbox></Form.Item>;
  if (field.kind === 'number' || field.kind === 'integer') return <Form.Item name={field.key} label={field.label} rules={rules}>
    <InputNumber style={{ width: '100%' }} precision={field.kind === 'integer' ? 0 : 2} min={field.key === 'priority' || field.key.includes('Thickness') ? 0 : 0.01} /></Form.Item>;
  return <Form.Item name={field.key} label={field.label} rules={rules}>{field.kind === 'long' ? <Input.TextArea rows={2} /> : <Input />}</Form.Item>;
};

function buildColumns(canManage: boolean, edit: (detail: BazisCutSetDetailDto) => void, remove: (id: number) => void): ColumnsType<BazisCutSetDetailDto> {
  const valueColumn = (field: FieldDefinition) => ({ title: field.label, dataIndex: field.key, key: field.key, width: field.kind === 'long' ? 220 : 140,
    align: field.kind === 'number' || field.kind === 'integer' ? 'right' as const : undefined,
    render: (value: unknown) => field.kind === 'boolean' ? (value ? 'Да' : 'Нет') : value == null || value === '' ? <Text type="secondary">—</Text> : <span style={{ fontVariantNumeric: field.kind === 'number' || field.kind === 'integer' ? 'tabular-nums' : undefined }}>{String(value)}</span> });
  const grouped = FIELD_GROUPS.map((group) => ({ title: group, children: GROUPED_FIELDS.filter((field) => field.group === group).map(valueColumn) }));
  return [
    { title: '№', key: 'rowNumber', fixed: 'left', width: 58, align: 'right',
      render: (_: unknown, _row: BazisCutSetDetailDto, index: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{index + 1}</span> },
    { title: 'Источник', key: 'source', fixed: 'left', width: 210, render: (_, row) => row.sourceOrderId ? (
      <Space size={4} wrap>
        <Link to={`/orders/show/${row.sourceOrderId}`}>{row.sourceOrderFullNumber || row.sourceOrderName}</Link>
        <OrderDeletedTag deleted={row.sourceOrderDeleted} />
      </Space>
    ) : 'Снимок' },
    { title: 'Базис-проект', dataIndex: 'sourceBazisProjectName', key: 'sourceBazisProjectName', fixed: 'left', width: 150,
      render: (value: string, row) => value
        ? row.sourceBazisProjectId
          ? <Link to={`/bazis/projects/${row.sourceBazisProjectId}`}><span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span></Link>
          : <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        : <Text type="secondary">—</Text> },
    { title: 'Базис-заказ', dataIndex: 'sourceBazisOrderNo', key: 'sourceBazisOrderNo', fixed: 'left', width: 150,
      render: (value: string) => value
        ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        : <Text type="secondary">—</Text> },
    { title: 'Позиция', dataIndex: 'position', key: 'position', width: 130,
      render: (value: string) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span> },
    { title: 'QR-code', key: 'qrCode', className: QR_CODE_STICKY_CLASS, width: 220, render: (_: unknown, row: BazisCutSetDetailDto) => {
      const qrCode = buildBazisCutQrCode(row);
      return qrCode
        ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{qrCode}</span>
        : <Text type="secondary">—</Text>;
    } },
    { title: 'Наименование', dataIndex: 'partName', key: 'partName', width: 200 },
    ...grouped,
    ...(canManage ? [{ title: 'Действия', key: 'actions', fixed: 'right' as const, width: 110,
      render: (_: unknown, row: BazisCutSetDetailDto) => <Space><Button aria-label="Редактировать" icon={<EditOutlined />} onClick={() => edit(row)} />
        <Popconfirm title="Удалить деталь из набора?" onConfirm={() => void remove(row.bazisCutSetDetailId)} okText="Удалить" cancelText="Отмена"><Button danger aria-label="Удалить" icon={<DeleteOutlined />} /></Popconfirm></Space> }] : []),
  ];
}

const DetailTableSummary: React.FC<{
  details: readonly BazisCutSetDetailDto[];
  canManage: boolean;
}> = ({ details, canManage }) => {
  const totals = summarizeBazisCutDetails(details);
  const columnCount = LEADING_COLUMN_COUNT + GROUPED_FIELDS.length + (canManage ? 1 : 0);
  return <Table.Summary fixed="bottom"><Table.Summary.Row style={{ backgroundColor: 'var(--app-surface-muted)' }}>
    {Array.from({ length: columnCount }, (_, index) => <Table.Summary.Cell key={index} index={index}
      className={index === QR_CODE_COLUMN_INDEX ? QR_CODE_STICKY_CLASS : undefined}>
      {index === TOTAL_LABEL_COLUMN_INDEX
        ? <div style={{ textAlign: 'right' }}><Text strong>Итого позиций: <span style={{ fontVariantNumeric: 'tabular-nums' }}>{totals.positionCount}</span></Text></div>
        : index === QUANTITY_COLUMN_INDEX
          ? <div style={{ textAlign: 'right' }}><Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{totals.quantity}</Text></div>
          : null}
    </Table.Summary.Cell>)}
  </Table.Summary.Row></Table.Summary>;
};

function fieldsOf(detail: BazisCutSetDetailDto): BazisCutDetailFields { return Object.fromEntries(FIELDS.map((field) => [field.key, detail[field.key]])) as unknown as BazisCutDetailFields; }
function commandKey(prefix: string): string { return `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`; }
function useWorkspaceTabsHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const tabs = document.querySelector<HTMLElement>('.workspace-tabs');
    if (!tabs) return;
    const update = () => setHeight(Math.ceil(tabs.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tabs);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);
  return height;
}
const SourceRefs: React.FC<{ refs: Array<{ id: number; label: string; deleted?: boolean }>; href?: (id: number) => string }> = ({ refs, href }) => {
  if (refs.length === 0) return <>—</>;
  return <>{refs.map((ref, index) => <React.Fragment key={`${ref.id}-${ref.label}`}>{index > 0 && ', '}
    <Space size={4} wrap>
      {href && ref.id > 0 ? <Link to={href(ref.id)}>{ref.label}</Link> : ref.label}
      <OrderDeletedTag deleted={ref.deleted} />
    </Space>
  </React.Fragment>)}</>;
};
function exportFileName(name: string, setId: number): string {
  const safe = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '').slice(0, 120) || 'набор';
  return `Базис-раскрой-${safe}-${setId}.xls`;
}
function downloadBlob(blob: Blob, fileName: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }
interface PickerWindow extends Window { showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<BazisCutSaveHandle>; }
