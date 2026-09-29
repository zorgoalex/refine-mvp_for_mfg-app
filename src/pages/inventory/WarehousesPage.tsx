import React, { useMemo, useRef, useState } from 'react';
import { useList } from '@refinedev/core';
import { Button, Card, Checkbox, Form, Input, Modal, Select, Space, Tag, Typography, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Table, Tooltip } from '../../ui/tooltipDelay';
import { createInventoryIdempotencyKey, inventoryApi } from '../../api/inventoryApi';
import type { InventoryApiError, WarehouseDto } from '../../api/types/inventoryApi.types';
import { can } from '../../utils/permissions';
import { warehouseDeactivationBlock, warehousePatch, type WarehouseFormValues } from './warehouses';

const { Text } = Typography;

const apiError = (error: unknown): InventoryApiError => typeof error === 'object' && error !== null ? error as InventoryApiError : {};
const formatQuantity = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

/** Справочник складов: запись только через backend (/inventory/warehouses) с аудитом. */
export const WarehousesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const viewAllowed = can('inventory.view');
  const manageAllowed = can('inventory.manage');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<WarehouseDto | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<WarehouseFormValues>();
  const retryActionId = useRef<string>();
  const retryKey = useRef<string>();

  const warehousesQuery = useQuery({
    queryKey: ['inventory', 'warehouses', 'reference', includeInactive],
    queryFn: () => inventoryApi.warehouses({ includeInactive }),
    enabled: viewAllowed,
  });
  const { data: workshopsList } = useList<{ workshop_id: number; workshop_name: string }>({
    resource: 'workshops',
    pagination: { mode: 'off' },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'workshop_name', order: 'asc' }],
    queryOptions: { enabled: manageAllowed },
  });
  const { data: employeesList } = useList<{ employee_id: number; full_name: string }>({
    resource: 'employees',
    pagination: { mode: 'off' },
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'full_name', order: 'asc' }],
    queryOptions: { enabled: manageAllowed },
  });
  const workshopOptions = useMemo(() => (workshopsList?.data ?? [])
    .map((row) => ({ value: Number(row.workshop_id), label: row.workshop_name })), [workshopsList?.data]);
  const employeeOptions = useMemo(() => (employeesList?.data ?? [])
    .map((row) => ({ value: Number(row.employee_id), label: row.full_name })), [employeesList?.data]);

  // Один Idempotency-Key на одно и то же действие: повтор после сбоя не создаёт второй склад.
  const runCommand = async (actionId: string, operation: (key: string) => Promise<unknown>, success: string) => {
    setBusy(true);
    if (retryActionId.current !== actionId) { retryActionId.current = actionId; retryKey.current = undefined; }
    retryKey.current ??= createInventoryIdempotencyKey();
    try {
      await operation(retryKey.current);
      retryKey.current = undefined;
      retryActionId.current = undefined;
      message.success(success);
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
      return true;
    } catch (error) {
      message.error(apiError(error).message ?? 'Не удалось сохранить. Повторите — повтор безопасен.');
      return false;
    } finally { setBusy(false); }
  };

  const openEditor = (warehouse: WarehouseDto | 'new') => {
    setEditing(warehouse);
    form.setFieldsValue(warehouse === 'new'
      ? { name: '', workshopId: null, responsibleEmployeeId: null }
      : { name: warehouse.name, workshopId: warehouse.workshopId, responsibleEmployeeId: warehouse.responsibleEmployeeId });
  };

  const submit = async () => {
    const values = await form.validateFields();
    if (editing === 'new') {
      const body = { name: values.name.trim(), workshopId: values.workshopId ?? null, responsibleEmployeeId: values.responsibleEmployeeId ?? null };
      if (await runCommand(`create:${JSON.stringify(body)}`, (key) => inventoryApi.createWarehouse(body, key), 'Склад добавлен')) setEditing(null);
      return;
    }
    if (!editing) return;
    const patch = warehousePatch(editing, values);
    if (!patch) { setEditing(null); return; }
    if (await runCommand(`update:${editing.warehouseId}:${JSON.stringify(patch)}`, (key) => inventoryApi.updateWarehouse(editing.warehouseId, patch, key), 'Склад сохранён')) setEditing(null);
  };

  const toggleActive = (warehouse: WarehouseDto) => {
    const next = !warehouse.isActive;
    Modal.confirm({
      title: next ? `Включить склад «${warehouse.name}»?` : `Отключить склад «${warehouse.name}»?`,
      content: next ? 'Склад снова появится в выборе склада на экране остатков.' : 'Отключённый склад не показывается в выборе склада, новые документы на него создать нельзя.',
      okText: next ? 'Включить' : 'Отключить',
      cancelText: 'Отмена',
      onOk: () => runCommand(
        `active:${warehouse.warehouseId}:${warehouse.version}:${next}`,
        (key) => inventoryApi.updateWarehouse(warehouse.warehouseId, { version: warehouse.version, isActive: next }, key),
        next ? 'Склад включён' : 'Склад отключён',
      ),
    });
  };

  if (!viewAllowed) return <Card title="Справочник складов"><Text type="secondary">Нет права просмотра склада.</Text></Card>;

  const columns = [
    { title: 'Склад', dataIndex: 'name', render: (value: string, row: WarehouseDto) => <Space>{value}{!row.isActive && <Tag>Неактивен</Tag>}</Space> },
    { title: 'Цех', dataIndex: 'workshopName', render: (value: string | null) => value ?? '—' },
    { title: 'Ответственный', dataIndex: 'responsibleEmployeeName', render: (value: string | null) => value ?? '—' },
    { title: 'Плёнок с остатком', dataIndex: 'filmsWithStock', align: 'right' as const },
    { title: 'Остаток, пог. м', dataIndex: 'totalQuantity', align: 'right' as const, render: formatQuantity },
    { title: 'Черновики', dataIndex: 'draftDocuments', align: 'right' as const },
    { title: 'Ключ 1С', dataIndex: 'refKey1c', render: (value: string | null) => value ? <Tooltip title={value}><Text code>{value.slice(0, 8)}…</Text></Tooltip> : '—' },
    ...(manageAllowed ? [{
      title: 'Действия',
      render: (_: unknown, row: WarehouseDto) => {
        const block = row.isActive ? warehouseDeactivationBlock(row) : null;
        return <Space>
          <Button size="small" onClick={() => openEditor(row)}>Изменить</Button>
          <Tooltip title={block ?? undefined}>
            <Button size="small" danger={row.isActive} disabled={busy || block !== null} onClick={() => toggleActive(row)}>{row.isActive ? 'Отключить' : 'Включить'}</Button>
          </Tooltip>
        </Space>;
      },
    }] : []),
  ];

  return (
    <Card
      title="Справочник складов"
      extra={<Space>
        <Checkbox checked={includeInactive} onChange={(event) => setIncludeInactive(event.target.checked)}>Показывать неактивные</Checkbox>
        {manageAllowed && <Button type="primary" onClick={() => openEditor('new')}>Добавить склад</Button>}
      </Space>}
    >
      <Table
        rowKey="warehouseId"
        dataSource={warehousesQuery.data?.items ?? []}
        columns={columns}
        loading={warehousesQuery.isLoading}
        pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }}
      />
      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'Новый склад' : 'Склад'}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={busy}
        onOk={() => void submit()}
        onCancel={() => setEditing(null)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true, message: 'Укажите название' }, { max: 128, message: 'До 128 символов' }]}>
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item name="workshopId" label="Цех">
            <Select allowClear showSearch optionFilterProp="label" placeholder="Не указан" options={workshopOptions} />
          </Form.Item>
          <Form.Item name="responsibleEmployeeId" label="Ответственный">
            <Select allowClear showSearch optionFilterProp="label" placeholder="Не указан" options={employeeOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};
