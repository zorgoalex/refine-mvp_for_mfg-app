import React, { useMemo, useRef, useState } from 'react';
import { useList } from '@refinedev/core';
import { Alert, Button, Card, Checkbox, DatePicker, Form, Input, Modal, Select, Space, Tag, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Table, Tooltip } from '../../ui/tooltipDelay';
import { createInventoryIdempotencyKey, inventoryApi } from '../../api/inventoryApi';
import type { InventoryApiError, WarehouseDto } from '../../api/types/inventoryApi.types';
import { can } from '../../utils/permissions';
import { isOnecKey, onecStatusText, onecWarehouseOptions, syncSummary, warehouseDeactivationBlock, warehousePatch, type WarehouseFormValues } from './warehouses';
import { formatMoment, supportsOnecConsumption } from './onecConsumption';

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
  const [form] = Form.useForm<Omit<WarehouseFormValues, 'onecConsumptionSince'> & { onecSince?: Dayjs | null }>();
  const retryActionId = useRef<string>();
  const retryKey = useRef<string>();

  const warehousesQuery = useQuery({
    queryKey: ['inventory', 'warehouses', 'reference', includeInactive],
    queryFn: () => inventoryApi.warehouses({ includeInactive }),
    enabled: viewAllowed,
  });
  const onecQuery = useQuery({
    queryKey: ['inventory', 'warehouses', 'onec'],
    queryFn: () => inventoryApi.onecWarehouses(),
    enabled: manageAllowed,
  });
  const onecAvailable = onecQuery.data?.available === true;
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
      ? { name: '', refKey1c: null, workshopId: null, responsibleEmployeeId: null }
      : {
        name: warehouse.name, refKey1c: warehouse.refKey1c, workshopId: warehouse.workshopId, responsibleEmployeeId: warehouse.responsibleEmployeeId,
        onecSince: warehouse.onecConsumptionSince ? dayjs(warehouse.onecConsumptionSince) : null,
      });
  };

  const syncWithOnec = () => void runCommand('sync-onec', async (key) => {
    const result = await inventoryApi.syncWarehouses(key);
    message.info(syncSummary(result));
  }, 'Склады синхронизированы с 1С');

  const submit = async () => {
    const values = await form.validateFields();
    if (editing === 'new') {
      const body = { name: values.name.trim(), refKey1c: String(values.refKey1c).trim().toLowerCase(), workshopId: values.workshopId ?? null, responsibleEmployeeId: values.responsibleEmployeeId ?? null };
      if (await runCommand(`create:${JSON.stringify(body)}`, (key) => inventoryApi.createWarehouse(body, key), 'Склад добавлен')) setEditing(null);
      return;
    }
    if (!editing) return;
    const { onecSince, ...rest } = values;
    const patch = warehousePatch(editing, {
      ...rest,
      ...(supportsOnecConsumption(editing) ? { onecConsumptionSince: onecSince ? onecSince.toISOString() : null } : {}),
    });
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

  // Откат расхода 1С склада: применённое возвращается в 0 документами-дельтами, дата начала очищается.
  const compensate = (warehouse: WarehouseDto) => {
    Modal.confirm({
      title: `Откатить расход из 1С по складу «${warehouse.name}»?`,
      content: 'Все списания по документам 1С на этом складе вернутся в остатки, дата начала расхода очистится и новые документы 1С перестанут применяться. Записи отката останутся в журнале документов.',
      okText: 'Откатить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      // Ключ — на склад и его версию: повтор после сбоя продолжает тот же откат; после нового включения расхода — новый.
      onOk: () => runCommand(`compensate:${warehouse.warehouseId}:${warehouse.version}`, async (key) => {
        const result = await inventoryApi.compensateOnecConsumption(warehouse.warehouseId, key);
        message.info(`Откат расхода 1С: записано документов ${result.documents}${result.remaining !== 0 ? `, осталось применённого ${formatQuantity(result.remaining)} м — повторите откат` : ''}`);
      }, 'Расход из 1С по складу откачен'),
    });
  };

  const consumptionSupported = (warehousesQuery.data?.items ?? []).some(supportsOnecConsumption);

  if (!viewAllowed) return <Card title="Справочник складов"><Text type="secondary">Нет права просмотра склада.</Text></Card>;

  const columns = [
    { title: 'Склад', dataIndex: 'name', render: (value: string, row: WarehouseDto) => <Space>{value}{!row.isActive && <Tag>Неактивен</Tag>}</Space> },
    { title: 'Цех', dataIndex: 'workshopName', render: (value: string | null) => value ?? '—' },
    { title: 'Ответственный', dataIndex: 'responsibleEmployeeName', render: (value: string | null) => value ?? '—' },
    { title: 'Плёнок с остатком', dataIndex: 'filmsWithStock', align: 'right' as const },
    { title: 'Остаток, пог. м', dataIndex: 'totalQuantity', align: 'right' as const, render: formatQuantity },
    { title: 'Черновики', dataIndex: 'draftDocuments', align: 'right' as const },
    {
      title: 'Склад 1С',
      render: (_: unknown, row: WarehouseDto) => {
        const status = onecStatusText(row);
        const body = status.tone === 'ok' ? <Text>{status.text}</Text>
          : status.tone === 'muted' ? <Text code>{status.text.slice(0, 8)}…</Text>
            : <Tag color={status.tone === 'error' ? 'red' : 'orange'}>{status.text}</Tag>;
        return row.refKey1c ? <Tooltip title={`Ключ 1С: ${row.refKey1c}`}>{body}</Tooltip> : body;
      },
    },
    ...(consumptionSupported ? [{
      title: 'Расход из 1С с',
      dataIndex: 'onecConsumptionSince',
      render: (value: string | null | undefined) => value ? formatMoment(value) : <Text type="secondary">не ведётся</Text>,
    }] : []),
    ...(manageAllowed ? [{
      title: 'Действия',
      render: (_: unknown, row: WarehouseDto) => {
        const block = row.isActive ? warehouseDeactivationBlock(row) : null;
        return <Space>
          <Button size="small" onClick={() => openEditor(row)}>Изменить</Button>
          {supportsOnecConsumption(row) && <Button size="small" disabled={busy} onClick={() => compensate(row)}>Откатить расход 1С</Button>}
          <Tooltip title={block ?? undefined}>
            <Button size="small" danger={row.isActive} disabled={busy || block !== null} onClick={() => toggleActive(row)}>{row.isActive ? 'Отключить' : 'Включить'}</Button>
          </Tooltip>
        </Space>;
      },
    }] : []),
  ];

  return (
    <Card
      className="warehouses-page wb-list"
      title="Справочник складов"
      extra={<Space>
        <Checkbox checked={includeInactive} onChange={(event) => setIncludeInactive(event.target.checked)}>Показывать неактивные</Checkbox>
        {manageAllowed && onecAvailable && <Button disabled={busy} onClick={syncWithOnec}>Синхронизировать с 1С</Button>}
        {manageAllowed && <Button type="primary" onClick={() => openEditor('new')}>Добавить склад</Button>}
      </Space>}
    >
      {(warehousesQuery.data?.items ?? []).some((row) => row.onecStatus === 'unlinked') && (
        <Alert style={{ marginBottom: 12 }} type="error" showIcon message="Есть склады без привязки к складу 1С — документы 1С не смогут на них сослаться. Откройте «Изменить» и выберите склад 1С." />
      )}
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
          <Form.Item
            name="refKey1c"
            label="Склад 1С"
            rules={[
              { required: true, message: 'Выберите склад 1С' },
              ...(onecAvailable ? [] : [{ validator: (_: unknown, value: string) => (isOnecKey(value) ? Promise.resolve() : Promise.reject(new Error('Ключ 1С — GUID вида xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'))) }]),
            ]}
            extra={onecAvailable ? undefined : 'Данные 1С недоступны — укажите ключ склада 1С (Ref_Key) вручную.'}
          >
            {onecAvailable
              ? <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="Выберите склад 1С"
                  options={onecWarehouseOptions(onecQuery.data?.items ?? [], editing && editing !== 'new' ? editing.warehouseId : null)}
                  onChange={(_value: string, option) => {
                    const picked = Array.isArray(option) ? undefined : (option as { name?: string } | undefined);
                    if (editing === 'new' && picked?.name && !form.getFieldValue('name')) form.setFieldsValue({ name: picked.name });
                  }}
                />
              : <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />}
          </Form.Item>
          <Form.Item name="workshopId" label="Цех">
            <Select allowClear showSearch optionFilterProp="label" placeholder="Не указан" options={workshopOptions} />
          </Form.Item>
          <Form.Item name="responsibleEmployeeId" label="Ответственный">
            <Select allowClear showSearch optionFilterProp="label" placeholder="Не указан" options={employeeOptions} />
          </Form.Item>
          {editing !== null && editing !== 'new' && supportsOnecConsumption(editing) && (
            <Form.Item
              name="onecSince"
              label="Расход из 1С с"
              extra="Документы 1С (реализация, возврат поставщику, списание, перемещение) после этого момента уменьшают остатки склада. Обычно — момент подсчёта последней инвентаризации. Пусто — расход из 1С не ведётся."
            >
              <DatePicker showTime={{ format: 'HH:mm' }} format="DD.MM.YYYY HH:mm" placeholder="Не ведётся" style={{ width: 220 }} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  );
};
