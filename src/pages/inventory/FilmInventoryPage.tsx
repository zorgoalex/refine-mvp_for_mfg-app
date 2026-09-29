import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useList } from '@refinedev/core';
import { Alert, Button, Card, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Tabs, Tag, Typography, Upload, message } from 'antd';
import { Table } from '../../ui/tooltipDelay';
import type { RcFile } from 'antd/es/upload';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import { inventoryApi, createInventoryIdempotencyKey } from '../../api/inventoryApi';
import type { InventoryApiError, StockDocumentDto, StockDocType, StockDocumentSummaryDto } from '../../api/types/inventoryApi.types';
import { can } from '../../utils/permissions';
import { lineFilmOptions, lineFilmValue, parseStockCsv, parseStockRows, selectDefaultStockSheet, unresolvedLineIds, type ParsedStockSheet } from './filmStock';
import './inventory.css';

const { Title, Text } = Typography;
const formatQuantity = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
const today = () => new Date().toISOString().slice(0, 10);
const docTypeName: Record<StockDocType, string> = { receipt: 'Приход', writeoff: 'Списание', inventory: 'Инвентаризация' };
const statusName = { draft: 'Черновик', posted: 'Проведён', cancelled: 'Отменён' };
const apiError = (error: unknown): InventoryApiError => typeof error === 'object' && error !== null ? error as InventoryApiError : {};

