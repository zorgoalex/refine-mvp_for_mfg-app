import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Radio, Space, Typography } from 'antd';
import { EditOutlined, FilterFilled, ReloadOutlined, StarFilled } from '@ant-design/icons';
import { Link, useSearchParams } from 'react-router-dom';
import type { ColumnType } from 'antd/es/table';
import {
  CLIENT_CONTACT_COLUMNS, clientContactsApi, type ClientContactColumn, type ClientContactSort, type ClientContactsPage as Page,
  type ClientContactsQuery, type ClientContactsRow, type ColumnFilterValue,
} from '../../api/clientContactsApi';
import { formatContact } from '../../components/contacts/contactsModel';
import { Segmented } from '../../ui/Segmented';
import { Table } from '../../ui/tooltipDelay';
import { can } from '../../utils/permissions';
import { KindEditor, PhonesEditor } from './ClientContactsEditors';
import { COLUMN_TITLES, DEFAULT_QUERY, PAGE_SIZES, columnValues, hasFilters, listError, readQuery, requestGate, writeQuery } from './clientContactsModel';

type Editing = { clientId: number; column: ClientContactColumn } | null;

/** The filter of one column: has a value, has none, or contains a text (phones — by digits). */
function ColumnFilter({ value, onChange, close }: { value: ColumnFilterValue | undefined; onChange: (value: ColumnFilterValue | undefined) => void; close: () => void }) {
  const [mode, setMode] = useState<'any' | 'has' | 'none' | 'contains'>(value === 'has' || value === 'none' ? value : value ? 'contains' : 'any');
  const [text, setText] = useState(value?.startsWith('~') ? value.slice(1) : '');
  const apply = () => {
    onChange(mode === 'any' ? undefined : mode === 'contains' ? (text.trim() ? `~${text.trim()}` : undefined) : mode);
    close();
  };
  return (
    <div style={{ padding: 12, width: 240 }}>
      <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)}>
        <Space direction="vertical">
          <Radio value="any">Все</Radio>
          <Radio value="has">Есть</Radio>
          <Radio value="none">Нет</Radio>
          <Radio value="contains">Содержит…</Radio>
        </Space>
      </Radio.Group>
      {mode === 'contains' ? <Input autoFocus value={text} maxLength={100} style={{ marginTop: 8 }} onChange={(event) => setText(event.target.value)} onPressEnter={apply} /> : null}
      <Space style={{ marginTop: 12 }}>
        <Button size="small" type="primary" onClick={apply}>Применить</Button>
        <Button size="small" onClick={() => { onChange(undefined); close(); }}>Сбросить</Button>
      </Space>
    </div>
  );
}

/**
 * «Контакты клиентов»: phones, WhatsApp, Telegram, email and other messengers of all clients in one list — search over
 * any value, a filter and a sort on every column, editing in place (top manager and above by default).
 */
