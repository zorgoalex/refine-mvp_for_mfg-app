import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, DatePicker, Input, Modal, Popconfirm, Select, Space, Tabs, Tag, Typography, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import * as XLSX from 'xlsx';
import { Table, Tooltip } from '../../ui/tooltipDelay';
import { createInventoryIdempotencyKey, inventoryApi } from '../../api/inventoryApi';
import type { InventoryApiError, OnecSnapshotDto, OnecSnapshotItemDto, OnecSnapshotStockDto, OnecSnapshotStockQuery } from '../../api/types/inventoryApi.types';
import {
  deltaTone, exportComplete, formatDelta, formatSnapshotMoment, isSnapshotActive, requestIntent, snapshotCapabilityReason, SNAPSHOT_EXPORT_LIMIT,
  snapshotExportRows, snapshotLabel, snapshotsMode, SNAPSHOT_STATUS_COLOR, SNAPSHOT_STATUS_LABEL, snapshotStatusDetail, toSnapshotMoment,
  viewFailureAction, warehousePlaceholder, warehouseScopeNote, type SnapshotRequestIntent,
} from './onecSnapshots';
import { stockQuantityTone } from './warehouseStock';

const { Text } = Typography;
const formatQuantity = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);
const formatWhen = (value: string) => new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const failureText = (error: unknown, fallback: string) => (error as InventoryApiError | undefined)?.message ?? fallback;
const POLL_MS = 5000;
/** Сколько срезов для сравнения показывается в списке за раз (остальные — поиском по номеру или дате). */
const COMPARE_PAGE = 100;
const SEARCH_DEBOUNCE_MS = 400;

interface Props {
  /** Возможности сервера на момент открытия страницы; дальше берутся из свежего ответа списка. */
  mode: 'readonly' | 'full';
  reason: string | null;
  manageAllowed: boolean;
  /** Склады ERP для фильтра просмотра. */
  warehouseOptions: Array<{ value: number; label: string }>;
  /** Склад страницы — выбран в просмотре по умолчанию. */
  defaultWarehouseId: number | undefined;
  /** Модалка запроса открыта снаружи (кнопка «Срез 1С на дату» рядом с выбором склада). */
  requestOpen: boolean;
  onRequestOpenChange: (open: boolean) => void;
}