export const FilmInventoryPage: React.FC = () => {
  const queryClient = useQueryClient();
  const viewAllowed = can('inventory.view');
  const manageAllowed = can('inventory.manage');
  const [tab, setTab] = useState('balances');
  const [warehouseId, setWarehouseId] = useState<number>();
  const [vendorId, setVendorId] = useState<number>();
  const [search, setSearch] = useState('');
  const [nonZero, setNonZero] = useState(false);
  const [negative, setNegative] = useState(false);
  const [docTypeFilter, setDocTypeFilter] = useState<StockDocType>();
  const [docStatusFilter, setDocStatusFilter] = useState<'draft' | 'posted' | 'cancelled'>();
  const [docDateRange, setDocDateRange] = useState<[string | undefined, string | undefined]>();
  const [docFilmId, setDocFilmId] = useState<number>();
  const [docOrderId, setDocOrderId] = useState<number>();
  const [selectedDoc, setSelectedDoc] = useState<StockDocumentDto>();
  const [manualType, setManualType] = useState<StockDocType>();
  const [manualForm] = Form.useForm();
  const [importOpen, setImportOpen] = useState(false);
  const [sheets, setSheets] = useState<ParsedStockSheet[]>([]);
  const [sheetName, setSheetName] = useState<string>();
  const [importRows, setImportRows] = useState<ParsedStockSheet['rows']>([]);
  const [importType, setImportType] = useState<'receipt' | 'inventory'>('inventory');
  const [importDate, setImportDate] = useState(today());
  const [file, setFile] = useState<File>();
  const [operationBusy, setOperationBusy] = useState(false);
  const retryKey = useRef<string>();
  const retryActionId = useRef<string>();
  const warehousesQuery = useQuery({ queryKey: ['inventory', 'warehouses'], queryFn: () => inventoryApi.warehouses(), enabled: viewAllowed });
  const warehouse = warehousesQuery.data?.items[0];
  const activeWarehouseId = warehouseId ?? warehouse?.warehouseId;
  // Серверная пагинация: фильтры сбрасывают страницу.
  const [balancePage, setBalancePage] = useState({ current: 1, pageSize: 50 });
  const [docPage, setDocPage] = useState({ current: 1, pageSize: 30 });
  useEffect(() => { setBalancePage((page) => ({ ...page, current: 1 })); }, [activeWarehouseId, vendorId, search, nonZero, negative]);
  useEffect(() => { setDocPage((page) => ({ ...page, current: 1 })); }, [docTypeFilter, docStatusFilter, docDateRange, docFilmId, docOrderId]);
  const balanceFilter = { warehouseId: activeWarehouseId, vendorId, search: search || undefined, nonZero: nonZero || undefined, negative: negative || undefined };
  const balancesQuery = useQuery({
    queryKey: ['inventory', 'balances', activeWarehouseId, vendorId, search, nonZero, negative, balancePage.current, balancePage.pageSize],
    queryFn: () => inventoryApi.balances({ ...balanceFilter, offset: (balancePage.current - 1) * balancePage.pageSize, limit: balancePage.pageSize }),
    enabled: viewAllowed && activeWarehouseId !== undefined,
  });
  const documentsQuery = useQuery({
    queryKey: ['inventory', 'documents', docTypeFilter, docStatusFilter, docDateRange, docFilmId, docOrderId, docPage.current, docPage.pageSize],
    queryFn: () => inventoryApi.documents({ type: docTypeFilter, status: docStatusFilter, from: docDateRange?.[0], to: docDateRange?.[1], filmId: docFilmId, orderId: docOrderId, offset: (docPage.current - 1) * docPage.pageSize, limit: docPage.pageSize }),
    enabled: viewAllowed && tab === 'documents',
  });
  // Выбор плёнки — штатное чтение справочника: активные основные плёнки (дубли после импорта каталога скрыты).
  const { data: filmsList } = useList<{ film_id: number; film_name: string; canonical_film_id: number | null }>({
    resource: 'films',
    pagination: { mode: 'off' },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    meta: { fields: ['film_id', 'film_name', 'canonical_film_id'] },
    queryOptions: { enabled: manageAllowed },
  });
  const activeFilmOptions = useMemo(() => (filmsList?.data ?? [])
    .filter((film) => film.canonical_film_id == null)
    .map((film) => ({ value: Number(film.film_id), label: film.film_name })), [filmsList?.data]);
  const exportBalances = async () => {
    const rows: Array<{ filmName: string; vendorName: string | null; quantity: number; lastMovementAt: string | null }> = [];
    for (let offset = 0; ; offset += 500) {
      const page = await inventoryApi.balances({ ...balanceFilter, offset, limit: 500 });
      rows.push(...page.items);
      if (page.items.length < 500 || rows.length >= page.total) break;
    }
    const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({ Плёнка: row.filmName, Поставщик: row.vendorName ?? '', 'Пог. м': row.quantity, 'Последнее движение': row.lastMovementAt ?? '' })));
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Остатки'); XLSX.writeFile(book, 'Остатки-плёнки.xlsx');
  };
  const balances = balancesQuery.data?.items ?? [];
  // Поставщики для фильтра — из справочника, а не из текущей страницы остатков.
  const { data: vendorsList } = useList<{ vendor_id: number; vendor_name: string }>({
    resource: 'vendors',
    pagination: { mode: 'off' },
    meta: { fields: ['vendor_id', 'vendor_name'] },
    queryOptions: { enabled: viewAllowed },
  });
  const vendors = useMemo(() => (vendorsList?.data ?? [])
    .map((item) => [Number(item.vendor_id), item.vendor_name] as [number, string])
    .sort((a, b) => a[1].localeCompare(b[1], 'ru')), [vendorsList?.data]);
  const runCommand = async (operation: (key: string) => Promise<unknown>, actionId: string) => {
    setOperationBusy(true);
    if (retryActionId.current !== actionId) { retryActionId.current = actionId; retryKey.current = undefined; }
    retryKey.current ??= createInventoryIdempotencyKey();
    try {
      await operation(retryKey.current);
      retryKey.current = undefined;
      retryActionId.current = undefined;
      message.success('Изменения сохранены');
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
      return true;
    } catch (error) {
      message.error(apiError(error).message ?? 'Не удалось выполнить действие. Повторите запрос для безопасного повтора.');
      return false;
    } finally { setOperationBusy(false); }
  };
  const refreshDocument = async (document: StockDocumentDto) => {
    setSelectedDoc(await inventoryApi.document(document.documentId));
    await queryClient.invalidateQueries({ queryKey: ['inventory'] });
  };
  const postSelectedDocument = async () => {
    if (!selectedDoc) return;
    const actionId = `post:${selectedDoc.documentId}:${selectedDoc.version}:allowNegative=false`;
    if (retryActionId.current !== actionId) { retryActionId.current = actionId; retryKey.current = undefined; }
    const attemptedKey = retryKey.current ?? (retryKey.current = createInventoryIdempotencyKey());
    try {
      const posted = await inventoryApi.post(selectedDoc.documentId, selectedDoc.version, false, attemptedKey);
      retryKey.current = undefined; retryActionId.current = undefined; message.success('Документ проведён'); await refreshDocument(posted);
    } catch (error) {
      const failure = apiError(error);
      if (failure.code === 'STOCK_WOULD_GO_NEGATIVE') {
        const detailObject = typeof failure.details === 'object' && failure.details !== null ? failure.details as { negativeAfter?: Array<{ filmName: string; after: number }> } : {};
        const rows = detailObject.negativeAfter ?? selectedDoc.negativeAfter;
        Modal.confirm({
          title: 'Провести с отрицательным остатком?',
          content: rows.map((row) => `${row.filmName}: ${formatQuantity(row.after)} м`).join('; ') || 'Остаток станет отрицательным.',
          okText: 'Провести', cancelText: 'Отмена',
          onOk: async () => {
            retryKey.current = undefined; retryActionId.current = undefined;
            await runCommand((key) => inventoryApi.post(selectedDoc.documentId, selectedDoc.version, true, key), `post:${selectedDoc.documentId}:${selectedDoc.version}:allowNegative=true`);
            await openDocument(selectedDoc.documentId);
          },
        });
      } else if (failure.code === 'STOCK_DOCUMENT_UNRESOLVED') {
        message.warning('Сопоставьте строки плёнки и подтвердите количество в карточке документа.');
        await openDocument(selectedDoc.documentId);
      } else message.error(failure.message ?? 'Не удалось провести документ');
    }
  };
  const openDocument = async (documentId: number) => {
    try { setSelectedDoc(await inventoryApi.document(documentId)); }
    catch (error) { message.error(apiError(error).message ?? 'Документ недоступен'); }
  };
  const createManual = async (allowNegative = false) => {
    const values = await manualForm.validateFields();
    setOperationBusy(true);
    const actionId = `manual:${manualType}:${JSON.stringify(values)}:allowNegative=${allowNegative}`;
    if (retryActionId.current !== actionId) { retryActionId.current = actionId; retryKey.current = undefined; }
    retryKey.current ??= createInventoryIdempotencyKey();
    try {
      const document = await inventoryApi.create({
        docType: manualType!, warehouseId: activeWarehouseId!, docDate: values.docDate.format('YYYY-MM-DD'), post: true,
        ...(allowNegative ? { allowNegative: true } : {}),
        ...(values.orderId ? { orderId: values.orderId } : {}), ...(values.comment ? { comment: values.comment } : {}),
        lines: values.lines.map((line: { filmId: number; quantity: number }) => ({ filmId: line.filmId, quantity: line.quantity })),
      }, retryKey.current);
      retryKey.current = undefined;
      retryActionId.current = undefined;
      setSelectedDoc(document);
      setManualType(undefined);
      manualForm.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
    } catch (error) {
      const failure = apiError(error);
      if (!allowNegative && failure.code === 'STOCK_WOULD_GO_NEGATIVE') {
        const details = typeof failure.details === 'object' && failure.details !== null ? failure.details as { negativeAfter?: Array<{ filmName: string; after: number }> } : {};
        const rows = details.negativeAfter ?? [];
        retryKey.current = undefined;
        retryActionId.current = undefined;
        Modal.confirm({
          title: 'Провести с отрицательным остатком?',
          content: rows.map((row) => `${row.filmName}: ${formatQuantity(row.after)} м`).join('; ') || 'Остаток станет отрицательным.',
          okText: 'Провести', cancelText: 'Отмена', onOk: () => createManual(true),
        });
      } else message.error(failure.message ?? 'Не удалось создать документ. Повторите запрос.');
    }
    finally { setOperationBusy(false); }
  };
  const acceptFile = async (selected: File) => {
    setFile(selected);
    try {
      let parsedSheets: ParsedStockSheet[];
      if (/\.csv$/i.test(selected.name)) parsedSheets = [parseStockCsv(new Uint8Array(await selected.arrayBuffer()))];
      else {
        const workbook = XLSX.read(await selected.arrayBuffer(), { type: 'array', cellDates: false });
        parsedSheets = workbook.SheetNames.map((name) => parseStockRows(XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, defval: '' }), name));
      }
      setSheets(parsedSheets);
      const chosen = selectDefaultStockSheet(parsedSheets);
      if (chosen) { setSheetName(chosen.name); setImportRows(chosen.rows); }
      if (parsedSheets.some((item) => /свод/i.test(item.name))) message.warning('Лист «Свод» может объединять строки. Проверьте выбранный лист.');
    } catch { message.error('Не удалось разобрать файл.'); }
  };
  const currentSheet = sheets.find((item) => item.name === sheetName);
  const createImportDraft = async () => {
    if (!file || !currentSheet || !activeWarehouseId || importRows.length === 0) return;
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const fileSha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    setOperationBusy(true);
    const actionId = `import:${fileSha256}:${currentSheet.name}:${importType}:${importDate}`;
    if (retryActionId.current !== actionId) { retryActionId.current = actionId; retryKey.current = undefined; }
    try {
    const created = await inventoryApi.createImport({
      docType: importType, warehouseId: activeWarehouseId, docDate: importDate, fileName: file.name, fileSha256,
      sheetName: currentSheet.name, rows: importRows.map((row) => ({ ...row })),
    }, retryKey.current ?? (retryKey.current = createInventoryIdempotencyKey()));
    setSelectedDoc(created); setImportOpen(false); setImportRows([]); setFile(undefined); retryKey.current = undefined; retryActionId.current = undefined;
    await queryClient.invalidateQueries({ queryKey: ['inventory'] });
    } catch (error) { message.error(apiError(error).message ?? 'Не удалось создать черновик. Повторите запрос.'); }
    finally { setOperationBusy(false); }
  };
  const balanceColumns = [
    { title: 'Плёнка', dataIndex: 'filmName', key: 'filmName' }, { title: 'Поставщик', dataIndex: 'vendorName', key: 'vendorName', render: (value: string | null) => value ?? '—' },
    { title: 'Остаток, пог. м', dataIndex: 'quantity', key: 'quantity', align: 'right' as const, render: (value: number) => formatQuantity(value) },
    { title: 'Последнее движение', dataIndex: 'lastMovementAt', key: 'lastMovementAt', render: (value: string | null) => value ? new Date(value).toLocaleString('ru-RU') : '—' },
  ];
  const documentColumns = [
    { title: '№', dataIndex: 'documentId', key: 'documentId' }, { title: 'Дата', dataIndex: 'docDate', key: 'docDate' },
    { title: 'Тип', dataIndex: 'docType', key: 'docType', render: (value: StockDocType) => docTypeName[value] },
    { title: 'Статус', dataIndex: 'status', key: 'status', render: (value: keyof typeof statusName) => statusName[value] },
    { title: 'Строк', dataIndex: 'linesCount', key: 'linesCount' }, { title: 'Количество, пог. м', dataIndex: 'totalQuantity', key: 'totalQuantity', render: (value: number) => formatQuantity(value) },
    { title: 'Заказ', dataIndex: 'orderName', key: 'orderName', render: (value: string | null, row: StockDocumentSummaryDto) => value ?? (row.orderId ? `№${row.orderId}` : '—') },
  ];
  if (!viewAllowed) return <Alert type="error" message="Нет доступа к складу плёнки" />;
  return <div className="film-inventory-page">
    <Title level={2}>Остатки плёнки</Title>
    <Tabs activeKey={tab} onChange={setTab} items={[
      { key: 'balances', label: 'Остатки', children: <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select placeholder="Склад" value={activeWarehouseId} style={{ minWidth: 180 }} options={(warehousesQuery.data?.items ?? []).map((item) => ({ value: item.warehouseId, label: item.name }))} onChange={setWarehouseId} />
          <Select allowClear placeholder="Поставщик" style={{ minWidth: 200 }} value={vendorId} options={vendors.map(([value, label]) => ({ value, label }))} onChange={setVendorId} />
          <Input.Search allowClear placeholder="Поиск плёнки" value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: 240 }} />
          <Checkbox checked={nonZero} onChange={(event) => setNonZero(event.target.checked)}>Только ненулевые</Checkbox>
          <Checkbox checked={negative} onChange={(event) => setNegative(event.target.checked)}>Только отрицательные</Checkbox>
          {manageAllowed && <><Button type="primary" onClick={() => setManualType('receipt')}>Приход</Button><Button onClick={() => setManualType('writeoff')}>Списание</Button><Button onClick={() => setManualType('inventory')}>Инвентаризация</Button><Button onClick={() => setImportOpen(true)}>Импорт остатков</Button></>}
          <Button onClick={() => { void exportBalances().catch(() => message.error('Не удалось выгрузить остатки')); }}>Выгрузить XLSX</Button>
        </Space>
        <Table rowKey="filmId" dataSource={balances} columns={balanceColumns} loading={balancesQuery.isLoading} pagination={{ current: balancePage.current, pageSize: balancePage.pageSize, total: balancesQuery.data?.total ?? 0, showSizeChanger: true, onChange: (current, pageSize) => setBalancePage({ current, pageSize }) }} rowClassName={(row) => row.quantity < 0 ? 'film-stock-negative' : ''} summary={() => <Table.Summary.Row><Table.Summary.Cell index={0} colSpan={2}><Text strong>Итого</Text></Table.Summary.Cell><Table.Summary.Cell index={2} align="right"><Text strong>{formatQuantity(balancesQuery.data?.totalQuantity ?? 0)}</Text></Table.Summary.Cell><Table.Summary.Cell index={3}>{balancesQuery.data?.total ?? balances.length} позиций</Table.Summary.Cell></Table.Summary.Row>} />
      </Card> },
      { key: 'documents', label: 'Документы', children: <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select allowClear placeholder="Тип" value={docTypeFilter} onChange={setDocTypeFilter} options={Object.entries(docTypeName).map(([value, label]) => ({ value, label }))} />
          <Select allowClear placeholder="Статус" value={docStatusFilter} onChange={setDocStatusFilter} options={Object.entries(statusName).map(([value, label]) => ({ value, label }))} />
          <DatePicker.RangePicker onChange={(dates) => setDocDateRange(dates ? [dates[0]?.format('YYYY-MM-DD'), dates[1]?.format('YYYY-MM-DD')] : undefined)} />
          <InputNumber min={1} placeholder="ID плёнки" value={docFilmId} onChange={(value) => setDocFilmId(value ?? undefined)} />
          <InputNumber min={1} placeholder="ID заказа" value={docOrderId} onChange={(value) => setDocOrderId(value ?? undefined)} />
        </Space>
        <Table rowKey="documentId" dataSource={documentsQuery.data?.items ?? []} columns={documentColumns} loading={documentsQuery.isLoading} onRow={(row) => ({ onClick: () => void openDocument(row.documentId), style: { cursor: 'pointer' } })} pagination={{ current: docPage.current, pageSize: docPage.pageSize, total: documentsQuery.data?.total ?? 0, showSizeChanger: true, onChange: (current, pageSize) => setDocPage({ current, pageSize }) }} />
      </Card> },
    ]} />

    <Modal title={manualType ? docTypeName[manualType] : ''} open={Boolean(manualType)} onCancel={() => setManualType(undefined)} onOk={() => void createManual()} confirmLoading={operationBusy} width={720} okText="Провести">
      <Form form={manualForm} layout="vertical" initialValues={{ docDate: undefined, lines: [{ quantity: 0 }] }}>
        <Form.Item label="Дата" name="docDate" rules={[{ required: true }]}><DatePicker format="DD.MM.YYYY" /></Form.Item>
        {manualType === 'writeoff' && <Form.Item label="Заказ (необязательно)" name="orderId"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>}
        <Form.List name="lines">{(fields, { add, remove }) => <>{fields.map(({ key, name, ...rest }) => <Space key={key} align="baseline">
          <Form.Item {...rest} name={[name, 'filmId']} rules={[{ required: true }]}><Select showSearch placeholder="Активная плёнка" optionFilterProp="label" style={{ minWidth: 360 }} options={activeFilmOptions} /></Form.Item>
          <Form.Item {...rest} name={[name, 'quantity']} rules={[{ required: true }]}><InputNumber min={manualType === 'inventory' ? 0 : 0.01} precision={2} placeholder="Пог. м" /></Form.Item><Button onClick={() => remove(name)}>Удалить</Button>
        </Space>)}<Button onClick={() => add({ quantity: 0 })}>Добавить строку</Button></>}</Form.List>
        <Form.Item label="Комментарий" name="comment"><Input.TextArea maxLength={2000} /></Form.Item>
      </Form>
    </Modal>

    <Modal title="Импорт остатков" open={importOpen} onCancel={() => setImportOpen(false)} onOk={() => void createImportDraft()} okText="Создать черновик" confirmLoading={operationBusy} width={860}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Upload beforeUpload={(uploadFile: RcFile) => { void acceptFile(uploadFile); return false; }} showUploadList={false}><Button>Выбрать файл XLSX / XLS / CSV</Button></Upload>
        {file && <Text>{file.name}</Text>}
        {sheets.length > 1 && <><Alert type="warning" message="Выберите лист с исходными строками. Лист «Свод» может объединять строки." /><Select value={sheetName} onChange={(value) => { setSheetName(value); setImportRows(sheets.find((sheet) => sheet.name === value)?.rows ?? []); }} options={sheets.map((sheet) => ({ value: sheet.name, label: `${sheet.name}${sheet.hasName && sheet.hasSupplier ? '' : ' (нет нужных колонок)'}` }))} style={{ width: 320 }} /></>}
        <Space><Select value={importType} onChange={setImportType} options={[{ value: 'receipt', label: 'Приход' }, { value: 'inventory', label: 'Инвентаризация' }]} /><Input type="date" value={importDate} onChange={(event) => setImportDate(event.target.value)} /></Space>
        {importRows.length > 0 && <><Text>{importRows.length} строк готовы к проверке</Text><Table size="small" rowKey="rowNo" pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }} dataSource={importRows} columns={[{ title: 'Строка', dataIndex: 'rowNo' }, { title: 'Плёнка', dataIndex: 'name' }, { title: 'Поставщик', dataIndex: 'supplier' }, { title: 'Количество', dataIndex: 'quantity', render: (value: string | null) => value ?? 'Разберёт backend' }, { title: 'Сопоставление', render: () => <Tag>Предварительно</Tag> }]} /></>}
      </Space>
    </Modal>

    <Modal title={`Документ №${selectedDoc?.documentId ?? ''}`} open={Boolean(selectedDoc)} onCancel={() => setSelectedDoc(undefined)} footer={selectedDoc?.status === 'draft' && manageAllowed ? <Space><Button onClick={() => { if (selectedDoc.previousPostedDocumentId) { Modal.confirm({ title: 'Этот файл уже проводился', content: `Документ №${selectedDoc.previousPostedDocumentId} с тем же файлом уже проведён. Провести ещё раз?`, okText: 'Провести', cancelText: 'Отмена', onOk: () => postSelectedDocument() }); } else void postSelectedDocument(); }}>Провести</Button><Button danger onClick={() => void runCommand(async (key) => { const cancelled = await inventoryApi.cancel(selectedDoc.documentId, selectedDoc.version, key); await refreshDocument(cancelled); }, `cancel:${selectedDoc.documentId}:${selectedDoc.version}`)}>Отменить</Button></Space> : null} width={900}>
      {selectedDoc && <><Space wrap><Tag>{docTypeName[selectedDoc.docType]}</Tag><Tag>{statusName[selectedDoc.status]}</Tag><Text>{selectedDoc.docDate}</Text><Text>{selectedDoc.fileName}</Text></Space>
        {selectedDoc.previousPostedDocumentId && <Alert type="warning" message={`Этот файл уже проводился (документ №${selectedDoc.previousPostedDocumentId})`} action={<Button size="small" onClick={() => void openDocument(selectedDoc.previousPostedDocumentId!)}>Открыть</Button>} />}
        {selectedDoc.negativeAfter.length > 0 && <Alert type="warning" message="После проведения появятся отрицательные остатки" description={selectedDoc.negativeAfter.map((row) => `${row.filmName}: ${formatQuantity(row.after)} м`).join('; ')} />}
        {selectedDoc.unresolved.length > 0 && <Alert type="error" message="Есть неразрешённые строки. Сопоставьте плёнку и количество перед проведением." />}
        <Table size="small" rowKey="lineId" dataSource={selectedDoc.lines} rowClassName={(line) => unresolvedLineIds(selectedDoc).has(line.lineId) ? 'film-stock-unresolved' : ''} columns={[
          { title: '№', dataIndex: 'lineNo' }, { title: 'Плёнка', render: (_: unknown, line: StockDocumentDto['lines'][number]) => line.filmName ?? line.rawName ?? '—' },
          { title: 'Поставщик', dataIndex: 'rawSupplier', render: (value: string | null) => value ?? '—' }, { title: 'Статус', render: (_: unknown, line: StockDocumentDto['lines'][number]) => `${line.matchStatus} / ${line.quantityStatus}${line.issue ? ` · ${line.issue}` : ''}` },
          { title: 'Кол-во', render: (_: unknown, line: StockDocumentDto['lines'][number]) => line.quantity == null ? line.rawQuantity ?? '—' : formatQuantity(line.quantity) },
          { title: 'Было → станет → Δ', render: (_: unknown, line: StockDocumentDto['lines'][number]) => `${formatQuantity(line.balanceBefore)} → ${formatQuantity(line.balanceAfter)} → ${formatQuantity((line.balanceAfter ?? 0) - (line.balanceBefore ?? 0))}` },
          { title: 'Действия', render: (_: unknown, line: StockDocumentDto['lines'][number]) => selectedDoc.status !== 'draft' || !manageAllowed ? null : <Space wrap>
            {(line.matchStatus === 'suggested' || line.matchStatus === 'unmatched') && <><Select showSearch optionFilterProp="label" placeholder="Выбрать плёнку" style={{ width: 360 }} dropdownMatchSelectWidth={false} value={lineFilmValue(line)} options={lineFilmOptions(line, activeFilmOptions)} onChange={(filmId: number) => void runCommand(async (key) => refreshDocument(await inventoryApi.patchLine(selectedDoc.documentId, line.lineId, { version: selectedDoc.version, filmId }, key)), `line:${selectedDoc.documentId}:${line.lineId}:film:${filmId}`)} />{line.suggestions[0] && <Button size="small" type="primary" onClick={() => void runCommand(async (key) => refreshDocument(await inventoryApi.patchLine(selectedDoc.documentId, line.lineId, { version: selectedDoc.version, filmId: line.suggestions[0].filmId, confirmMatch: true }, key)), `line:${selectedDoc.documentId}:${line.lineId}:confirmMatch`)}>Подтвердить</Button>}</>}
            {line.matchStatus !== 'skipped' && <><InputNumber size="small" min={selectedDoc.docType === 'inventory' ? 0 : 0.01} precision={2} defaultValue={line.quantity ?? undefined} onBlur={(event) => { const quantity = Number(event.target.value); if (Number.isFinite(quantity) && quantity >= (selectedDoc.docType === 'inventory' ? 0 : 0.01) && quantity !== line.quantity) void runCommand(async (key) => refreshDocument(await inventoryApi.patchLine(selectedDoc.documentId, line.lineId, { version: selectedDoc.version, quantity, confirmQuantity: true }, key)), `line:${selectedDoc.documentId}:${line.lineId}:quantity:${quantity}`); }} /><Button size="small" onClick={() => void runCommand(async (key) => refreshDocument(await inventoryApi.patchLine(selectedDoc.documentId, line.lineId, { version: selectedDoc.version, confirmQuantity: true }, key)), `line:${selectedDoc.documentId}:${line.lineId}:confirmQuantity`)}>Подтвердить количество</Button></>}
            <Button size="small" onClick={() => void runCommand(async (key) => refreshDocument(await inventoryApi.patchLine(selectedDoc.documentId, line.lineId, { version: selectedDoc.version, skip: true }, key)), `line:${selectedDoc.documentId}:${line.lineId}:skip`)}>Пропустить</Button>
          </Space> },
        ]} pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }} />
        {selectedDoc.movements.length > 0 && <Table size="small" rowKey={(row) => `${row.filmId}-${row.movementType}`} dataSource={selectedDoc.movements} columns={[{ title: 'Плёнка', dataIndex: 'filmName' }, { title: 'Движение', dataIndex: 'movementType' }, { title: 'Δ', dataIndex: 'delta', render: formatQuantity }, { title: 'Было', dataIndex: 'balanceBefore', render: formatQuantity }, { title: 'Стало', dataIndex: 'balanceAfter', render: formatQuantity }]} pagination={false} />}
      </>}
    </Modal>
  </div>;
};
