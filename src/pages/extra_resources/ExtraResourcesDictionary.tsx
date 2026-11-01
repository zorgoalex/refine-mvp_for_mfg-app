import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, InputNumber, Select, Space, Switch, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useList } from '@refinedev/core';
import { Table } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import {
  productionTechSettingsApi,
  type ExtraResourceDto,
  type UpsertExtraResourceRequest,
} from '../../api/productionTechSettingsApi';
import { can } from '../../utils/permissions';
import { SuppliersSelect } from '../../components/materialSuppliers/SuppliersSelect';

interface UnitOption {
  unit_id: number;
  unit_code: string;
  unit_name?: string | null;
  unit_symbol?: string | null;
  sort_order?: number | null;
}

interface ExtraResourceDraft {
  clientKey: string;
  id?: number;
  version?: number;
  resourceKind: string;
  resourceRefType: string | null;
  resourceRefId: number | null;
  resourceName: string;
  unitId: number | null;
  accountingMethod: string;
  defaultParameterName: string;
  defaultParameterMm: number | null;
  hdfAutoDefault: boolean;
  comment: string;
  isActive: boolean;
  sortOrder: number;
  vendorId: number | null;
  supplierIds: number[];
}

const RESOURCE_KIND_OPTIONS = [
  { label: 'Листовой материал', value: 'sheet_material' },
  { label: 'Шпон', value: 'veneer' },
  { label: 'Краска', value: 'paint' },
  { label: 'Замазка', value: 'putty' },
  { label: 'Другое', value: 'other' },
];