/** Вкладка «Срезы 1С»: остатки 1С на выбранный момент — запрос, список, просмотр по складам, сравнение. Только чтение. */
export const OnecSnapshotsTab: React.FC<Props> = ({ mode: initialMode, reason: initialReason, manageAllowed, warehouseOptions, defaultWarehouseId, requestOpen, onRequestOpenChange }) => {
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<number>();
  const [moment, setMoment] = useState<Dayjs | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [existing, setExisting] = useState<OnecSnapshotDto>();
  const [page, setPage] = useState({ current: 1, pageSize: 20 });
  // Ключ идемпотентности закреплён за намерением: повтор после потерянного ответа не создаёт второй срез.
  const intent = useRef<SnapshotRequestIntent | null>(null);
  const refreshAll = () => queryClient.invalidateQueries({ queryKey: ['inventory', 'onec-snapshots'] });

  const listQuery = useQuery({
    queryKey: ['inventory', 'onec-snapshots', 'list', page.current, page.pageSize],
    queryFn: () => inventoryApi.onecSnapshots({ offset: (page.current - 1) * page.pageSize, limit: page.pageSize }),
    keepPreviousData: true,
    // Готовность — опросом: пока на странице есть срез в очереди или в работе.
    refetchInterval: (data) => (data?.items.some(isSnapshotActive) ? POLL_MS : false),
  });
  const snapshots = listQuery.data?.items ?? [];
  // Возможности — из свежего ответа списка (сервер мог выключить или включить запрос срезов после открытия страницы).
  const liveMode = listQuery.data ? snapshotsMode(listQuery.data, false) : initialMode;
  const reason = listQuery.data ? listQuery.data.reason : initialReason;
  const canCommand = liveMode === 'full' && manageAllowed;

  const closeRequest = () => { onRequestOpenChange(false); setExisting(undefined); };
  const request = async (force: boolean) => {
    const momentLocal = toSnapshotMoment(moment);
    if (!momentLocal) { message.warning('Укажите дату и время среза'); return; }
    intent.current = requestIntent(intent.current, momentLocal, force, createInventoryIdempotencyKey);
    setRequesting(true);
    try {
      const snapshot = await inventoryApi.requestOnecSnapshot({ momentLocal, ...(force ? { force: true } : {}) }, intent.current.key);
      intent.current = null;
      await refreshAll();
      // Без «запросить заново» сервер вернул уже готовый срез этого момента — показать его и предложить выбор.
      if (!force && snapshot.status === 'ready') { setExisting(snapshot); return; }
      message.success(`Срез ${snapshotLabel(snapshot)}: ${SNAPSHOT_STATUS_LABEL[snapshot.status].toLowerCase()}`);
      setPage((value) => ({ ...value, current: 1 }));
      closeRequest();
    } catch (error) {
      // Результат неизвестен (сеть) или отказ: намерение и ключ сохраняются — повтор уйдёт с тем же ключом.
      message.error(failureText(error, 'Не удалось запросить срез'));
      await refreshAll();
    } finally { setRequesting(false); }
  };
  const remove = async (snapshot: OnecSnapshotDto) => {
    try {
      await inventoryApi.deleteOnecSnapshot(snapshot.id);
      message.success(snapshot.status === 'requested' ? 'Запрос среза отменён' : 'Срез удалён');
    } catch (error) {
      message.error(failureText(error, 'Не удалось удалить срез'));
    } finally { await refreshAll(); }
  };

  const columns = [
    { title: '№', dataIndex: 'id', key: 'id', width: 70 },
    { title: 'Момент среза', key: 'moment', render: (_: unknown, row: OnecSnapshotDto) => <Space size={6} wrap>
      <Text strong>{formatSnapshotMoment(row.momentLocal)}</Text>
      {!row.currentSource && <Tooltip title="Срез снят с прежней базы 1С. Его можно смотреть и сравнивать со срезами той же базы, но не с текущими остатками."><Tag>прежняя база 1С</Tag></Tooltip>}
    </Space> },
    { title: 'Статус', key: 'status', render: (_: unknown, row: OnecSnapshotDto) => <Space direction="vertical" size={0}>
      <Tag color={SNAPSHOT_STATUS_COLOR[row.status]}>{SNAPSHOT_STATUS_LABEL[row.status]}</Tag>
      {snapshotStatusDetail(row) && <Text type="secondary">{snapshotStatusDetail(row)}</Text>}
    </Space> },
    { title: 'Позиций', dataIndex: 'rowsCount', key: 'rowsCount', align: 'right' as const, render: (value: number | null) => value === null ? '—' : formatQuantity(value) },
    { title: 'Запросил', key: 'requestedBy', render: (_: unknown, row: OnecSnapshotDto) => <Space direction="vertical" size={0}>
      <Text>{row.requestedBy?.name ?? '—'}</Text><Text type="secondary">{formatWhen(row.requestedAt)}</Text>
    </Space> },
    { title: '', key: 'actions', render: (_: unknown, row: OnecSnapshotDto) => <Space size={6}>
      <Button size="small" type="primary" disabled={row.status !== 'ready'} onClick={() => setOpenId(row.id)}>Открыть</Button>
      {manageAllowed && row.status !== 'config_published' && row.status !== 'syncing' && <Popconfirm
        title={row.status === 'requested' ? 'Отменить запрос среза?' : <>Удалить срез {snapshotLabel(row)}?<br /><Text type="secondary">Строки среза будут удалены из ERP. В 1С ничего не меняется.</Text></>}
        okText={row.status === 'requested' ? 'Отменить запрос' : 'Удалить'} cancelText="Не удалять" onConfirm={() => remove(row)}>
        <Button size="small" danger>{row.status === 'requested' ? 'Отменить' : 'Удалить'}</Button>
      </Popconfirm>}
    </Space> },
  ];

  return <Card>
    {openId !== undefined
      ? <SnapshotView key={openId} snapshotId={openId} warehouseOptions={warehouseOptions} defaultWarehouseId={defaultWarehouseId}
        onBack={() => setOpenId(undefined)} onGone={() => { setOpenId(undefined); message.warning('Срез удалён'); void refreshAll(); }} />
      : <>
        <Alert style={{ marginBottom: 12 }} type="info" showIcon message="Срез — остатки 1С на выбранный момент по всем складам. Его считает сама 1С; срез хранится в ERP, пока его не удалят. Остатки и документы склада ERP срез не меняет." />
        {liveMode === 'readonly' && <Alert style={{ marginBottom: 12 }} type="warning" showIcon message={`Новые срезы сейчас не запрашиваются: ${snapshotCapabilityReason(reason)}. Сохранённые срезы доступны.`} />}
        <Space wrap style={{ marginBottom: 12 }}>
          {canCommand && <Button type="primary" onClick={() => onRequestOpenChange(true)}>Запросить срез</Button>}
          <Button onClick={() => void refreshAll()} loading={listQuery.isFetching}>Обновить</Button>
        </Space>
        {listQuery.isError && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={failureText(listQuery.error, 'Не удалось загрузить срезы')} />}
        <Table rowKey="id" size="small" dataSource={snapshots} columns={columns} loading={listQuery.isLoading} locale={{ emptyText: 'Срезов пока нет' }}
          pagination={{ current: page.current, pageSize: page.pageSize, total: listQuery.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [20, 50, 100], hideOnSinglePage: true, onChange: (current, pageSize) => setPage({ current, pageSize }) }} />
      </>}
    <Modal title="Срез остатков 1С на дату" open={requestOpen && canCommand} onCancel={closeRequest} destroyOnClose
      footer={existing
        ? [<Button key="open" type="primary" onClick={() => { setOpenId(existing.id); closeRequest(); }}>Открыть существующий</Button>,
          <Button key="force" loading={requesting} onClick={() => void request(true)}>Запросить заново</Button>,
          <Button key="cancel" onClick={closeRequest}>Отмена</Button>]
        : [<Button key="cancel" onClick={closeRequest}>Отмена</Button>,
          <Button key="ok" type="primary" loading={requesting} onClick={() => void request(false)}>Запросить</Button>]}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <DatePicker showTime={{ format: 'HH:mm' }} format="DD.MM.YYYY HH:mm" placeholder="Дата и время" style={{ width: 220 }} value={moment}
          onChange={(value) => { setMoment(value); setExisting(undefined); }} disabledDate={(current) => current.isAfter(dayjs(), 'day')} />
        <Text type="secondary">Местное время базы 1С. Движения ровно в указанный момент в срез не входят: остатки «на конец дня» — это 00:00 следующего дня.</Text>
        <Text type="secondary">Срез читается из 1С около минуты; во время плановых выгрузок 1С он ждёт в очереди. Один запрос даёт остатки сразу по всем складам.</Text>
        {existing && <Alert type="info" showIcon message={`Срез на этот момент уже есть: ${snapshotLabel(existing)}. Запрашивать заново нужно, только если в 1С провели документы задним числом.`} />}
      </Space>
    </Modal>
  </Card>;
};

