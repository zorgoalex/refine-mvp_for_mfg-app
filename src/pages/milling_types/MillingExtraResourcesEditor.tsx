import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, InputNumber, Select, Space, Switch, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useList } from '@refinedev/core';
import { Table } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import {
  productionTechSettingsApi,
  type HdfMillingSettingsDto,
  type HdfProductionTechSettingsDto,
  type MillingExtraResourceDto,
  type UpdateMillingExtraResourceRequest,
} from '../../api/productionTechSettingsApi';
import { can } from '../../utils/permissions';

const { Text } = Typography;

interface UnitOption {
  unit_id: number;
  unit_code: string;
  unit_name?: string | null;
  unit_symbol?: string | null;
  sort_order?: number | null;
}

interface MillingResourceDraft {
  clientKey: string;
  id?: number;
  version?: number;
  resourceKind: string;
  resourceRefType: string | null;
  resourceRefId: number | null;
  resourceName: string;
  unitId: number | null;
  accountingMethod: string;
  parameterName: string;
  parameterMm: number | null;
  hdfAutoEnabled: boolean;
  comment: string;
  isActive: boolean;
  sortOrder: number;
}

interface MillingDraft {
  extraResources: MillingResourceDraft[];
}

interface MillingExtraResourcesEditorProps {
  millingTypeId?: number | null;
  showMillingColumn?: boolean;
  readOnly?: boolean;
}

const RESOURCE_KIND_OPTIONS = [
  { label: 'Листовой материал', value: 'sheet_material' },
  { label: 'Шпон', value: 'veneer' },
  { label: 'Краска', value: 'paint' },
  { label: 'Замазка', value: 'putty' },
  { label: 'Другое', value: 'other' },
];

const DEFAULT_HDF_PARAMETER_NAME = 'Параметр';
const DEFAULT_HDF_ACCOUNTING_METHOD = 'Автоматический расчет ХДФ-детали';