export function ExtraResourcesDictionary() {
  const canManage = can('settings.manage');
  const canView = can('settings.view') || canManage;
  const canViewUnits = can('references.view') || canManage;
  const [resources, setResources] = useState<ExtraResourceDto[]>([]);
  const [drafts, setDrafts] = useState<ExtraResourceDraft[]>([]);
  const [loading, setLoading] = useState(canView);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // Производитель и поставщики — только если backend их отдаёт (migr 280): старый backend отклонил бы эти поля.
  const supportsSuppliers = resources.some((resource) => Array.isArray(resource.suppliers));

  const load = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await productionTechSettingsApi.getExtraResources();
      setResources(next);
      setDrafts(next.map(resourceDtoToDraft));
    } catch (error) {
      message.error(apiErrorMessage(error, 'Не удалось загрузить доп. ресурсы'));
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    void load();
  }, [load]);

  const { data: unitsData, isLoading: unitsLoading } = useList<UnitOption>({
    resource: 'units',
    pagination: { mode: 'off' },
    sorters: [
      { field: 'sort_order', order: 'asc' },
      { field: 'unit_name', order: 'asc' },
      { field: 'unit_id', order: 'asc' },
    ],
    meta: { fields: ['unit_id', 'unit_code', 'unit_name', 'unit_symbol', 'sort_order'] },
    queryOptions: { enabled: canViewUnits },
  });

  const { data: vendorsData } = useList<{ vendor_id: number; vendor_name: string }>({
    resource: 'vendors',
    pagination: { mode: 'off' },
    sorters: [{ field: 'vendor_name', order: 'asc' }],
    meta: { fields: ['vendor_id', 'vendor_name'] },
    queryOptions: { enabled: canViewUnits && supportsSuppliers },
  });
  const vendorOptions = useMemo(
    () => (vendorsData?.data ?? []).map((vendor) => ({ label: vendor.vendor_name, value: vendor.vendor_id })),
    [vendorsData?.data],
  );

  const unitOptions = useMemo(
    () => (unitsData?.data ?? []).map((item) => ({
      label: item.unit_symbol || item.unit_name || item.unit_code,
      value: item.unit_id,
    })),
    [unitsData?.data],
  );

  const updateDraft = (clientKey: string, patch: Partial<ExtraResourceDraft>) => {
    setDrafts((current) => current.map((draft) => (
      draft.clientKey === clientKey ? { ...draft, ...patch } : draft
    )));
  };

  const addDraft = () => {
    const maxSortOrder = Math.max(90, ...drafts.map((draft) => draft.sortOrder));
    setDrafts((current) => [...current, createEmptyDraft(maxSortOrder + 10)]);
  };

  const saveDraft = async (draft: ExtraResourceDraft) => {
    const normalized = normalizeDraft(draft, supportsSuppliers);
    if (normalized.error) {
      message.error(normalized.error);
      return;
    }
    setSavingKey(draft.clientKey);
    try {
      if (draft.id) {
        await productionTechSettingsApi.updateExtraResource(draft.id, {
          ...normalized.resource,
          version: draft.version,
        });
      } else {
        await productionTechSettingsApi.createExtraResource(normalized.resource);
      }
      await load();
      message.success('Доп. ресурс сохранен');
    } catch (error) {
      message.error(apiErrorMessage(error, 'Не удалось сохранить доп. ресурс'));
    } finally {
      setSavingKey(null);
    }
  };

  const columns: ColumnsType<ExtraResourceDraft> = [
    {
      title: 'Тип',
      dataIndex: 'resourceKind',
      width: 150,
      render: (_: unknown, row) => (
        <Select
          size="small"
          options={RESOURCE_KIND_OPTIONS}
          value={row.resourceKind}
          disabled={!canManage}
          style={{ width: '100%' }}
          onChange={(value) => updateDraft(row.clientKey, { resourceKind: value })}
        />
      ),
    },
    {
      title: 'Доп. ресурс',
      dataIndex: 'resourceName',
      width: 220,
      render: (_: unknown, row) => (
        <Input
          size="small"
          value={row.resourceName}
          disabled={!canManage}
          onChange={(event) => updateDraft(row.clientKey, { resourceName: event.target.value })}
        />
      ),
    },
    {
      title: 'Ед.',
      dataIndex: 'unitId',
      width: 110,
      render: (_: unknown, row) => (
        <Select
          allowClear
          size="small"
          options={unitOptions}
          value={row.unitId ?? undefined}
          disabled={!canManage || !canViewUnits}
          loading={unitsLoading}
          style={{ width: '100%' }}
          onChange={(value) => updateDraft(row.clientKey, { unitId: value ?? null })}
        />
      ),
    },
    ...(supportsSuppliers ? [
      {
        title: 'Производитель',
        dataIndex: 'vendorId',
        width: 160,
        render: (_: unknown, row: ExtraResourceDraft) => (
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            size="small"
            options={vendorOptions}
            value={row.vendorId ?? undefined}
            disabled={!canManage || !canViewUnits}
            style={{ width: '100%' }}
            onChange={(value) => updateDraft(row.clientKey, { vendorId: value ?? null })}
          />
        ),
      },
      {
        title: 'Поставщики',
        dataIndex: 'supplierIds',
        width: 240,
        render: (_: unknown, row: ExtraResourceDraft) => (
          <SuppliersSelect
            value={row.supplierIds}
            disabled={!canManage || !canViewUnits}
            placeholder="Первый — основной"
            onChange={(value) => updateDraft(row.clientKey, { supplierIds: value })}
          />
        ),
      },
    ] : []),
    {
      title: 'Метод учета',
      dataIndex: 'accountingMethod',
      width: 220,
      render: (_: unknown, row) => (
        <Input
          size="small"
          value={row.accountingMethod}
          disabled={!canManage}
          onChange={(event) => updateDraft(row.clientKey, { accountingMethod: event.target.value })}
        />
      ),
    },
    {
      title: 'Параметр',
      dataIndex: 'defaultParameterName',
      width: 150,
      render: (_: unknown, row) => (
        <Input
          size="small"
          value={row.defaultParameterName}
          disabled={!canManage}
          onChange={(event) => updateDraft(row.clientKey, { defaultParameterName: event.target.value })}
        />
      ),
    },
    {
      title: 'мм',
      dataIndex: 'defaultParameterMm',
      width: 100,
      render: (_: unknown, row) => (
        <InputNumber
          size="small"
          min={0.1}
          step={0.5}
          precision={1}
          value={row.defaultParameterMm}
          disabled={!canManage}
          style={{ width: '100%' }}
          onChange={(value) => updateDraft(row.clientKey, { defaultParameterMm: value == null ? null : Number(value) })}
        />
      ),
    },
    {
      title: 'Авто ХДФ',
      dataIndex: 'hdfAutoDefault',
      width: 105,
      render: (_: unknown, row) => (
        <Switch
          size="small"
          checked={row.hdfAutoDefault}
          disabled={!canManage}
          onChange={(checked) => updateDraft(row.clientKey, { hdfAutoDefault: checked })}
        />
      ),
    },
    {
      title: 'Активно',
      dataIndex: 'isActive',
      width: 100,
      render: (_: unknown, row) => (
        <Switch
          size="small"
          checked={row.isActive}
          disabled={!canManage}
          onChange={(checked) => updateDraft(row.clientKey, { isActive: checked })}
        />
      ),
    },
    {
      title: 'Комментарий',
      dataIndex: 'comment',
      width: 220,
      render: (_: unknown, row) => (
        <Input
          size="small"
          value={row.comment}
          disabled={!canManage}
          onChange={(event) => updateDraft(row.clientKey, { comment: event.target.value })}
        />
      ),
    },
    {
      title: '',
      width: 110,
      render: (_: unknown, row) => (
        <Button
          size="small"
          type="primary"
          disabled={!canManage || !isChanged(row, resources, supportsSuppliers)}
          loading={savingKey === row.clientKey}
          onClick={() => void saveDraft(row)}
        >
          Сохранить
        </Button>
      ),
    },
  ];

  if (!canView) {
    return <Alert type="info" showIcon message="Нет доступа к справочнику доп. ресурсов" />;
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Button disabled={!canManage} onClick={addDraft}>Добавить ресурс</Button>
      <Table<ExtraResourceDraft>
        rowKey="clientKey"
        loading={loading}
        dataSource={drafts}
        columns={columns}
        pagination={false}
        size="small"
        scroll={{ x: supportsSuppliers ? 1820 : 1420 }}
      />
    </Space>
  );
}

