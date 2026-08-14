import { Table } from '../../ui/tooltipDelay';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Checkbox, Input, Modal, Popconfirm, Select, Space, Typography, message } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { bazisCutApi, type BazisCutSetListItemDto, type BazisCutSourceRefDto } from '../../api/bazisCutApi';
import { OrderDeletedTag, hasDeletedOrderReference, orderDeletedReferenceClassName } from '../../components/OrderDeletedTag';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../hooks/usePageSizePreference';
import { can } from '../../utils/permissions';
import { BazisCutPickerModal } from './BazisCutPickerModal';
import { formatBazisCutAreaM2 } from './bazisCutDetailPresentation';

const { Title, Text } = Typography;
const LIST_FETCH_PAGE_SIZE = 100;
type DetailStateFilter = 'all' | 'empty' | 'withDetails';
type ListFieldFilters = {
  name: string;
  createdAt: string;
  orders: string;
  bazisProjects: string;
  bazisOrders: string;
  quantity: string;
  area: string;
  detailState: DetailStateFilter;
};
const DEFAULT_FIELD_FILTERS: ListFieldFilters = {
  name: '',
  createdAt: '',
  orders: '',
  bazisProjects: '',
  bazisOrders: '',
  quantity: '',
  area: '',
  detailState: 'all',
};
const listDateFormatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