export function MillingExtraResourcesEditor({
  millingTypeId,
  showMillingColumn = true,
  readOnly = false,
}: MillingExtraResourcesEditorProps) {
  const canManage = !readOnly && can('settings.manage');
  const canView = can('settings.view') || can('settings.manage');
  const canViewUnits = can('references.view') || canManage;
  const [settings, setSettings] = useState<HdfProductionTechSettingsDto | null>(null);
  const [millingDrafts, setMillingDrafts] = useState<Record<number, MillingDraft>>({});
  const [loading, setLoading] = useState(true);
  const [savingMillingId, setSavingMillingId] = useState<number | null>(null);

  const loadSettings = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await productionTechSettingsApi.getHdf();
      setSettings(next);
      setMillingDrafts(Object.fromEntries(next.millingTypes.map((milling) => [
        milling.millingTypeId,
        makeMillingDraft(milling),
      ])));
    } catch (error) {
      message.error(apiErrorMessage(error, 'Не удалось загрузить доп. ресурсы фрезеровок'));
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

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

  const unitOptions = useMemo(
    () => (unitsData?.data ?? []).map((item) => ({
      label: item.unit_symbol || item.unit_name || item.unit_code,
      value: item.unit_id,
    })),
    [unitsData?.data],
  );

  const rows = useMemo(() => {
    const allRows = settings?.millingTypes ?? [];
    if (!millingTypeId) return allRows;
    return allRows.filter((row) => row.millingTypeId === millingTypeId);
  }, [millingTypeId, settings?.millingTypes]);

  const updateResourceDraft = (
    rowMillingTypeId: number,
    clientKey: string,
    patch: Partial<MillingResourceDraft>,
  ) => {
    setMillingDrafts((current) => {
      const currentDraft = current[rowMillingTypeId] ?? { extraResources: [] };
      const nextResources = currentDraft.extraResources.map((resource) => {
        if (resource.clientKey !== clientKey) {
          return patch.hdfAutoEnabled === true ? { ...resource, hdfAutoEnabled: false } : resource;
        }
        const next = { ...resource, ...patch };
        if (patch.hdfAutoEnabled === true) {
          return {
            ...next,
            resourceKind: next.resourceKind || 'sheet_material',
            resourceName: next.resourceName || 'ХДФ',
            accountingMethod: next.accountingMethod || DEFAULT_HDF_ACCOUNTING_METHOD,
            parameterName: next.parameterName || DEFAULT_HDF_PARAMETER_NAME,
            isActive: true,
          };
        }
        return next;
      });
      return { ...current, [rowMillingTypeId]: { extraResources: nextResources } };
    });
  };

  const addResourceDraft = (rowMillingTypeId: number) => {
    setMillingDrafts((current) => {
      const currentDraft = current[rowMillingTypeId] ?? { extraResources: [] };
      const maxSortOrder = Math.max(90, ...currentDraft.extraResources.map((resource) => resource.sortOrder));
      return {
        ...current,
        [rowMillingTypeId]: {
          extraResources: [
            ...currentDraft.extraResources,
            createEmptyResourceDraft(rowMillingTypeId, maxSortOrder + 10),
          ],
        },
      };
    });
  };

  const removeResourceDraft = (rowMillingTypeId: number, clientKey: string) => {
    setMillingDrafts((current) => {
      const currentDraft = current[rowMillingTypeId] ?? { extraResources: [] };
      return {
        ...current,
        [rowMillingTypeId]: {
          extraResources: currentDraft.extraResources
            .map((resource) => (resource.clientKey === clientKey && resource.id ? { ...resource, isActive: false } : resource))
            .filter((resource) => resource.clientKey !== clientKey || resource.id),
        },
      };
    });
  };

  const handleSaveMilling = async (row: HdfMillingSettingsDto) => {
    const draft = millingDrafts[row.millingTypeId];
    if (!draft) return;
    const normalized = normalizeDraftResources(draft.extraResources);
    if (normalized.error) {
      message.error(normalized.error);
      return;
    }
    const resources = normalized.resources;
    const hdfResource = resources.find((resource) => resource.isActive !== false && resource.hdfAutoEnabled === true) ?? null;
    if (hdfResource && (hdfResource.parameterMm == null || hdfResource.parameterMm <= 0)) {
      message.error('Для авто ХДФ укажите параметр больше 0');
      return;
    }
    setSavingMillingId(row.millingTypeId);
    try {
      await productionTechSettingsApi.updateHdfMilling(row.millingTypeId, {
        hdfEnabled: hdfResource !== null,
        hdfEdgeMm: hdfResource?.parameterMm ?? null,
        hdfParameterName: hdfResource?.parameterName ?? null,
        extraResources: resources,
        expectedVersion: row.version,
      });
      await loadSettings();
      message.success('Доп. ресурсы сохранены');
    } catch (error) {
      message.error(apiErrorMessage(error, 'Не удалось сохранить доп. ресурсы'));
    } finally {
      setSavingMillingId(null);
    }
  };

  const renderResourcesEditor = (row: HdfMillingSettingsDto) => {
    const draft = millingDrafts[row.millingTypeId] ?? makeMillingDraft(row);
    return (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {draft.extraResources.length === 0 ? (
          <Text type="secondary">Доп. ресурсы не заданы</Text>
        ) : null}
        {draft.extraResources.map((resource) => (
          <div
            key={resource.clientKey}
            style={{
              display: 'grid',
              gridTemplateColumns: '150px minmax(170px, 1fr) 110px minmax(180px, 1fr) 150px 110px 104px 104px 84px',
              gap: 8,
              alignItems: 'center',
              padding: '8px 0',
              borderBottom: '1px solid #f0f0f0',
            }}
          >
            <Select
              size="small"
              options={RESOURCE_KIND_OPTIONS}
              value={resource.resourceKind}
              disabled={!canManage}
              onChange={(value) => updateResourceDraft(row.millingTypeId, resource.clientKey, { resourceKind: value })}
            />
            <Input
              size="small"
              placeholder="Ресурс / название"
              value={resource.resourceName}
              disabled={!canManage}
              onChange={(event) => updateResourceDraft(row.millingTypeId, resource.clientKey, { resourceName: event.target.value })}
            />
            <Select
              allowClear
              size="small"
              placeholder="Ед."
              options={unitOptions}
              value={resource.unitId ?? undefined}
              disabled={!canManage || !canViewUnits}
              loading={unitsLoading}
              onChange={(value) => updateResourceDraft(row.millingTypeId, resource.clientKey, { unitId: value ?? null })}
            />
            <Input
              size="small"
              placeholder="Метод учета"
              value={resource.accountingMethod}
              disabled={!canManage}
              onChange={(event) => updateResourceDraft(row.millingTypeId, resource.clientKey, { accountingMethod: event.target.value })}
            />
            <Input
              size="small"
              placeholder="Название параметра"
              value={resource.parameterName}
              disabled={!canManage}
              onChange={(event) => updateResourceDraft(row.millingTypeId, resource.clientKey, { parameterName: event.target.value })}
            />
            <InputNumber
              size="small"
              min={0.1}
              step={0.5}
              precision={1}
              placeholder="Парам., мм"
              value={resource.parameterMm}
              disabled={!canManage}
              style={{ width: '100%' }}
              onChange={(value) => updateResourceDraft(row.millingTypeId, resource.clientKey, { parameterMm: value == null ? null : Number(value) })}
            />
            <Space size={6}>
              <Switch
                size="small"
                checked={resource.hdfAutoEnabled}
                disabled={!canManage}
                onChange={(checked) => updateResourceDraft(row.millingTypeId, resource.clientKey, { hdfAutoEnabled: checked })}
              />
              <Text>Авто ХДФ</Text>
            </Space>
            <Space size={6}>
              <Switch
                size="small"
                checked={resource.isActive}
                disabled={!canManage}
                onChange={(checked) => updateResourceDraft(row.millingTypeId, resource.clientKey, { isActive: checked })}
              />
              <Text>Активно</Text>
            </Space>
            <Button
              size="small"
              disabled={!canManage}
              onClick={() => removeResourceDraft(row.millingTypeId, resource.clientKey)}
            >
              Убрать
            </Button>
            <Input
              size="small"
              placeholder="Комментарий"
              value={resource.comment}
              disabled={!canManage}
              style={{ gridColumn: '1 / -1' }}
              onChange={(event) => updateResourceDraft(row.millingTypeId, resource.clientKey, { comment: event.target.value })}
            />
          </div>
        ))}
        <Button size="small" disabled={!canManage} onClick={() => addResourceDraft(row.millingTypeId)}>
          Добавить ресурс
        </Button>
      </Space>
    );
  };

  const columns: ColumnsType<HdfMillingSettingsDto> = [
    ...(showMillingColumn ? [{
      title: 'Фрезеровка',
      dataIndex: 'name',
      key: 'name',
      width: 240,
      render: (value: string, row: HdfMillingSettingsDto) => (
        <Space direction="vertical" size={4}>
          <Text>{value}</Text>
          <Space size={6} wrap>
            {row.isActive ? null : <Tag>Неактивна</Tag>}
            {row.hdfEnabled ? <Tag color="blue">ХДФ {row.hdfEdgeMm ?? '—'} мм</Tag> : null}
          </Space>
        </Space>
      ),
    }] : []),
    {
      title: 'Доп. ресурсы',
      key: 'extraResources',
      render: (_: unknown, row: HdfMillingSettingsDto) => renderResourcesEditor(row),
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_: unknown, row: HdfMillingSettingsDto) => (
        <Button
          size="small"
          type="primary"
          disabled={!canManage || !isMillingChanged(row, millingDrafts[row.millingTypeId])}
          loading={savingMillingId === row.millingTypeId}
          onClick={() => void handleSaveMilling(row)}
        >
          Сохранить
        </Button>
      ),
    },
  ];

  if (!canView) return null;

  if (!loading && millingTypeId && rows.length === 0) {
    return <Alert type="warning" showIcon message="Тип фрезеровки не найден в настройках доп. ресурсов" />;
  }

  return (
    <Table<HdfMillingSettingsDto>
      rowKey="millingTypeId"
      loading={loading}
      dataSource={rows}
      columns={columns}
      pagination={showMillingColumn ? false : { pageSize: 1, hideOnSinglePage: true }}
      size="small"
      scroll={{ x: showMillingColumn ? 1280 : 1040 }}
    />
  );
}

