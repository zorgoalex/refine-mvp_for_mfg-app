import React, { useEffect, useState } from 'react';
import { Alert, Button, Empty, Input, Pagination, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { Table } from '../../../ui/tooltipDelay';
import { DeleteOutlined } from '@ant-design/icons';
import { catalogApi, type CatalogItem } from '../../../api/catalogApi';
import { catalogKindLabels, orderCatalogLineAmount, orderCatalogSubtotal, type OrderCatalogLine } from '../../../utils/orderCatalogLines';

interface Props {
  rows: OrderCatalogLine[];
  onChange?: (rows: OrderCatalogLine[], deletedIds?: number[]) => void;
  canSelect?: boolean;
  canViewFinancials: boolean;
}

/** Inline drafts belong to the enclosing order save; no per-cell API writes. */
export function OrderCatalogLinesTable({ rows, onChange, canSelect = false, canViewFinancials }: Props) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => { const id = setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(id); }, [search]);
  useEffect(() => {
    if (!open || !canSelect || !onChange) return;
    let current = true;
    setLoading(true); setError(''); setItems([]);
    catalogApi.list({ q: query, active: 'true', offset: (page - 1) * 25, limit: 25 })
      .then(result => { if (current) { setItems(result.items); setTotal(result.total); } })
      .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить справочник'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, canSelect, Boolean(onChange), query, page, retry]);

  const update = (index: number, value: Partial<OrderCatalogLine>) => onChange?.(rows.map((row, i) => i === index ? { ...row, ...value } : row));
  const invalid = rows.some(row => orderCatalogLineAmount(row.quantity, row.unitPrice) === null);
  const numericStyle = { fontVariantNumeric: 'tabular-nums', textAlign: 'right' as const, minHeight: 40 };
  const money = (value: string | number) => Number(value).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const add = (item: CatalogItem) => {
    onChange?.([...rows, { clientKey: crypto.randomUUID(), catalogItemId: item.id, catalogVersion: item.version,
      name: item.name, sku: item.sku, kind: item.kind, unitId: item.unitId, unitName: item.unitName,
      refKey1c: item.refKey1c, quantity: '1', unitPrice: item.basePrice ?? '', notes: '', catalogActive: true }]);
    setOpen(false); setSearch('');
  };

  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    {onChange && <>
      {canSelect ? <Select<number> showSearch filterOption={false} value={undefined} open={open}
        onDropdownVisibleChange={setOpen} searchValue={search} onSearch={setSearch} loading={loading}
        aria-label="Добавить товар или услугу" placeholder="Добавить из справочника: название, артикул или 1C_key"
        style={{ width: '100%', minHeight: 40 }} size="large"
        options={items.map(item => ({ value: item.id, label: `${item.name} · ${catalogKindLabels[item.kind]} · ${item.unitName} · ${item.basePrice === null ? 'цена не задана' : money(item.basePrice) + ' ₸'}` }))}
        onSelect={id => { const item = items.find(candidate => candidate.id === id); if (item) add(item); }}
        notFoundContent={loading ? 'Загрузка…' : error ? <Space direction="vertical"><Typography.Text type="danger">{error}</Typography.Text><Button onClick={() => setRetry(value => value + 1)}>Повторить загрузку</Button></Space> : query ? 'Ничего не найдено' : 'Нет активных товаров/услуг'}
        dropdownRender={menu => <>{menu}{total > 25 && <Pagination size="small" current={page} total={total} pageSize={25} showSizeChanger={false} onChange={setPage} style={{ padding: 12 }} />}</>} />
        : <Alert type="info" message="Для добавления позиции нужен доступ к справочникам. Сохранённые позиции доступны для редактирования." />}
      <Typography.Text type="secondary">Изменения сохраняются общей кнопкой «Сохранить». Это дополнительные позиции к деталям заказа. Excel и Google Drive экспортируют только детали.</Typography.Text>
    </>}
    {invalid && onChange && <Alert type="error" message="Укажите количество больше нуля (до 3 знаков) и цену от нуля (до 2 знаков). Цена не может быть пустой." />}
    <Table<OrderCatalogLine> size="small" pagination={false} dataSource={rows} rowKey={row => row.id ? `id:${row.id}` : row.clientKey!}
      scroll={{ x: 1080 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Товары и услуги не добавлены" /> }}
      columns={[
        { title: '№', width: 48, render: (_value, _row, index) => index + 1 },
        { title: 'Позиция', dataIndex: 'name', width: 220, render: (name, row) => <><div>{name}</div><Typography.Text type="secondary">{row.sku}</Typography.Text>{!row.catalogActive && <Tag>В архиве</Tag>}</> },
        { title: 'Тип', dataIndex: 'kind', width: 125, render: kind => catalogKindLabels[kind as keyof typeof catalogKindLabels] },
        { title: 'Ед.', dataIndex: 'unitName', width: 75 },
        { title: 'Количество', width: 120, align: 'right', render: (_value, row, index) => onChange ? <Input aria-label={`Количество: ${row.name}`} inputMode="decimal" value={row.quantity} style={numericStyle} onChange={event => update(index, { quantity: event.target.value.replace(',', '.') })} /> : row.quantity },
        ...(canViewFinancials ? [
          { title: 'Цена, ₸', width: 135, align: 'right' as const, render: (_value: unknown, row: OrderCatalogLine, index: number) => onChange ? <Input aria-label={`Цена: ${row.name}`} inputMode="decimal" value={row.unitPrice} style={numericStyle} onChange={event => update(index, { unitPrice: event.target.value.replace(',', '.') })} /> : money(row.unitPrice) },
          { title: 'Сумма, ₸', width: 130, align: 'right' as const, render: (_value: unknown, row: OrderCatalogLine) => <span style={numericStyle}>{orderCatalogLineAmount(row.quantity, row.unitPrice) === null ? '—' : money(orderCatalogLineAmount(row.quantity, row.unitPrice)!)}</span> },
        ] : []),
        { title: 'Примечание', width: 200, render: (_value, row, index) => onChange ? <Input.TextArea aria-label={`Примечание: ${row.name}`} maxLength={2000} autoSize={{ minRows: 1, maxRows: 5 }} value={row.notes} onChange={event => update(index, { notes: event.target.value })} /> : row.notes },
        ...(onChange ? [{ title: '', width: 56, render: (_value: unknown, row: OrderCatalogLine, index: number) => <Popconfirm title="Удалить позицию из заказа?" okText="Удалить" cancelText="Отмена" onConfirm={() => onChange(rows.filter((_row, i) => i !== index), row.id ? [row.id] : [])}><Button danger aria-label={`Удалить: ${row.name}`} icon={<DeleteOutlined />} style={{ minWidth: 40, minHeight: 40 }} /></Popconfirm> }] : []),
      ]}
      footer={canViewFinancials ? () => <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>Товары/услуги: <strong>{invalid ? '—' : money(orderCatalogSubtotal(rows))} ₸</strong></div> : undefined}
    />
  </Space>;
}
