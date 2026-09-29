import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGetIdentity } from '@refinedev/core';
import { useParams } from 'react-router-dom';
import { Button, Card, Checkbox, Col, Input, message, Modal, Result, Row, Select, Space, Spin, Statistic, Tabs, Tag, Typography, Upload } from 'antd';
import type { UploadProps } from 'antd';
import { UploadOutlined, ReloadOutlined } from '@ant-design/icons';
import { useSelect } from '../../../ui/refineSelect';
import { Table } from '../../../ui/tooltipDelay';
import { getLoadedRuntimeConfig } from '../../../config/runtimeConfig';
import { filmCatalogImportApi } from '../../../api/filmCatalogImportApi';
import type { CatalogImportAction, CatalogImportBatchDto, CatalogImportMatchDto, CatalogImportRowDto, CatalogSourceKind } from '../../../api/types/filmCatalogImportApi.types';
import { catalogImportActions, catalogImportErrorMessage, catalogMatchQuery, catalogRowsQuery, importManageAllowed, inspectCatalogSheets, onecMirrorAllowed, resolveIdempotencyKey, sha256File, vendorMappingAction, type CatalogSheetPreview, serverPagination } from './catalogImportHelpers';

const PAGE_SIZE = 50;
const STATUS_LABELS: Record<string, string> = { draft: 'Черновик', applied: 'Применён', cancelled: 'Отменён', reverted: 'Откатан' };