function makeMillingDraft(row: HdfMillingSettingsDto): MillingDraft {
  const resources = row.extraResources?.length
    ? row.extraResources.map(resourceDtoToDraft)
    : row.hdfEnabled
      ? [createLegacyHdfResourceDraft(row)]
      : [];
  return { extraResources: resources };
}

function resourceDtoToDraft(resource: MillingExtraResourceDto): MillingResourceDraft {
  return {
    clientKey: `id:${resource.id}`,
    id: resource.id,
    version: resource.version,
    resourceKind: resource.resourceKind || 'other',
    resourceRefType: resource.resourceRefType,
    resourceRefId: resource.resourceRefId,
    resourceName: resource.resourceName,
    unitId: resource.unitId,
    accountingMethod: resource.accountingMethod,
    parameterName: resource.parameterName,
    parameterMm: resource.parameterMm,
    hdfAutoEnabled: resource.hdfAutoEnabled,
    comment: resource.comment,
    isActive: resource.isActive,
    sortOrder: resource.sortOrder,
  };
}

function createLegacyHdfResourceDraft(row: HdfMillingSettingsDto): MillingResourceDraft {
  return {
    clientKey: `legacy-hdf:${row.millingTypeId}`,
    resourceKind: 'sheet_material',
    resourceRefType: null,
    resourceRefId: null,
    resourceName: 'ХДФ',
    unitId: null,
    accountingMethod: DEFAULT_HDF_ACCOUNTING_METHOD,
    parameterName: row.hdfParameterName || DEFAULT_HDF_PARAMETER_NAME,
    parameterMm: row.hdfEdgeMm,
    hdfAutoEnabled: true,
    comment: '',
    isActive: true,
    sortOrder: 100,
  };
}