export function ClientContactsPage() {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => readQuery(params), [params]);
  const [search, setSearch] = useState(query.q ?? '');
  const [data, setData] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  // Only the latest request applies its answer: an earlier search answering late must not replace the current list.
  const gate = useRef(requestGate()).current;
  const canManage = can('clients.contacts.manage') && (data?.canManage ?? true);

  const update = useCallback((patch: Partial<ClientContactsQuery>) => {
    setParams(writeQuery({ ...query, page: 1, ...patch }), { replace: true });
  }, [query, setParams]);

  const load = useCallback(async () => {
    const current = gate.start();
    setLoading(true);
    try {
      const page = await clientContactsApi.list(query);
      if (!gate.isLatest(current)) return;
      setData(page);
      setError(null);
    } catch (caught) {
      if (!gate.isLatest(current)) return;
      setError(listError(caught));
    } finally {
      if (gate.isLatest(current)) setLoading(false);
    }
  }, [query, gate]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSearch(query.q ?? ''); }, [query.q]);
  // Typing searches after a short pause.
  useEffect(() => {
    if ((query.q ?? '') === search.trim()) return undefined;
    const timer = setTimeout(() => update({ q: search.trim() || undefined }), 400);
    return () => clearTimeout(timer);
  }, [search, query.q, update]);

  const replaceRow = (row: ClientContactsRow) =>
    setData((current) => (current ? { ...current, items: current.items.map((item) => (item.client.id === row.client.id ? row : item)) } : current));

  const sortOrder = (key: ClientContactSort) => (query.sort === key ? (query.order === 'asc' ? 'ascend' as const : 'descend' as const) : null);

  const contactColumn = (column: ClientContactColumn): ColumnType<ClientContactsRow> => ({
    key: column,
    title: COLUMN_TITLES[column],
    sorter: true,
    sortOrder: sortOrder(column),
    filteredValue: query.filters[column] ? [query.filters[column] as string] : null,
    filterIcon: () => <FilterFilled style={{ color: query.filters[column] ? '#1677ff' : undefined }} />,
    filterDropdown: ({ close }) => (
      <ColumnFilter value={query.filters[column]} close={close}
        onChange={(value) => {
          const filters = { ...query.filters };
          if (value) filters[column] = value; else delete filters[column];
          update({ filters });
        }} />
    ),
    render: (_: unknown, row) => {
      const values = columnValues(row, column);
      const editable = canManage && (column !== 'phone' || data?.phonesEditable !== false);
      const pencil = editable ? (
        <Button type="text" size="small" icon={<EditOutlined />} style={{ color: 'var(--ant-color-text-tertiary, #8c8c8c)' }}
          aria-label={`Изменить: ${COLUMN_TITLES[column]}`} onClick={() => setEditing({ clientId: row.client.id, column })} />
      ) : null;
      if (!values.length) return pencil ?? <Typography.Text type="secondary">—</Typography.Text>;
      return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 2, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {values.map((value) => (
              <span key={'phoneId' in value ? `p${value.phoneId}` : `c${value.contactId}`} style={{ whiteSpace: 'nowrap' }}>
                {'phoneId' in value ? value.phoneNumber : formatContact(value)}
                {value.isPrimary && values.length > 1 ? <StarFilled style={{ color: '#faad14', marginLeft: 4, fontSize: 11 }} /> : null}
                {'note' in value && value.note ? <Typography.Text type="secondary" style={{ fontSize: 12 }}> · {value.note}</Typography.Text> : null}
              </span>
            ))}
          </div>
          {pencil}
        </div>
      );
    },
  });

  const columns: ColumnType<ClientContactsRow>[] = [
    {
      key: 'client', title: 'Клиент', sorter: true, sortOrder: sortOrder('client'), fixed: 'left', width: 220,
      render: (_: unknown, row) => (
        <Space direction="vertical" size={0}>
          <Link to={`/clients/show/${row.client.id}`}>{row.client.name}</Link>
          {row.client.isActive ? null : <Typography.Text type="secondary" style={{ fontSize: 12 }}>архив</Typography.Text>}
        </Space>
      ),
    },
    ...CLIENT_CONTACT_COLUMNS.map(contactColumn),
    {
      key: 'updated', title: 'Изменено', sorter: true, sortOrder: sortOrder('updated'), width: 130,
      render: (_: unknown, row) => (row.updatedAt ? new Date(row.updatedAt).toLocaleDateString('ru-RU') : '—'),
    },
  ];

  const editingRow = editing ? data?.items.find((item) => item.client.id === editing.clientId) : undefined;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>Контакты клиентов</Typography.Title>
      <Space wrap>
        <Input.Search allowClear placeholder="Имя, телефон, email, аккаунт, подпись…" style={{ width: 340, maxWidth: '100%' }}
          value={search} onChange={(event) => setSearch(event.target.value)} onSearch={(value) => update({ q: value.trim() || undefined })} />
        <Segmented value={query.active} onChange={(value) => update({ active: value as ClientContactsQuery['active'] })}
          options={[{ value: 'active', label: 'Активные' }, { value: 'archived', label: 'Архив' }, { value: 'all', label: 'Все' }]} />
        {hasFilters(query) ? <Button onClick={() => { setSearch(''); setParams(writeQuery(DEFAULT_QUERY), { replace: true }); }}>Сбросить фильтры</Button> : null}
        <Button icon={<ReloadOutlined />} onClick={() => { void load(); }} aria-label="Обновить" />
      </Space>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <Table<ClientContactsRow>
        rowKey={(row) => row.client.id}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data?.items ?? []}
        scroll={{ x: 1400 }}
        pagination={{
          current: query.page, pageSize: query.pageSize, total: data?.total ?? 0, showSizeChanger: true, pageSizeOptions: PAGE_SIZES.map(String),
          showTotal: (total) => `Клиентов: ${total}`,
        }}
        onChange={(pagination, _filters, sorter) => {
          const single = Array.isArray(sorter) ? sorter[0] : sorter;
          const sort = (single?.order ? single.columnKey : DEFAULT_QUERY.sort) as ClientContactSort;
          const order = single?.order === 'descend' ? 'desc' : 'asc';
          const pageSize = pagination.pageSize ?? query.pageSize;
          const changedOrder = sort !== query.sort || order !== query.order || pageSize !== query.pageSize;
          setParams(writeQuery({ ...query, sort, order, pageSize, page: changedOrder ? 1 : pagination.current ?? 1 }), { replace: true });
        }}
      />
      {editing && editingRow && editing.column === 'phone' ? (
        <PhonesEditor row={editingRow} onSaved={replaceRow} onClose={() => setEditing(null)} />
      ) : null}
      {editing && editingRow && editing.column !== 'phone' ? (
        <KindEditor row={editingRow} kind={editing.column} kinds={data?.kinds ?? []} onSaved={replaceRow} onClose={() => setEditing(null)} />
      ) : null}
    </Space>
  );
}