export const BazisCutListPage: React.FC = () => {
  const navigate = useNavigate();
  const [items, setItems] = useState<BazisCutSetListItemDto[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [fieldFilters, setFieldFilters] = useState<ListFieldFilters>(DEFAULT_FIELD_FILTERS);
  const [page, setPage] = useState(1);
  const { pageSize, setPageSize } = usePageSizePreference('bazis-cut:list', 25);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deletingSetId, setDeletingSetId] = useState<number | null>(null);
  const [selectedSetIds, setSelectedSetIds] = useState<number[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const canManage = can('cut.manage');

  useEffect(() => { const id = window.setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300); return () => clearTimeout(id); }, [search]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const first = await bazisCutApi.list({ search: debounced || undefined, page: 1, pageSize: LIST_FETCH_PAGE_SIZE });
      const loaded = [...first.items];
      let nextPage = 2;
      while (loaded.length < first.total) {
        const next = await bazisCutApi.list({ search: debounced || undefined, page: nextPage, pageSize: LIST_FETCH_PAGE_SIZE });
        if (next.items.length === 0) break;
        loaded.push(...next.items);
        nextPage += 1;
      }
      setItems(loaded); setTotal(first.total);
    } catch (error) { message.error(error instanceof Error ? error.message : 'Не удалось загрузить наборы'); }
    finally { setLoading(false); }
  }, [debounced]);
  useEffect(() => { void load(); }, [load]);

  const setFieldFilter = useCallback(<K extends keyof ListFieldFilters>(key: K, value: ListFieldFilters[K]) => {
    setFieldFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }, []);

  const filteredItems = useMemo(() => items.filter((row) => matchesFieldFilters(row, fieldFilters)), [fieldFilters, items]);
  const selectedSetIdSet = useMemo(() => new Set(selectedSetIds), [selectedSetIds]);
  const selectableFilteredIds = useMemo(() => filteredItems
    .filter((row) => row.positionCount === 0)
    .map((row) => row.bazisCutSetId), [filteredItems]);
  const allFilteredSelected = selectableFilteredIds.length > 0
    && selectableFilteredIds.every((id) => selectedSetIdSet.has(id));
  const someFilteredSelected = selectableFilteredIds.some((id) => selectedSetIdSet.has(id));
  const itemsById = useMemo(() => new Map(items.map((row) => [row.bazisCutSetId, row])), [items]);
  const selectedRows = useMemo(() => selectedSetIds
    .map((id) => itemsById.get(id))
    .filter((row): row is BazisCutSetListItemDto => Boolean(row)), [itemsById, selectedSetIds]);
  const filtersActive = useMemo(() => fieldFilters.name.trim() !== ''
    || fieldFilters.createdAt.trim() !== ''
    || fieldFilters.orders.trim() !== ''
    || fieldFilters.bazisProjects.trim() !== ''
    || fieldFilters.bazisOrders.trim() !== ''
    || fieldFilters.quantity.trim() !== ''
    || fieldFilters.area.trim() !== ''
    || fieldFilters.detailState !== 'all', [fieldFilters]);

  useEffect(() => {
    const filteredIds = new Set(filteredItems.map((row) => row.bazisCutSetId));
    setSelectedSetIds((current) => current.filter((id) => filteredIds.has(id)));
  }, [filteredItems]);

  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(filteredItems.length / pageSize));
    if (page > lastPage) setPage(lastPage);
  }, [filteredItems.length, page, pageSize]);

  const removeSet = useCallback(async (row: BazisCutSetListItemDto) => {
    setDeletingSetId(row.bazisCutSetId);
    try {
      await bazisCutApi.removeSet(row.bazisCutSetId, { expectedVersion: row.version }, {
        idempotencyKey: commandKey('bazis-cut-set-delete'),
      });
      message.success(`Набор «${row.name}» удалён`);
      setSelectedSetIds((current) => current.filter((id) => id !== row.bazisCutSetId));
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось удалить набор');
    } finally {
      setDeletingSetId(null);
    }
  }, [load]);

  const removeSelectedSets = useCallback(async (rows: BazisCutSetListItemDto[]) => {
    const removable = rows.filter((row) => row.positionCount === 0);
    if (removable.length === 0) return;
    setBulkDeleting(true);
    let deleted = 0;
    const failures: string[] = [];
    try {
      for (const row of removable) {
        try {
          await bazisCutApi.removeSet(row.bazisCutSetId, { expectedVersion: row.version }, {
            idempotencyKey: commandKey(`bazis-cut-set-bulk-delete-${row.bazisCutSetId}`),
          });
          deleted += 1;
        } catch (error) {
          failures.push(`${row.name}: ${errorMessage(error, 'не удалось удалить')}`);
        }
      }
      if (deleted > 0) message.success(`Удалено наборов: ${deleted}`);
      if (failures.length > 0) {
        Modal.error({
          title: 'Не все наборы удалены',
          content: <Space direction="vertical" size={4}>
            {failures.slice(0, 6).map((failure) => <Text key={failure}>{failure}</Text>)}
            {failures.length > 6 && <Text type="secondary">Ещё ошибок: {failures.length - 6}</Text>}
          </Space>,
        });
      }
      setSelectedSetIds([]);
      await load();
    } finally {
      setBulkDeleting(false);
    }
  }, [load]);

  const confirmRemoveSelected = useCallback(() => {
    const removable = selectedRows.filter((row) => row.positionCount === 0);
    if (removable.length === 0) {
      message.warning('Для удаления выберите пустые наборы');
      return;
    }
    Modal.confirm({
      title: 'Удалить выделенные наборы?',
      content: `Будет удалено пустых наборов: ${removable.length}.`,
      okText: 'Удалить',
      cancelText: 'Отмена',
      okButtonProps: { danger: true },
      onOk: () => removeSelectedSets(removable),
    });
  }, [removeSelectedSets, selectedRows]);

  const rowSelection = canManage ? {
    preserveSelectedRowKeys: true,
    selectedRowKeys: selectedSetIds,
    columnWidth: 44,
    columnTitle: <Checkbox aria-label="Выделить все отфильтрованные пустые наборы"
      checked={allFilteredSelected}
      indeterminate={!allFilteredSelected && someFilteredSelected}
      disabled={bulkDeleting || selectableFilteredIds.length === 0}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setSelectedSetIds(event.target.checked ? selectableFilteredIds : [])} />,
    getCheckboxProps: (row: BazisCutSetListItemDto) => ({
      disabled: bulkDeleting || row.positionCount !== 0,
      title: row.positionCount === 0 ? 'Выделить набор' : 'Удалять можно только наборы без деталей',
    }),
    onChange: (keys: React.Key[]) => setSelectedSetIds(keys.filter((key): key is number => typeof key === 'number')),
  } : undefined;

  const columns = useMemo<ColumnsType<BazisCutSetListItemDto>>(() => [
    { title: 'Название набора', dataIndex: 'name', key: 'name',
      render: (name: string, row) => <Link to={`/bazis-cut/${row.bazisCutSetId}`} onClick={(event) => event.stopPropagation()}>{name}</Link> },
    { title: 'Дата формирования', dataIndex: 'createdAt', key: 'createdAt', width: 190,
      render: (value: string) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{listDateFormatter.format(new Date(value))}</span> },
    { title: 'Заказы / Базис-проекты / Базис-заказы', key: 'sources', width: 430,
      render: (_, row) => <Sources row={row} /> },
    { title: 'Количество деталей', dataIndex: 'quantity', key: 'quantity', align: 'right', width: 180,
      render: (value: number, row) => <Space direction="vertical" size={0} align="end"><Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</Text><Text type="secondary">Позиций: {row.positionCount}</Text></Space> },
    { title: 'Площадь, м²', dataIndex: 'totalAreaM2', key: 'totalAreaM2', align: 'right', width: 130,
      render: (value: number) => <Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatBazisCutAreaM2(value)}</Text> },
    ...(canManage ? [{ title: 'Действия', key: 'actions', align: 'right' as const, width: 130,
      render: (_: unknown, row: BazisCutSetListItemDto) => {
        const empty = row.positionCount === 0;
        const button = <Button danger icon={<DeleteOutlined />} disabled={!empty}
          loading={deletingSetId === row.bazisCutSetId}
          title={empty ? 'Удалить пустой набор' : 'Удалять можно только наборы без деталей'}>
          Удалить
        </Button>;
        if (!empty) return <span onClick={(event) => event.stopPropagation()}>{button}</span>;
        return <span onClick={(event) => event.stopPropagation()}><Popconfirm title="Удалить пустой набор?" description={`«${row.name}» будет удалён безвозвратно.`}
          okText="Удалить" cancelText="Отмена" onConfirm={() => void removeSet(row)}>
          {button}
        </Popconfirm></span>;
      } }] : []),
  ], [canManage, deletingSetId, removeSet]);

  const pagination: TablePaginationConfig = { current: page, pageSize, total: filteredItems.length, showSizeChanger: true,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    showTotal: (value) => `Показано наборов: ${value}`,
    onChange: (next, size) => {
      if (size !== pageSize) {
        setPageSize(size);
        setPage(1);
        return;
      }
      setPage(next);
    } };
  return <div className="bazis-cut-list-modern"><Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
      <Title level={3} style={{ margin: 0 }}>Базис-раскрой</Title>
      {canManage && <Space wrap>
        <Button danger icon={<DeleteOutlined />} style={{ minHeight: 40 }}
          disabled={selectedSetIds.length === 0 || bulkDeleting}
          loading={bulkDeleting}
          onClick={confirmRemoveSelected}>Удалить выделенные</Button>
        <Button type="primary" icon={<PlusOutlined />} style={{ minHeight: 40 }}
          onClick={() => setPickerOpen(true)}>Подобрать детали</Button>
      </Space>}
    </Space>
    <Card><Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Space wrap>
        <Input.Search allowClear value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="Поиск по всем наборам" style={{ width: 300 }} />
        <Input allowClear value={fieldFilters.name} onChange={(event) => setFieldFilter('name', event.target.value)}
          placeholder="Название" aria-label="Фильтр по названию набора" style={{ width: 190 }} />
        <Input allowClear value={fieldFilters.createdAt} onChange={(event) => setFieldFilter('createdAt', event.target.value)}
          placeholder="Дата" aria-label="Фильтр по дате формирования" style={{ width: 150 }} />
        <Input allowClear value={fieldFilters.orders} onChange={(event) => setFieldFilter('orders', event.target.value)}
          placeholder="ERP-заказ" aria-label="Фильтр по ERP-заказу" style={{ width: 170 }} />
        <Input allowClear value={fieldFilters.bazisProjects} onChange={(event) => setFieldFilter('bazisProjects', event.target.value)}
          placeholder="Базис-проект" aria-label="Фильтр по Базис-проекту" style={{ width: 190 }} />
        <Input allowClear value={fieldFilters.bazisOrders} onChange={(event) => setFieldFilter('bazisOrders', event.target.value)}
          placeholder="Базис-заказ" aria-label="Фильтр по Базис-заказу" style={{ width: 180 }} />
        <Input allowClear value={fieldFilters.quantity} onChange={(event) => setFieldFilter('quantity', event.target.value)}
          placeholder="Кол-во / позиции" aria-label="Фильтр по количеству и позициям" style={{ width: 170 }} />
        <Input allowClear value={fieldFilters.area} onChange={(event) => setFieldFilter('area', event.target.value)}
          placeholder="Площадь" aria-label="Фильтр по площади" style={{ width: 130 }} />
        <Select<DetailStateFilter> value={fieldFilters.detailState} onChange={(value) => setFieldFilter('detailState', value)}
          style={{ width: 180 }} options={[
            { value: 'all', label: 'Все наборы' },
            { value: 'empty', label: 'Пустые' },
            { value: 'withDetails', label: 'С деталями' },
          ]} />
        <Button disabled={!filtersActive} onClick={() => { setFieldFilters(DEFAULT_FIELD_FILTERS); setPage(1); }}>Сбросить</Button>
      </Space>
      <Space wrap size="small">
        <Text type="secondary">Показано: {filteredItems.length} из {total || items.length}</Text>
        {selectedSetIds.length > 0 && <Text type="secondary">Выбрано: {selectedSetIds.length}</Text>}
      </Space>
    </Space></Card>
    <Table rowKey="bazisCutSetId" columns={columns} dataSource={filteredItems} loading={loading} pagination={pagination}
      rowSelection={rowSelection}
      locale={{ emptyText: search || filtersActive ? 'Ничего не найдено' : 'Наборы ещё не сформированы' }}
      rowClassName={(row) => orderDeletedReferenceClassName(hasDeletedOrderReference(row.orders))}
      onRow={(row) => ({ onClick: () => navigate(`/bazis-cut/${row.bazisCutSetId}`), style: { cursor: 'pointer' } })} />
    <BazisCutPickerModal open={pickerOpen} onCancel={() => setPickerOpen(false)}
      onCreated={async (createdSetId) => {
        setPickerOpen(false);
        await load();
        navigate(`/bazis-cut/${createdSetId}`);
      }} />
  </Space></div>;
};