function createEmptyResourceDraft(millingTypeId: number, sortOrder: number): MillingResourceDraft {
  return {
    clientKey: `new:${millingTypeId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    resourceKind: 'other',
    resourceRefType: null,
    resourceRefId: null,
    resourceName: '',
    unitId: null,
    accountingMethod: '',
    parameterName: '',
    parameterMm: null,
    hdfAutoEnabled: false,
    comment: '',
    isActive: true,
    sortOrder,
  };
}

function normalizeDraftResources(resources: MillingResourceDraft[]): { resources: UpdateMillingExtraResourceRequest[]; error?: string } {
  const normalized: UpdateMillingExtraResourceRequest[] = [];
  for (const [index, resource] of resources.entries()) {
    const resourceName = textOrEmpty(resource.resourceName);
    const hasContent = Boolean(resource.id || resourceName || resource.hdfAutoEnabled || resource.accountingMethod || resource.parameterName || resource.comment);
    if (!hasContent) continue;
    const resourceKind = textOrEmpty(resource.resourceKind);
    if (!resourceKind) return { resources: [], error: `Ресурс ${index + 1}: укажите тип ресурса` };
    if (!resourceName) return { resources: [], error: `Ресурс ${index + 1}: укажите название` };
    const parameterMm = resource.parameterMm == null ? null : Number(resource.parameterMm);
    if (parameterMm !== null && (!Number.isFinite(parameterMm) || parameterMm <= 0)) {
      return { resources: [], error: `Ресурс ${index + 1}: параметр должен быть больше 0` };
    }
    if (resource.isActive !== false && resource.hdfAutoEnabled && parameterMm === null) {
      return { resources: [], error: `Ресурс ${index + 1}: для авто ХДФ укажите параметр` };
    }
    normalized.push({
      ...(resource.id ? { id: resource.id } : {}),
      ...(resource.version ? { version: resource.version } : {}),
      resourceKind,
      resourceRefType: resource.resourceRefType ?? null,
      resourceRefId: resource.resourceRefId ?? null,
      resourceName,
      unitId: resource.unitId ?? null,
      accountingMethod: textOrEmpty(resource.accountingMethod),
      parameterName: textOrEmpty(resource.parameterName),
      parameterMm,
      hdfAutoEnabled: resource.hdfAutoEnabled,
      comment: textOrEmpty(resource.comment),
      isActive: resource.isActive,
      sortOrder: Number.isFinite(resource.sortOrder) ? resource.sortOrder : 100 + index,
    });
  }
  return { resources: normalized };
}

function isMillingChanged(row: HdfMillingSettingsDto, draft: MillingDraft | undefined): boolean {
  if (!draft) return false;
  return JSON.stringify(compareDraft(draft)) !== JSON.stringify(compareDraft(makeMillingDraft(row)));
}

function compareDraft(draft: MillingDraft) {
  return draft.extraResources.map((resource, index) => ({
    id: resource.id ?? null,
    resourceKind: textOrEmpty(resource.resourceKind),
    resourceRefType: resource.resourceRefType ?? null,
    resourceRefId: resource.resourceRefId ?? null,
    resourceName: textOrEmpty(resource.resourceName),
    unitId: resource.unitId ?? null,
    accountingMethod: textOrEmpty(resource.accountingMethod),
    parameterName: textOrEmpty(resource.parameterName),
    parameterMm: resource.parameterMm ?? null,
    hdfAutoEnabled: resource.hdfAutoEnabled,
    comment: textOrEmpty(resource.comment),
    isActive: resource.isActive,
    sortOrder: Number.isFinite(resource.sortOrder) ? resource.sortOrder : 100 + index,
  }));
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