/**
 * Просмотр среза: склады, вкладки материалов, фильтры, сравнение с текущими остатками 1С или другим срезом.
 * Заголовок среза читается своей карточкой — независимо от страницы списка (открывается и давний срез).
 */
const SnapshotView: React.FC<{
  snapshotId: number; warehouseOptions: Array<{ value: number; label: string }>;
  defaultWarehouseId: number | undefined; onBack: () => void; onGone: () => void;
}> = ({ snapshotId, warehouseOptions, defaultWarehouseId, onBack, onGone }) => {
  const [warehouseIds, setWarehouseIds] = useState<number[]>(defaultWarehouseId === undefined ? [] : [defaultWarehouseId]);
  const [group, setGroup] = useState('all');
  const [categoryKey, setCategoryKey] = useState<string>();
  const [search, setSearch] = useState('');
  const [nonZero, setNonZero] = useState(true);
  const [negative, setNegative] = useState(false);
  const [changedOnly, setChangedOnly] = useState(false);
  const [compareWith, setCompareWith] = useState<'current' | number>();
  const [page, setPage] = useState({ current: 1, pageSize: 50 });
  const [exporting, setExporting] = useState(false);
  const [candidateInput, setCandidateInput] = useState('');
  // Поиск срезов для сравнения — с задержкой: сервер на каждый запрос перебирает историю срезов.
  const [candidateSearch, setCandidateSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setCandidateSearch(candidateInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [candidateInput]);
  const comparing = compareWith !== undefined;
  const params: OnecSnapshotStockQuery = useMemo(() => ({
    warehouseIds: warehouseIds.join(',') || undefined, group, categoryKey, search: search.trim() || undefined,
    nonZero: nonZero || undefined, negative: negative || undefined, changedOnly: (comparing && changedOnly) || undefined,
  }), [warehouseIds, group, categoryKey, search, nonZero, negative, changedOnly, comparing]);
  useEffect(() => { setPage((value) => ({ ...value, current: 1 })); }, [params, compareWith]);
  useEffect(() => { setCategoryKey(undefined); }, [group]);
  const cardQuery = useQuery({ queryKey: ['inventory', 'onec-snapshots', 'card', snapshotId], queryFn: () => inventoryApi.onecSnapshot(snapshotId), retry: false });
  const snapshot = cardQuery.data?.snapshot;
  const load = (query: OnecSnapshotStockQuery) => compareWith === undefined
    ? inventoryApi.onecSnapshotStock(snapshotId, query) : inventoryApi.compareOnecSnapshot(snapshotId, compareWith, query);
  const stockQuery = useQuery({
    queryKey: ['inventory', 'onec-snapshots', 'stock', snapshotId, compareWith ?? 'none', params, page.current, page.pageSize],
    queryFn: () => load({ ...params, offset: (page.current - 1) * page.pageSize, limit: page.pageSize }),
    enabled: snapshot?.status === 'ready',
    keepPreviousData: true,
    retry: false,
  });
  // Срезы для сравнения — готовые той же базы 1С: базу фильтрует сервер до пагинации, остальное — поиском.
  const candidatesQuery = useQuery({
    queryKey: ['inventory', 'onec-snapshots', 'comparable', snapshotId, candidateSearch],
    queryFn: () => inventoryApi.comparableOnecSnapshots(snapshotId, { search: candidateSearch.trim() || undefined, limit: COMPARE_PAGE }),
    enabled: Boolean(snapshot), keepPreviousData: true,
  });
  // Открытый срез удалён — закрыть просмотр; пропала вторая сторона сравнения — снять сравнение.
  useEffect(() => {
    if (cardQuery.isError && viewFailureAction('card', cardQuery.error as InventoryApiError, false) === 'close') onGone();
  }, [cardQuery.isError, cardQuery.error]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!stockQuery.isError) return;
    const action = viewFailureAction('stock', stockQuery.error as InventoryApiError, typeof compareWith === 'number');
    if (action === 'close') onGone();
    else if (action === 'drop-compare') {
      message.warning('Срез для сравнения недоступен — сравнение снято');
      setCompareWith(undefined);
      void cardQuery.refetch();
      void candidatesQuery.refetch();
    }
  }, [stockQuery.isError, stockQuery.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const data: OnecSnapshotStockDto | undefined = stockQuery.isError ? undefined : stockQuery.data;
  const others = candidatesQuery.data?.items ?? [];
  const moreCandidates = (candidatesQuery.data?.total ?? 0) > others.length;
  const otherTitle = data?.other?.kind === 'snapshot' ? `Срез ${snapshotLabel(data.other.snapshot)}`
    : data?.other?.kind === 'current' ? `Сейчас в 1С${data.other.asOf ? ` (${formatWhen(data.other.asOf)})` : ''}` : 'Вторая сторона';
  const failure = stockQuery.error as (InventoryApiError & { details?: { warehouses?: Array<{ name: string; reason: string }> } }) | null;

  const exportXlsx = async () => {
    setExporting(true);
    try {
      // Один запрос на всё представление: сервер отдаёт его из одного снимка данных (остатки, названия, связи).
      const all = await load({ ...params, offset: 0, limit: SNAPSHOT_EXPORT_LIMIT });
      if (!exportComplete(all)) { message.error('Слишком много строк для выгрузки — сузьте фильтр'); return; }
      const sheet = XLSX.utils.json_to_sheet(snapshotExportRows(all.items, comparing));
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, 'Срез 1С');
      XLSX.writeFile(book, `Срез-1С-${(snapshot?.momentLocal ?? String(snapshotId)).replace(/[:T]/g, '-')}.xlsx`);
    } catch (error) {
      message.error(failureText(error, 'Не удалось выгрузить срез'));
    } finally { setExporting(false); }
  };

  const columns = [
    ...(group === 'all' ? [{ title: 'Вкладка', dataIndex: 'groupLabel', key: 'groupLabel' }] : []),
    { title: 'Наименование', dataIndex: 'name', key: 'name', render: (value: string, item: OnecSnapshotItemDto) => <Space size={4} wrap>{value}{item.ambiguousLink && <Tag color="orange">несколько материалов ERP</Tag>}</Space> },
    { title: 'Код 1С', dataIndex: 'code', key: 'code', render: (value: string | null) => value ?? '—' },
    { title: 'Категория 1С', dataIndex: 'categoryName', key: 'categoryName', render: (value: string | null) => value ?? '—' },
    { title: 'В срезе', dataIndex: 'quantity', key: 'quantity', align: 'right' as const, render: (value: number) => <span className="stock-qty" data-stock={stockQuantityTone(value)}>{formatQuantity(value)}</span> },
    ...(comparing ? [
      { title: otherTitle, dataIndex: 'otherQuantity', key: 'otherQuantity', align: 'right' as const, render: (value: number | null) => value === null ? '—' : <span className="stock-qty" data-stock={stockQuantityTone(value)}>{formatQuantity(value)}</span> },
      { title: 'Разница', dataIndex: 'delta', key: 'delta', align: 'right' as const, render: (value: number | null) => <span className="stock-delta" data-delta={deltaTone(value)}>{formatDelta(value)}</span> },
    ] : []),
    { title: 'Ед.', dataIndex: 'unitName', key: 'unitName', render: (value: string | null) => value ?? '—' },
  ];
  const categoryOptions = (data?.categories ?? []).map((category) => ({ value: category.key, label: `${category.name} · ${category.count}` }));
  const outside = (cardQuery.data?.warehouses ?? []).filter((row) => row.warehouseId === null && row.warehouseRefKey !== null).map((row) => row.name ?? String(row.warehouseRefKey));
  const scopeNote = warehouseScopeNote({ compareWith, selectedCount: warehouseIds.length, compared: data?.warehouses, outside });
  if (!snapshot) {
    return <Space direction="vertical">
      <Button onClick={onBack}>← К списку срезов</Button>
      {cardQuery.isError ? <Alert type="error" showIcon message={failureText(cardQuery.error, 'Не удалось открыть срез')} /> : <Text type="secondary">Загрузка среза…</Text>}
    </Space>;
  }

  return <>
    <Space wrap style={{ marginBottom: 12 }}>
      <Button onClick={onBack}>← К списку срезов</Button>
      <Text strong>Срез {snapshotLabel(snapshot)}</Text>
      {!snapshot.currentSource && <Tag>прежняя база 1С</Tag>}
      <Text type="secondary">позиций в срезе: {snapshot.rowsCount === null ? '—' : formatQuantity(snapshot.rowsCount)}</Text>
    </Space>
    <Space wrap style={{ marginBottom: 12 }}>
      <Select mode="multiple" allowClear placeholder={warehousePlaceholder(compareWith)} style={{ minWidth: 280 }} maxTagCount="responsive" value={warehouseIds} options={warehouseOptions} onChange={setWarehouseIds} optionFilterProp="label" />
      <Select allowClear placeholder="Сравнить с…" style={{ minWidth: 260 }} value={compareWith} onChange={(value) => setCompareWith(value ?? undefined)}
        options={[
          ...(snapshot.currentSource ? [{ value: 'current' as const, label: 'текущими остатками 1С' }] : []),
          ...others.map((item) => ({ value: item.id, label: `срезом ${snapshotLabel(item)}` })),
        ]} showSearch filterOption={false} onSearch={setCandidateInput} loading={candidatesQuery.isFetching}
        notFoundContent={candidateSearch ? 'Срезы не найдены' : 'Нет других готовых срезов этой базы 1С'} />
      {moreCandidates && <Text type="secondary">показаны {others.length} из {candidatesQuery.data?.total} срезов — введите номер или дату в поле сравнения</Text>}
      <Input.Search allowClear placeholder="Поиск по названию или коду" value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: 260 }} />
      <Checkbox checked={nonZero} onChange={(event) => setNonZero(event.target.checked)}>Только ненулевые</Checkbox>
      <Checkbox checked={negative} onChange={(event) => setNegative(event.target.checked)}>Только отрицательные</Checkbox>
      {comparing && <Checkbox checked={changedOnly} onChange={(event) => setChangedOnly(event.target.checked)}>Только с разницей</Checkbox>}
      <Button loading={exporting} disabled={!data} onClick={() => void exportXlsx()}>Выгрузить XLSX</Button>
    </Space>
    {snapshot.status !== 'ready' && <Alert style={{ marginBottom: 12 }} type="warning" showIcon message={`Срез ещё не готов: ${SNAPSHOT_STATUS_LABEL[snapshot.status].toLowerCase()}`} />}
    {scopeNote && <Alert style={{ marginBottom: 12 }} type="info" showIcon message={scopeNote} />}
    {comparing && <Alert style={{ marginBottom: 12 }} type="info" showIcon message="Разница — вторая сторона минус срез: плюс — стало больше, минус — меньше. Позиции, которой нет на одной из сторон, соответствует ноль." />}
    {stockQuery.isError && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={failureText(failure, 'Не удалось загрузить остатки среза')}
      description={failure?.details?.warehouses?.length ? `Склады: ${failure.details.warehouses.map((row) => `${row.name} — ${row.reason}`).join('; ')}` : undefined} />}
    <Tabs size="small" activeKey={group} onChange={setGroup} items={(data?.tabs ?? [{ key: 'all', label: 'Все материалы', count: 0 }]).map((tab) => ({ key: tab.key, label: `${tab.label} · ${tab.count}` }))} />
    {group !== 'all' && categoryOptions.length > 0 && <Space style={{ marginBottom: 12 }}>
      <Select allowClear placeholder="Категория 1С" style={{ minWidth: 260 }} value={categoryKey} options={categoryOptions} onChange={(value) => setCategoryKey(value ?? undefined)} />
    </Space>}
    <Table rowKey="itemRefKey" size="small" dataSource={data?.items ?? []} columns={columns} loading={stockQuery.isFetching}
      rowClassName={(item: OnecSnapshotItemDto) => item.quantity < 0 ? 'film-stock-negative' : ''}
      pagination={{ current: page.current, pageSize: page.pageSize, total: data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 200], onChange: (current, pageSize) => setPage({ current, pageSize }) }} />
  </>;
};