export const CatalogImportPage: React.FC = () => {
  const { id: rawId } = useParams<{ id?: string }>();
  const batchId = rawId ? Number(rawId) : null;
  const { data: identity, isLoading: identityLoading } = useGetIdentity<{ permissions?: string[] }>();
  const permissions = identity?.permissions;
  const allowed = importManageAllowed(permissions);
  const canUseMirror = onecMirrorAllowed(permissions);
  const featureEnabled = getLoadedRuntimeConfig()?.features?.filmCatalogImport === true;
  const [batch, setBatch] = useState<CatalogImportBatchDto | null>(null);
  const [journal, setJournal] = useState<CatalogImportBatchDto[]>([]);
  const [matches, setMatches] = useState<CatalogImportMatchDto[]>([]);
  const [rows, setRows] = useState<CatalogImportRowDto[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sourceKind, setSourceKind] = useState<CatalogSourceKind>('file');
  const [previewSheets, setPreviewSheets] = useState<CatalogSheetPreview[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mirrorSources, setMirrorSources] = useState<Array<{ sourceId: number; name: string }>>([]);
  const [mirrorCategories, setMirrorCategories] = useState<Array<{ key: string; name: string; itemsCount: number }>>([]);
  const [mirrorSourceId, setMirrorSourceId] = useState<number>();
  const [mirrorCategoryKey, setMirrorCategoryKey] = useState<string>();
  const [matchStatus, setMatchStatus] = useState<string>();
  const [matchVendorId, setMatchVendorId] = useState<number>();
  const [matchSearch, setMatchSearch] = useState('');
  const [matchOffset, setMatchOffset] = useState(0);
  const [matchPageSize, setMatchPageSize] = useState(PAGE_SIZE);
  const [rowStatus, setRowStatus] = useState<string>();
  const [rowSearch, setRowSearch] = useState('');
  const [rowOffset, setRowOffset] = useState(0);
  const [rowPageSize, setRowPageSize] = useState(PAGE_SIZE);
  const [conflictOnly, setConflictOnly] = useState(false);
  const [propertyChoices, setPropertyChoices] = useState<Record<number, { filmTexture?: boolean; filmTypeId?: number }>>({});
  const pendingKey = useRef<{ signature: string; key: string } | null>(null);
  const { selectProps: vendorSelectProps } = useSelect({ resource: 'vendors', optionLabel: 'vendor_name', optionValue: 'vendor_id', pagination: { mode: 'server' }, filters: [{ field: 'is_active', operator: 'eq', value: true }] });
  const { selectProps: filmSelectProps } = useSelect({ resource: 'films', optionLabel: 'film_name', optionValue: 'film_id', pagination: { mode: 'server' }, filters: [{ field: 'is_active', operator: 'eq', value: true }] });
  const { selectProps: filmTypeSelectProps } = useSelect({ resource: 'film_types', optionLabel: 'film_type_name', optionValue: 'film_type_id', pagination: { mode: 'server' } });

  const reportError = useCallback((error: unknown) => {
    const formatted = catalogImportErrorMessage(error);
    message.error(formatted.message);
    if (formatted.details.length) Modal.error({ title: formatted.message, content: <ul>{formatted.details.map((line, index) => <li key={index}>{line}</li>)}</ul> });
    if (formatted.reload && batchId) {
      void Promise.all([filmCatalogImportApi.get(batchId), filmCatalogImportApi.matches(batchId, { offset: 0, limit: matchPageSize }), filmCatalogImportApi.rows(batchId, { offset: 0, limit: rowPageSize })])
        .then(([freshBatch, freshMatches, freshRows]) => { setBatch(freshBatch); setMatches(freshMatches.items); setTotalMatches(freshMatches.total); setMatchOffset(0); setRows(freshRows.items); setTotalRows(freshRows.total); setRowOffset(0); })
        .catch(() => undefined);
    }
  }, [batchId, matchPageSize, rowPageSize]);

  const loadBatch = useCallback(async (id: number) => {
    setBusy(true);
    try { setBatch(await filmCatalogImportApi.get(id)); }
    catch (error) { reportError(error); }
    finally { setBusy(false); }
  }, [reportError]);

  const loadJournal = useCallback(async () => {
    try { setJournal((await filmCatalogImportApi.list()).items); } catch (error) { reportError(error); }
  }, [reportError]);

  const loadMatches = useCallback(async () => {
    if (!batchId) return;
    try {
      const result = await filmCatalogImportApi.matches(batchId, catalogMatchQuery({ status: matchStatus, vendorId: matchVendorId, search: matchSearch, offset: matchOffset, limit: matchPageSize }));
      setMatches(result.items); setTotalMatches(result.total);
    } catch (error) { reportError(error); }
  }, [batchId, matchStatus, matchVendorId, matchSearch, matchOffset, matchPageSize, reportError]);

  const loadRows = useCallback(async () => {
    if (!batchId) return;
    try {
      const result = await filmCatalogImportApi.rows(batchId, catalogRowsQuery({ status: rowStatus, conflict: conflictOnly, search: rowSearch, offset: rowOffset, limit: rowPageSize }));
      setRows(result.items); setTotalRows(result.total);
    } catch (error) { reportError(error); }
  }, [batchId, rowStatus, conflictOnly, rowSearch, rowOffset, rowPageSize, reportError]);

  useEffect(() => {
    if (!allowed || !featureEnabled) return;
    if (batchId) void loadBatch(batchId); else { setBatch(null); void loadJournal(); }
  }, [allowed, featureEnabled, batchId, loadBatch, loadJournal]);
  useEffect(() => { if (allowed && featureEnabled) void loadMatches(); }, [allowed, featureEnabled, loadMatches]);
  useEffect(() => { if (allowed && featureEnabled) void loadRows(); }, [allowed, featureEnabled, loadRows]);
  useEffect(() => {
    if (!canUseMirror || !allowed || !featureEnabled) return;
    void filmCatalogImportApi.onecSources().then((result) => setMirrorSources(result.items)).catch(reportError);
  }, [canUseMirror, allowed, featureEnabled, reportError]);
  useEffect(() => {
    if (!mirrorSourceId || !canUseMirror || !allowed || !featureEnabled) { setMirrorCategories([]); return; }
    void filmCatalogImportApi.onecCategories(mirrorSourceId).then((result) => setMirrorCategories(result.items)).catch(reportError);
  }, [mirrorSourceId, canUseMirror, allowed, featureEnabled, reportError]);
  useEffect(() => {
    if (canUseMirror) return;
    setSourceKind('file'); setMirrorSourceId(undefined); setMirrorCategoryKey(undefined);
  }, [canUseMirror]);

  const currentPreview = previewSheets.find((sheet) => sheet.name === selectedSheet);
  const keyFor = (signature: string) => {
    pendingKey.current = resolveIdempotencyKey(pendingKey.current, signature, () => crypto.randomUUID());
    return pendingKey.current.key;
  };
  const clearKey = (signature: string) => { if (pendingKey.current?.signature === signature) pendingKey.current = null; };
  const command = async (signature: string, action: (key: string) => Promise<CatalogImportBatchDto>) => {
    if (busy) return;
    if (!batch) return;
    const intentSignature = `${batch.id}:${batch.version}:${signature}`;
    const key = keyFor(intentSignature);
    setBusy(true);
    try { const updated = await action(key); clearKey(intentSignature); setBatch(updated); await Promise.all([loadMatches(), loadRows()]); message.success('Изменения сохранены'); }
    catch (error) { reportError(error); }
    finally { setBusy(false); }
  };
  const mutate = (actions: CatalogImportAction[], signature: string) => command(signature, (key) => filmCatalogImportApi.patch(batch!.id, batch!.version, actions, key));

  const parseFile: UploadProps['beforeUpload'] = async (file) => {
    if (!/\.(xlsx|xls)$/i.test(file.name)) { message.error('Выберите файл .xlsx или .xls'); return Upload.LIST_IGNORE; }
    if (file.size > 5 * 1024 * 1024) { message.error('Файл превышает 5 МБ'); return Upload.LIST_IGNORE; }
    setBusy(true); setSelectedFile(file);
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellText: true, cellDates: false });
      const previews = inspectCatalogSheets(workbook.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, raw: false, defval: null }) })));
      setPreviewSheets(previews); setSelectedSheet(previews.length === 1 ? previews[0].name : undefined);
      if (!previews.length) message.warning('Подходящий каталог с обязательными заголовками не найден');
    } catch { setPreviewSheets([]); message.error('Не удалось прочитать Excel файл'); }
    finally { setBusy(false); }
    return false;
  };

  const createDraft = async () => {
    if (sourceKind === 'file') {
      if (!selectedFile || !currentPreview) return;
      const fileSha256 = await sha256File(selectedFile);
      const sig = `create-file:${selectedFile.name}:${fileSha256}:${selectedSheet}`;
      const key = keyFor(sig); setBusy(true);
      try {
        const batch = await filmCatalogImportApi.createFile({ kind: 'films', source: 'file', fileName: selectedFile.name,
          fileSha256, sheetName: currentPreview.name, rows: currentPreview.rows }, key);
        clearKey(sig); window.location.assign(`/films/catalog-import/${batch.id}`);
      } catch (error) { reportError(error); } finally { setBusy(false); }
    } else if (mirrorSourceId && mirrorCategoryKey) {
      const sig = `create-mirror:${mirrorSourceId}:${mirrorCategoryKey}`; const key = keyFor(sig); setBusy(true);
      try { const result = await filmCatalogImportApi.createMirror({ kind: 'films', source: 'onec_mirror', onecSourceId: mirrorSourceId, categoryKey: mirrorCategoryKey }, key); clearKey(sig); window.location.assign(`/films/catalog-import/${result.id}`); }
      catch (error) { reportError(error); } finally { setBusy(false); }
    }
  };

  const revertFromJournal = async (item: CatalogImportBatchDto) => {
    const signature = `revert:${item.id}`;
    const key = keyFor(signature); setBusy(true);
    try { await filmCatalogImportApi.revert(item.id, key); clearKey(signature); message.success('Пакет откачен'); await loadJournal(); }
    catch (error) { reportError(error); }
    finally { setBusy(false); }
  };

  const openExport = async () => {
    if (!batchId) return;
    try { const { blob, fileName } = await filmCatalogImportApi.export(batchId); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = fileName ?? `film-catalog-${batchId}.xlsx`; link.click(); URL.revokeObjectURL(url); }
    catch (error) { reportError(error); }
  };

  const matchColumns = useMemo(() => [
    { title: 'Плёнка ERP', dataIndex: 'filmName', key: 'film', render: (_: unknown, row: CatalogImportMatchDto) => <>{row.filmName}<br /><Typography.Text type="secondary">{row.vendorName ?? '—'} · {row.matchStatus}</Typography.Text></> },
    { title: 'Использование', dataIndex: ['usage', 'details'], key: 'usage' },
    { title: 'Сопоставление', key: 'action', render: (_: unknown, row: CatalogImportMatchDto) => <Space>
      {row.matchStatus === 'suggested' && <Select style={{ width: 300 }} placeholder="Выберите строку каталога" options={[{ value: 0, label: 'Нет соответствия' }, ...row.candidates.map((item) => ({ value: item.rowId, label: `${item.targetName} · ${Math.round(item.score * 100)}%` }))]} onChange={(value: number) => void mutate([catalogImportActions.setMatch(row.filmId, value === 0 ? null : value)], `match:${row.filmId}:${value || 'none'}`)} />}
      {['suggested', 'auto'].includes(row.matchStatus) && <Button onClick={() => void mutate([catalogImportActions.confirmMatch(row.filmId)], `confirm:${row.filmId}`)}>Подтвердить</Button>}
      {['none', 'unchanged'].includes(row.matchStatus) && <Select showSearch filterOption={false} onSearch={(value) => { setRowSearch(value); setRowOffset(0); }} allowClear style={{ width: 300 }} placeholder="Строка каталога / нет соответствия" options={rows.map((item) => ({ value: item.rowId, label: item.targetName }))} onChange={(value: number | undefined) => void mutate([catalogImportActions.setMatch(row.filmId, value ?? null)], `match:${row.filmId}:${value ?? 'none'}`)} />}
    </Space> },
  ], [filmSelectProps, mutate]);

  const chooseCanonicalProperty = (row: CatalogImportRowDto, value: { filmTexture?: boolean; filmTypeId?: number }) => {
    const next = { ...(propertyChoices[row.rowId] ?? {}), ...value };
    setPropertyChoices((current) => ({ ...current, [row.rowId]: next }));
    const filmTexture = next.filmTexture ?? row.canonicalFilmTexture;
    const filmTypeId = next.filmTypeId ?? row.canonicalFilmTypeId;
    if (filmTexture !== null && filmTexture !== undefined && filmTypeId !== null && filmTypeId !== undefined) {
      void mutate([catalogImportActions.setCanonicalProperties(row.rowId, filmTexture, filmTypeId)], `properties:${row.rowId}:${filmTexture}:${filmTypeId}`);
    }
  };

  const rowColumns = [
    { title: 'Строка', dataIndex: 'rowNo' }, { title: 'Наименование', dataIndex: 'targetName' },
    { title: 'Статус', dataIndex: 'rowStatus', render: (status: string, row: CatalogImportRowDto) => <>{status}{row.issue && <Typography.Text type="danger"> — {row.issue}</Typography.Text>}</> },
    { title: 'Сопоставленные плёнки', dataIndex: 'matchedFilmIds', render: (_: unknown, row: CatalogImportRowDto) => <Space>
      {row.matchedFilmIds.map((filmId) => <Tag key={filmId}>{filmId}</Tag>)}
      {row.matchedFilmIds.length > 1 && <Select style={{ width: 220 }} placeholder="Выбрать канон" value={row.canonicalFilmId ?? undefined} options={row.matchedFilmIds.map((filmId) => ({ value: filmId, label: matches.find((match) => match.filmId === filmId)?.filmName ?? filmSelectProps.options?.find((option) => option.value === filmId)?.label ?? `Плёнка ${filmId}` }))} onChange={(filmId: number) => void mutate([catalogImportActions.setCanonical(row.rowId, filmId)], `canonical:${row.rowId}:${filmId}`)} />}
      {row.propertyConflict && <Space><Select placeholder="Фактура" value={propertyChoices[row.rowId]?.filmTexture ?? row.canonicalFilmTexture ?? undefined} options={[{ value: true, label: 'Да' }, { value: false, label: 'Нет' }]} onChange={(filmTexture: boolean) => chooseCanonicalProperty(row, { filmTexture })} /><Select placeholder="Тип плёнки" {...filmTypeSelectProps} value={propertyChoices[row.rowId]?.filmTypeId ?? row.canonicalFilmTypeId ?? undefined} onChange={(filmTypeId: number) => chooseCanonicalProperty(row, { filmTypeId })} /></Space>}
    </Space> },
  ];

  if (identityLoading) return <Spin />;
  if (!featureEnabled) return <Result status="404" title="Импорт каталога отключён" />;
  if (!allowed) return <Result status="403" title="Недостаточно прав" />;

  if (!batchId) return <Card title="Импорт каталога 1С" extra={<Button icon={<ReloadOutlined />} onClick={() => void loadJournal()}>Обновить</Button>}>
    <Card type="inner" title="Новый черновик">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select value={sourceKind} onChange={setSourceKind} options={[{ value: 'file', label: 'Файл' }, ...(canUseMirror ? [{ value: 'onec_mirror' as const, label: 'Зеркало 1С' }] : [])]} />
        {sourceKind === 'file' ? <>
          <Upload beforeUpload={parseFile} maxCount={1} accept=".xlsx,.xls"><Button icon={<UploadOutlined />}>Выбрать .xlsx/.xls</Button></Upload>
          {previewSheets.length > 1 && <Select placeholder="Выберите лист с каталогом" value={selectedSheet} onChange={setSelectedSheet} options={previewSheets.map((sheet) => ({ value: sheet.name, label: sheet.name }))} />}
          {currentPreview && <Typography.Text>Лист {currentPreview.name}: строк {currentPreview.rows.length}, ошибок {currentPreview.errorCount}</Typography.Text>}
        </> : <Row gutter={8}><Col span={12}><Select style={{ width: '100%' }} placeholder="Источник 1С" value={mirrorSourceId} onChange={setMirrorSourceId} options={mirrorSources.map((item) => ({ value: item.sourceId, label: item.name }))} /></Col><Col span={12}><Select style={{ width: '100%' }} placeholder="Категория" value={mirrorCategoryKey} onChange={setMirrorCategoryKey} options={mirrorCategories.map((item) => ({ value: item.key, label: `${item.name} (${item.itemsCount})` }))} /></Col></Row>}
        <Button type="primary" loading={busy} disabled={sourceKind === 'file' ? !currentPreview : !mirrorSourceId || !mirrorCategoryKey} onClick={() => void createDraft()}>Создать черновик</Button>
      </Space>
    </Card>
    <Table rowKey="id" dataSource={journal} pagination={false} columns={[
      { title: 'Пакет', dataIndex: 'id' }, { title: 'Источник', dataIndex: 'sourceKind', render: (kind: string) => kind === 'file' ? 'Файл' : 'Зеркало 1С' },
      { title: 'Статус', dataIndex: 'status', render: (status: string) => STATUS_LABELS[status] }, { title: 'Строк', dataIndex: ['counters', 'rows'] },
      { title: 'Создан', dataIndex: 'createdAt', render: (value: string) => value.slice(0, 16).replace('T', ' ') },
      { title: '', render: (_: unknown, item: CatalogImportBatchDto) => <Space><Button href={`/films/catalog-import/${item.id}`}>Открыть</Button>{item.status === 'applied' && <Button danger loading={busy} onClick={() => void revertFromJournal(item)}>Откатить</Button>}</Space> },
    ]} />
  </Card>;

  if (!batch) return <Card loading={busy}>Пакет импорта не найден</Card>;
  const sourceName = batch.fileName ?? batch.onecCategoryName ?? `Пакет ${batch.id}`;
  return <Card title={`Пакет ${batch.id} · ${sourceName}`} extra={<Space><Tag color={batch.status === 'applied' ? 'green' : 'blue'}>{STATUS_LABELS[batch.status]}</Tag><Button icon={<ReloadOutlined />} onClick={() => void loadBatch(batch.id)}>Обновить</Button></Space>}>
    <Spin spinning={busy}>
      <Tabs items={[
        { key: 'vendors', label: `Поставщики (${batch.vendorMappings.length})`, children: <Table rowKey="supplierNorm" pagination={false} dataSource={batch.vendorMappings} columns={[
          { title: 'Поставщик из каталога', dataIndex: 'supplier' }, { title: 'Строк', dataIndex: 'rowsCount' },
          { title: 'Поставщик ERP', render: (_: unknown, item) => <Select style={{ width: 320 }} showSearch placeholder="Выбрать ERP или создать" {...vendorSelectProps} options={[...(vendorSelectProps.options ?? []), { value: 0, label: 'Создать нового поставщика' }]} value={item.createVendor ? 0 : item.vendorId ?? undefined} onChange={(vendorId: number) => void mutate([vendorMappingAction(item.supplierNorm, vendorId === 0 ? null : vendorId)], `vendor:${item.supplierNorm}:${vendorId || 'create'}`)} /> },
        ]} /> },
        { key: 'matches', label: `Сопоставления (${totalMatches})`, children: <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap><Select allowClear placeholder="Статус" style={{ width: 160 }} value={matchStatus} onChange={(value) => { setMatchStatus(value); setMatchOffset(0); }} options={['linked','auto','suggested','confirmed','manual','none','unchanged'].map((value) => ({ value, label: value }))} /><Select allowClear placeholder="Поставщик" style={{ width: 220 }} {...vendorSelectProps} value={matchVendorId} onChange={(value) => { setMatchVendorId(value); setMatchOffset(0); }} /><Input.Search placeholder="Поиск плёнки" onSearch={(value) => { setMatchSearch(value); setMatchOffset(0); }} style={{ width: 240 }} /><Button onClick={() => void mutate([catalogImportActions.acceptAllAuto()], 'accept-all-auto')}>Принять все уверенные</Button></Space>
          <Table rowKey="filmId" dataSource={matches} columns={matchColumns} pagination={serverPagination(matchOffset, matchPageSize, totalMatches, setMatchOffset, setMatchPageSize)} />
        </Space> },
        { key: 'rows', label: `Позиции каталога (${totalRows})`, children: <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap><Select allowClear placeholder="Статус строки" style={{ width: 180 }} value={rowStatus} onChange={(value) => { setRowStatus(value); setRowOffset(0); }} options={['ok','invalid','skipped'].map((value) => ({ value, label: value }))} /><Checkbox checked={conflictOnly} onChange={(event) => { setConflictOnly(event.target.checked); setRowOffset(0); }}>Разногласия свойств</Checkbox><Input.Search placeholder="Поиск строки каталога" onSearch={(value) => { setRowSearch(value); setRowOffset(0); }} style={{ width: 260 }} /></Space>
          <Table rowKey="rowId" dataSource={rows} columns={rowColumns} pagination={serverPagination(rowOffset, rowPageSize, totalRows, setRowOffset, setRowPageSize)} />
        </Space> },
        { key: 'summary', label: 'Итог и действия', children: <Space direction="vertical" style={{ width: '100%' }}>
          <Row gutter={12}>{Object.entries(batch.counters).map(([key, value]) => <Col key={key} xs={12} md={6}><Statistic title={key} value={value} /></Col>)}</Row>
          {batch.blockers.length > 0 && <Result status="warning" title="Нужно устранить блокеры" subTitle={<ul>{batch.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>} />}
          {batch.status === 'draft' && <Checkbox checked={batch.options.createMissing} onChange={(event) => void mutate([catalogImportActions.setCreateMissing(event.target.checked)], `create-missing:${event.target.checked}`)}>Создавать отсутствующие позиции</Checkbox>}
          <Space wrap><Button onClick={() => void openExport()}>Выгрузить в Excel</Button>{batch.status === 'draft' && <><Button danger onClick={() => void command('cancel', (key) => filmCatalogImportApi.cancel(batch.id, batch.version, key))}>Отменить черновик</Button><Button type="primary" disabled={!batch.canApply} onClick={() => void command('apply', (key) => filmCatalogImportApi.apply(batch.id, batch.version, key))}>Применить</Button></>}</Space>
        </Space> },
      ]} />
    </Spin>
  </Card>;
};