const Sources: React.FC<{ row: BazisCutSetListItemDto }> = ({ row }) => <Space direction="vertical" size={2}>
  <SourceLine title="ERP-заказы" refs={row.orders} href={(id) => `/orders/show/${id}`} />
  <SourceLine title="Базис-проекты" refs={row.bazisProjects} href={(id) => `/bazis/projects/${id}`} />
  <SourceLine title="Базис-заказы" refs={row.bazisOrders} />
</Space>;

const SourceLine: React.FC<{ title: string; refs: BazisCutSourceRefDto[]; href?: (id: number) => string }> = ({ title, refs, href }) => {
  if (refs.length === 0) return null;
  return <div><Text type="secondary">{title}: </Text>{refs.map((ref, index) => <React.Fragment key={ref.id}>
    {index > 0 && ', '}
    <Space size={4} wrap>
      {href ? <Link to={href(ref.id)} onClick={(event) => event.stopPropagation()}>{ref.label}</Link> : ref.label}
      <OrderDeletedTag deleted={ref.deleted} />
    </Space>
  </React.Fragment>)}</div>;
};

function commandKey(prefix: string): string {
  return `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
}

function matchesFieldFilters(row: BazisCutSetListItemDto, filters: ListFieldFilters): boolean {
  if (filters.detailState === 'empty' && row.positionCount !== 0) return false;
  if (filters.detailState === 'withDetails' && row.positionCount === 0) return false;
  return matchesText(`${row.bazisCutSetId} ${row.name}`, filters.name)
    && matchesText(`${row.createdAt} ${listDateFormatter.format(new Date(row.createdAt))}`, filters.createdAt)
    && matchesText(refsSearchText(row.orders), filters.orders)
    && matchesText(refsSearchText(row.bazisProjects), filters.bazisProjects)
    && matchesText(refsSearchText(row.bazisOrders), filters.bazisOrders)
    && matchesText(`${row.quantity} ${row.positionCount}`, filters.quantity)
    && matchesText(`${row.totalAreaM2} ${formatBazisCutAreaM2(row.totalAreaM2)}`, filters.area);
}

function refsSearchText(refs: BazisCutSourceRefDto[]): string {
  return refs.map((ref) => `${ref.id} ${ref.label}`).join(' ');
}

function matchesText(value: string, query: string): boolean {
  const needle = normalizeText(query);
  return needle === '' || normalizeText(value).includes(needle);
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