function resourceDtoToDraft(resource: ExtraResourceDto): ExtraResourceDraft {
  return {
    clientKey: `id:${resource.id}`,
    id: resource.id,
    version: resource.version,
    resourceKind: resource.resourceKind,
    resourceRefType: resource.resourceRefType,
    resourceRefId: resource.resourceRefId,
    resourceName: resource.resourceName,
    unitId: resource.unitId,
    accountingMethod: resource.accountingMethod,
    defaultParameterName: resource.defaultParameterName,
    defaultParameterMm: resource.defaultParameterMm,
    hdfAutoDefault: resource.hdfAutoDefault,
    comment: resource.comment,
    isActive: resource.isActive,
    sortOrder: resource.sortOrder,
    vendorId: resource.vendorId ?? null,
    supplierIds: (resource.suppliers ?? []).map((supplier) => supplier.id),
  };
}

function createEmptyDraft(sortOrder: number): ExtraResourceDraft {
  return {
    clientKey: `new:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    resourceKind: 'other',
    resourceRefType: null,
    resourceRefId: null,
    resourceName: '',
    unitId: null,
    accountingMethod: '',
    defaultParameterName: '',
    defaultParameterMm: null,
    hdfAutoDefault: false,
    comment: '',
    isActive: true,
    sortOrder,
    vendorId: null,
    supplierIds: [],
  };
}

function normalizeDraft(draft: ExtraResourceDraft, withSuppliers: boolean): { resource: UpsertExtraResourceRequest; error?: string } {
  const resourceName = textOrEmpty(draft.resourceName);
  if (!resourceName) return { resource: draftToRequest(draft), error: 'Укажите название доп. ресурса' };
  const resourceKind = textOrEmpty(draft.resourceKind);
  if (!resourceKind) return { resource: draftToRequest(draft), error: 'Укажите тип ресурса' };
  const defaultParameterMm = draft.defaultParameterMm == null ? null : Number(draft.defaultParameterMm);
  if (defaultParameterMm !== null && (!Number.isFinite(defaultParameterMm) || defaultParameterMm <= 0)) {
    return { resource: draftToRequest(draft), error: 'Параметр должен быть больше 0' };
  }
  return {
    resource: {
      resourceKind,
      resourceRefType: draft.resourceRefType,
      resourceRefId: draft.resourceRefId,
      resourceName,
      unitId: draft.unitId,
      accountingMethod: textOrEmpty(draft.accountingMethod),
      defaultParameterName: textOrEmpty(draft.defaultParameterName),
      defaultParameterMm,
      hdfAutoDefault: draft.hdfAutoDefault,
      comment: textOrEmpty(draft.comment),
      isActive: draft.isActive,
      sortOrder: draft.sortOrder,
      ...(withSuppliers ? { vendorId: draft.vendorId, supplierIds: draft.supplierIds } : {}),
    },
  };
}

function draftToRequest(draft: ExtraResourceDraft): UpsertExtraResourceRequest {
  return {
    resourceKind: textOrEmpty(draft.resourceKind),
    resourceName: textOrEmpty(draft.resourceName),
    isActive: draft.isActive,
  };
}

function isChanged(row: ExtraResourceDraft, resources: ExtraResourceDto[], withSuppliers: boolean): boolean {
  if (!row.id) return Boolean(textOrEmpty(row.resourceName));
  const original = resources.find((resource) => resource.id === row.id);
  if (!original) return true;
  return JSON.stringify(compareDraft(row, withSuppliers)) !== JSON.stringify(compareDraft(resourceDtoToDraft(original), withSuppliers));
}

function compareDraft(draft: ExtraResourceDraft, withSuppliers: boolean) {
  return {
    ...(withSuppliers ? { vendorId: draft.vendorId ?? null, supplierIds: draft.supplierIds } : {}),
    resourceKind: textOrEmpty(draft.resourceKind),
    resourceRefType: draft.resourceRefType ?? null,
    resourceRefId: draft.resourceRefId ?? null,
    resourceName: textOrEmpty(draft.resourceName),
    unitId: draft.unitId ?? null,
    accountingMethod: textOrEmpty(draft.accountingMethod),
    defaultParameterName: textOrEmpty(draft.defaultParameterName),
    defaultParameterMm: draft.defaultParameterMm ?? null,
    hdfAutoDefault: draft.hdfAutoDefault,
    comment: textOrEmpty(draft.comment),
    isActive: draft.isActive,
    sortOrder: draft.sortOrder,
  };
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return `${error.message}. Обновите данные и повторите сохранение.`;
    return error.message;
  }
  return fallback;
}
