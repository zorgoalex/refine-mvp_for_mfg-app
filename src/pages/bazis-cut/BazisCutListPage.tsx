import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Input, Space, Table, Typography, message } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { Link, useNavigate } from 'react-router-dom';
import { bazisCutApi, type BazisCutSetListItemDto, type BazisCutSourceRefDto } from '../../api/bazisCutApi';

const { Title, Text } = Typography;

export const BazisCutListPage: React.FC = () => {
  const navigate = useNavigate();
  const [items, setItems] = useState<BazisCutSetListItemDto[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => { const id = window.setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300); return () => clearTimeout(id); }, [search]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await bazisCutApi.list({ search: debounced || undefined, page, pageSize });
      setItems(response.items); setTotal(response.total);
    } catch (error) { message.error(error instanceof Error ? error.message : 'Не удалось загрузить наборы'); }
    finally { setLoading(false); }
  }, [debounced, page, pageSize]);
  useEffect(() => { void load(); }, [load]);

  const columns = useMemo<ColumnsType<BazisCutSetListItemDto>>(() => [
    { title: 'Название набора', dataIndex: 'name', key: 'name',
      render: (name: string, row) => <Link to={`/bazis-cut/${row.bazisCutSetId}`} onClick={(event) => event.stopPropagation()}>{name}</Link> },
    { title: 'Дата формирования', dataIndex: 'createdAt', key: 'createdAt', width: 190,
      render: (value: string) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))}</span> },
    { title: 'Заказы / Базис-проекты / Базис-заказы', key: 'sources', width: 430,
      render: (_, row) => <Sources row={row} /> },
    { title: 'Количество деталей', dataIndex: 'quantity', key: 'quantity', align: 'right', width: 180,
      render: (value: number, row) => <Space direction="vertical" size={0} align="end"><Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</Text><Text type="secondary">Позиций: {row.positionCount}</Text></Space> },
  ], []);

  const pagination: TablePaginationConfig = { current: page, pageSize, total, showSizeChanger: true,
    showTotal: (value) => `Всего наборов: ${value}`,
    onChange: (next, size) => { setPage(next); setPageSize(size); } };
  return <div style={{ padding: 24 }}><Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <Title level={3} style={{ margin: 0 }}>Базис-раскрой</Title>
    <Card><Input.Search allowClear value={search} onChange={(event) => setSearch(event.target.value)}
      placeholder="Набор, заказ или Базис-проект" style={{ maxWidth: 420 }} /></Card>
    <Table rowKey="bazisCutSetId" columns={columns} dataSource={items} loading={loading} pagination={pagination}
      locale={{ emptyText: search ? 'Ничего не найдено' : 'Наборы ещё не сформированы' }}
      onRow={(row) => ({ onClick: () => navigate(`/bazis-cut/${row.bazisCutSetId}`), style: { cursor: 'pointer' } })} />
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
    {index > 0 && ', '}{href ? <Link to={href(ref.id)} onClick={(event) => event.stopPropagation()}>{ref.label}</Link> : ref.label}
  </React.Fragment>)}</div>;
};

